/**
 * The fuel ceiling: what stops a loop that performs no effect at all.
 *
 * The effect ceiling (L4009) counts effects, so it is blind to `while (true) { n = n + 1 }` by
 * construction: that loop performs nothing, so nothing counts it. Two mechanisms cover it, and the
 * second is the one that matters.
 *
 * 1. A step budget, counted in walker dispatches, failing loud as L4013.
 * 2. A yield to the macrotask queue every N dispatches.
 *
 * Section 2 below is the reason this suite exists, and it tests a claim that is easy to state and
 * easy to fake. The walker is async all the way down, so a pure loop floods the MICROTASK queue and
 * starves the macrotask queue completely. A host watchdog's setTimeout never fires. That is not a
 * program burning a core, it is a program taking down the host that runs it, along with the timer
 * plane, the run lease, and every other run on that host. This was not reasoned out: it was found
 * by writing such a loop and watching the watchdog meant to stop it fail to fire, leaving a process
 * that had to be killed from outside.
 *
 * So the assertion "a host timer fires during a runaway" is worthless on its own. A timer also
 * fires if the run simply ends fast. Every test of the yield here is therefore a PAIR: the same
 * program, same budget, run once with yielding on and once with it effectively off. The claim is
 * the DIFFERENCE between them. A control that cannot fail cannot license the result beside it.
 */
import { run } from "../src/interpret.js";
import { RuntimeFault } from "../src/interpret.js";
import { SimHandler } from "../src/sim.js";
import { Journal, type JournalEntry, type JournalStore } from "../src/journal.js";
import { resolvePins } from "../src/pins.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ok ${name}`);
};

/** Never yield: one step past any budget these tests use, so the boundary is never crossed. */
const NEVER = Number.MAX_SAFE_INTEGER;

const RUNAWAY = `
let n = 0;
while (true) {
  n = n + 1;
}
`;

// ---- 1) the budget fires, and says which loop it means -----------------------------------------

{
  let caught: unknown;
  try {
    await run(RUNAWAY, {
      runId: "f-1",
      handler: new SimHandler({}),
      stepBudget: 5_000,
      yieldEvery: NEVER,
    });
  } catch (e) {
    caught = e;
  }
  ok("a loop performing no effect is stopped", caught instanceof RuntimeFault, String(caught));
  const fault = caught as RuntimeFault;
  ok("it is L4013, not the effect ceiling", fault.code === "L4013", fault.code);
  // Pinned on the distinguishing clause, not on the word "loop": L4009 says "loop" too, so a pin on
  // that word would pass against the wrong error. One site, counted rather than assumed.
  ok(
    "the message says why the effect ceiling could not see it",
    fault.message.includes("The effect ceiling cannot see such a loop"),
    fault.message.slice(0, 160),
  );
  ok("the message names the budget it hit", fault.message.includes("5000"), fault.message.slice(0, 120));
}

// A budget must also be reachable at the smallest scale, or "counted in dispatches" is decoration.
{
  let caught: unknown;
  try {
    await run(`let n = 1;\n`, { runId: "f-2", handler: new SimHandler({}), stepBudget: 1, yieldEvery: NEVER });
  } catch (e) {
    caught = e;
  }
  ok("the counter is live from the first dispatch", (caught as RuntimeFault)?.code === "L4013", String(caught));
}

// ---- 2) the yield: the host stays alive while a runaway runs ------------------------------------

/**
 * Run a program with a watchdog timer armed, and report whether the timer fired BEFORE the run
 * ended. The flag is read synchronously in the catch: a rejection propagates through microtasks
 * only, so no macrotask can sneak in between the throw and the read.
 */
const watchdogFiredDuring = async (yieldEvery: number): Promise<boolean> => {
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
  }, 5);
  try {
    await run(RUNAWAY, { runId: "f-3", handler: new SimHandler({}), stepBudget: 300_000, yieldEvery });
  } catch {
    // The budget stopping the run is expected; what is under test is the timer, not the throw.
  }
  const during = fired;
  clearTimeout(timer);
  return during;
};

{
  const yielding = await watchdogFiredDuring(256);
  const starved = await watchdogFiredDuring(NEVER);

  ok("with yielding on, a host timer fires DURING a runaway", yielding === true);
  // The control. If this also came back true the test above would prove nothing: it would mean the
  // run merely ended before the watchdog, and the assertion would be measuring speed, not yielding.
  ok("with yielding off, the same runaway starves the same timer", starved === false);
  ok("so the timer is measuring the yield, not the runtime", yielding !== starved, { yielding, starved });
}

// ---- 3) a race loser that spins is actually unwound ---------------------------------------------

/**
 * The reachable case, with no new API: cancellation is otherwise observed only at effect
 * boundaries, so a race loser that spins without performing an effect never learns it lost.
 *
 * `race` cancels the losers and then awaits them (`allSettled`), so without a cancellation check at
 * the yield boundary this program does not resolve at all. The timeout below is what distinguishes
 * "unwound" from "hung", and it is real: this test hangs rather than fails if the check is removed,
 * which is why it is written with an explicit loser rather than left to the suite runner.
 */
{
  const SPIN_LOSER = `
const a = await spawn("a");
const out = await race({
  fast: async () => await turn(a, { name: "quick" }),
  spin: async () => { let n = 0; while (true) { n = n + 1; } },
}, { name: "who" });
log(out.index);
`;
  const logs: unknown[] = [];
  const raced = run(SPIN_LOSER, {
    runId: "f-4",
    handler: new SimHandler({ turns: { quick: { status: "done", at: 0 } } }),
    yieldEvery: 64,
    stepBudget: 2_000_000,
    onLog: (l) => logs.push(l.values[0]),
  });
  const verdict = await Promise.race([
    raced.then(() => "returned").catch((e) => `threw ${(e as Error).message.slice(0, 40)}`),
    new Promise<string>((r) => {
      setTimeout(() => r("HUNG"), 4_000);
    }),
  ]);

  ok("a race whose loser spins forever still returns", verdict === "returned", verdict);
  ok("and the effect-performing branch is the winner", logs[0] === "fast", logs);
}

// ---- 4) the ceiling is invisible to ordinary programs -------------------------------------------

/**
 * The cancellation check sits at the yield boundary rather than on every dispatch, so that ordinary
 * programs keep the documented law unchanged: cancellation is observed at effect boundaries. That
 * claim is only true if ordinary programs do not cross a yield boundary between effects, which is a
 * fact about step counts rather than an intention. So measure it.
 */
{
  const ORDINARY = `
const team = channel("work");
const planner = await spawn("planner", { join: [team] });
const builder = await spawn("builder", { join: [team] });
await turn(planner, { name: "plan" });
await turn(builder, { name: "build" });
const votes = await parallel({
  a: async () => await turn(planner, { name: "review" }),
  b: async () => await turn(builder, { name: "check" }),
}, { name: "reviews" });
log(votes.a.status);
`;
  const logs: unknown[] = [];
  const r = await run(ORDINARY, {
    runId: "f-5",
    handler: new SimHandler({
      turns: {
        plan: { status: "done", at: 0 },
        build: { status: "done", at: 0 },
        review: { status: "done", at: 0 },
        check: { status: "done", at: 0 },
      },
    }),
    onLog: (l) => logs.push(l.values[0]),
  });

  ok("a realistic program completes under the default budget", logs[0] === "done", logs);
  ok("and reports what it cost", typeof r.steps === "number" && r.steps > 0, r.steps);
  // The number that backs the comment in breathe(): five effects and a parallel scope cost far less
  // than one yield interval, so no ordinary program reaches the boundary where cancellation is
  // checked. If this ever fails, the comment is wrong before the code is.
  ok("and stays well inside one yield interval (1024)", r.steps < 1_024, r.steps);
}

// ---- 4) the effect ceiling is a RUN bound, and survives a crash ------------------------------
//
// The counter lives on the interpreter, so every activation used to start at zero: a run pinned to
// four effects performed six across two activations and never faulted. Two individually correct
// decisions composed into it — instance fields at zero, and replayed effects deliberately not
// counted, which is right because a replay performs nothing. What was missing is that the journal
// records every dispatch, so the count IS recoverable, and L4009 is a RUN ceiling.
//
// This is the exact reproduction that found it: pin four, release after three, resume.
{
  const NOW = 1_770_000_000_000;
  const pins = resolvePins({ runId: "r-ceil", effectCeiling: 4 }, NOW);
  const SIX = [1, 2, 3, 4, 5, 6].map((i) => `await sleep("1m", { name: "s${i}" });`).join("\n");

  const entries: JournalEntry[] = [];
  const store = { append: async (e: JournalEntry) => { entries.push(e); } } as JournalStore;

  let dispatched = 0;
  const counting = new Proxy(new SimHandler({ now: () => NOW }), {
    get(t: SimHandler, k: string | symbol) {
      const v = (t as unknown as Record<string | symbol, unknown>)[k];
      if (typeof v !== "function") return v;
      const f = v as (...a: unknown[]) => unknown;
      if (k !== "sleep") return f.bind(t);
      return (...a: unknown[]) => { dispatched += 1; return f.apply(t, a); };
    },
  }) as SimHandler;

  let stops = 0;
  const first = await run(SIX, {
    runId: "r-ceil", handler: counting, pins,
    journal: new Journal({ run: "r-ceil", store }),
    shouldStop: () => (stops++ >= 3 ? "released" : undefined),
  }).then(() => null, (e: unknown) => e as Error);
  ok("the first activation is released after three effects, well inside the ceiling",
    first?.name === "RunReleased" && dispatched === 3, { first: first?.name, dispatched });

  const second = await run(SIX, {
    runId: "r-ceil", handler: counting, pins,
    journal: new Journal({ run: "r-ceil", entries, store }),
  }).then(() => null, (e: unknown) => e as Error);

  // Before the fix this returned normally, having performed six effects under a ceiling of four,
  // and nothing anywhere said so. The ceiling is what the run is pinned to, not what one walk is.
  ok("the resumed run reaches the ceiling the RUN was pinned to, not a fresh one",
    second instanceof RuntimeFault && second.code === "L4009", { name: second?.name, code: (second as RuntimeFault)?.code });
  ok("and it stops at the pinned number rather than after it",
    dispatched === 4, dispatched);
  ok("the message quotes the pinned ceiling",
    second instanceof Error && second.message.includes("more than 4 effects"), second?.message);
}

// ---- 5) the step budget is NOT the same, and says so -----------------------------------------
//
// Steps are not recorded, so nothing can recover a count across an activation and the budget is
// genuinely per-walk. The two pins sit together on the run record and the next reader will assume
// symmetry, so the message is where the asymmetry has to be stated.
{
  let caught: unknown;
  try {
    await run(RUNAWAY, { runId: "f-walk", handler: new SimHandler({}), stepBudget: 500, yieldEvery: NEVER });
  } catch (e) {
    caught = e;
  }
  ok("the step budget faults as L4013", (caught as RuntimeFault)?.code === "L4013", String(caught));
  ok("and its message says it bounds ONE WALK, not the run",
    caught instanceof Error && caught.message.includes("bounds ONE WALK, not the run"), (caught as Error)?.message);
}

console.log(`fuel.smoke: ${pass} checks passed`);
