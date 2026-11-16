import assert from "node:assert/strict";
import { run } from "../src/interpret.js";
import { SimHandler } from "../src/sim.js";
import { Journal, type JournalEntry } from "../src/journal.js";
import { bindPins, resolvePins, PinMismatch, type EffectCeilings } from "../src/pins.js";
import { runOnEngine } from "../src/engine/host.js";
import { runInWorker } from "../src/engine/worker.js";
import { transform } from "../src/transform/index.js";
import { emitSentinel } from "@cotal-ai/smoke-kit";

let checks = 0;
const ok = (name: string, test: boolean) => { assert.ok(test, name); checks++; console.log(`PASS ${name}`); };
const evaluate = (module: string) => (0, eval)(module);
const source = `
const agents = [];
for (let i = 0; i < 6; i++) { agents.push(await spawn("worker")); }
let refused = false;
try { await spawn("worker"); } catch (e) { refused = e.code === "L4029"; }
for (const agent of agents) { await turn(agent, { name: "work" }); }
log(refused);
`;
const supplied = { spawn: 6, turn: 9 };
const pins = resolvePins({ runId: "kind-pins", ceilings: supplied }, 0, "1");
supplied.spawn = 99;
ok("fresh pins copy and freeze the ceiling map", pins.ceilings?.spawn === 6 && Object.isFrozen(pins.ceilings));
assert.deepEqual(bindPins(pins, { runId: "kind-pins", ceilings: { turn: 9, spawn: 6 } }, "1"), pins);
ok("resume compares values independent of insertion order", true);
const loaded = { ...pins, ceilings: { spawn: 6 } };
const boundLoaded = bindPins(loaded, { runId: "kind-pins" }, "1");
loaded.ceilings.spawn = 100;
ok("loaded recorded maps are copied before authority is used", boundLoaded.ceilings?.spawn === 6 && Object.isFrozen(boundLoaded.ceilings));
assert.throws(() => bindPins(pins, { runId: "kind-pins", ceilings: { spawn: 7, turn: 9 } }, "1"), e => e instanceof PinMismatch && e.code === "L5009" && e.pin === "ceilings");
ok("changed per-kind authority refuses L5009", true);
const legacy = resolvePins({ runId: "legacy" }, 0, "1");
ok("legacy pins stay byte-shaped without a new field", !Object.hasOwn(legacy, "ceilings") && bindPins(legacy, { runId: "legacy" }, "1") === legacy);
for (const bad of [{ spawn: -1 }, { spawn: 0.5 }, { spawn: Infinity }, { spawn: undefined }, { unknown: 1 }, [], null, { get spawn() { throw new Error("must not invoke getter"); } }]) {
  assert.throws(() => resolvePins({ runId: "bad", ceilings: bad as EffectCeilings }, 0, "1"), TypeError);
}
ok("malformed maps, unknown kinds and accessors refuse before execution", true);

for (const version of ["1", "2"] as const) {
  const logs: unknown[][] = [];
  const options = { runId: `kinds-${version}`, handler: new SimHandler({ turns: { work: { status: "done" } } }), ceilings: { spawn: 6 }, effectCeiling: 50, onLog: (line: { values: readonly unknown[] }) => { logs.push([...line.values]); } };
  const result = version === "1" ? await run(source, options) : await runOnEngine(source, transform(source).module, { ...options, evaluate });
  ok(`engine${version}: seventh spawn is catchable L4029 and turns continue`, logs.at(-1)?.[0] === true);
  ok(`engine${version}: only six spawn entries and six turns are journalled`, result.journal.dispatchedEffects("spawn") === 6 && result.journal.dispatchedEffects("turn") === 6);
  const replayOptions = { ...options, handler: new SimHandler({ turns: { work: { status: "done" } } }), pins: result.pins, journal: new Journal({ run: options.runId, entries: result.journal.entries() }) };
  const replay = version === "1" ? await run(source, replayOptions) : await runOnEngine(source, transform(source).module, { ...replayOptions, evaluate });
  ok(`engine${version}: complete replay preserves per-kind totals`, replay.journal.dispatchedEffects("spawn") === 6 && replay.journal.dispatchedEffects("turn") === 6);

  const runId = `resume-kind-${version}`, entries: JournalEntry[] = [];
  const recorded = resolvePins({ runId, ceilings: { sleep: 2 } }, 0, version);
  const sleeps = 'await sleep("1m"); await sleep("1m"); await sleep("1m");';
  let stops = 0;
  const first = { runId, handler: new SimHandler({ turns: { work: { status: "done" } } }), pins: recorded, journal: new Journal({ run: runId, store: { append: async e => { entries.push(e); } } }), shouldStop: () => stops++ >= 1 ? "pause" : undefined };
  await assert.rejects(version === "1" ? run(sleeps, first) : runOnEngine(sleeps, transform(sleeps).module, { ...first, evaluate }), { name: "RunReleased" });
  const resumedJournal = new Journal({ run: runId, entries });
  const next = { runId, handler: new SimHandler({ turns: { work: { status: "done" } } }), pins: recorded, journal: resumedJournal };
  await assert.rejects(version === "1" ? run(sleeps, next) : runOnEngine(sleeps, transform(sleeps).module, { ...next, evaluate }), { code: "L4029" });
  ok(`engine${version}: resumed allowance is journal-derived, no activation reset`, resumedJournal.dispatchedEffects("sleep") === 2);

  const zero = { runId: `zero-${version}`, handler: new SimHandler({ turns: { work: { status: "done" } } }), ceilings: { spawn: 0 } };
  await assert.rejects(version === "1" ? run('await spawn("worker");', zero) : runOnEngine('await spawn("worker");', transform('await spawn("worker");').module, { ...zero, evaluate }), { code: "L4029" });
  ok(`engine${version}: zero refuses the first dispatch`, true);

  const oneSleep = 'await sleep("1m", { name: "one" });';
  const entryOptions = { runId: `pending-${version}`, handler: new SimHandler({}), ceilings: { sleep: 1 } };
  const initial = version === "1" ? await run(oneSleep, entryOptions) : await runOnEngine(oneSleep, transform(oneSleep).module, { ...entryOptions, evaluate });
  for (const state of ["pending", "refused"] as const) {
    const entry = initial.journal.entries()[0]!;
    const recoveredEntry: JournalEntry = state === "pending"
      ? { ...entry, state: "pending", status: undefined, result: undefined, endedAt: undefined }
      : { ...entry, state: "settled", status: "refused", result: undefined };
    const journal = new Journal({ run: entryOptions.runId, entries: [recoveredEntry] });
    const recovery = { ...entryOptions, pins: initial.pins, journal, handler: new SimHandler({}) };
    const recovered = version === "1" ? await run(oneSleep, recovery) : await runOnEngine(oneSleep, transform(oneSleep).module, { ...recovery, evaluate });
    ok(`engine${version}: ${state} reentry does not charge again`, recovered.journal.dispatchedEffects("sleep") === 1);
  }

  const concurrent = 'await parallel({ a: async () => { try { await spawn("worker"); } catch (e) {} }, b: async () => { try { await spawn("worker"); } catch (e) {} }, c: async () => { try { await spawn("worker"); } catch (e) {} } });';
  const concurrentOptions = { runId: `concurrent-${version}`, handler: new SimHandler({}), ceilings: { spawn: 1 } };
  const raced = version === "1" ? await run(concurrent, concurrentOptions) : await runOnEngine(concurrent, transform(concurrent).module, { ...concurrentOptions, evaluate });
  ok(`engine${version}: concurrent branches share one allowance`, raced.journal.dispatchedEffects("spawn") === 1);
  const scoped = 'const a = await spawn("worker"); await conclave([a], async (ch) => ch.channel, { name: "huddle" });';
  const scopeOptions = { runId: `scope-kind-${version}`, handler: new SimHandler({}), ceilings: { conclave: 0 } };
  const scopeJournal = new Journal({ run: scopeOptions.runId });
  await assert.rejects(version === "1" ? run(scoped, { ...scopeOptions, journal: scopeJournal }) : runOnEngine(scoped, transform(scoped).module, { ...scopeOptions, journal: scopeJournal, evaluate }), { code: "L4029" });
  ok(`engine${version}: dispatching scopes share the same kind fence`, scopeJournal.dispatchedEffects("conclave") === 0 && scopeJournal.dispatchedEffects("spawn") === 1);

  const total = { runId: `total-${version}`, handler: new SimHandler({}), ceilings: { sleep: 9 }, effectCeiling: 1 };
  const totalJournal = new Journal({ run: total.runId });
  await assert.rejects(version === "1" ? run(sleeps, { ...total, journal: totalJournal }) : runOnEngine(sleeps, transform(sleeps).module, { ...total, journal: totalJournal, evaluate }), { code: "L4009" });
  ok(`engine${version}: independent total ceiling still stops new work`, totalJournal.dispatchedEffects() === 1);
}
const workerRun = runInWorker({ source, module: transform(source).module, runId: "worker-kind", handler: "bridged", ceilings: { spawn: 6 } }, { entry: new URL("../dist/engine/worker-entry.js", import.meta.url), bridge: { handler: new SimHandler({ turns: { work: { status: "done" } } }), store: { append: async () => {} } } });
const worker = await workerRun.done;
ok("confined worker receives and enforces per-kind pins", worker.ok && worker.entries.filter(e => e.kind === "spawn").length === 6);
if (worker.ok) {
  const changedRun = runInWorker({ source, module: transform(source).module, runId: "worker-kind", handler: "bridged", pins: worker.pins, entries: worker.entries, ceilings: { spawn: 7 } }, { entry: new URL("../dist/engine/worker-entry.js", import.meta.url), bridge: { handler: new SimHandler({ turns: { work: { status: "done" } } }), store: { append: async () => {} } } });
  const changed = await changedRun.done;
  ok("worker resume does not drop conflicting loose ceiling override", !changed.ok && "code" in changed && changed.code === "L5009");
}
emitSentinel({ passed: checks, failed: 0 });
