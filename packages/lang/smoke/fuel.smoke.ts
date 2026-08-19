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
import { WALKER_LANGUAGE_VERSION, resolvePins } from "../src/pins.js";

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

// ---- 3) a race arm that spins: cut when it cannot win, budgeted when it could ------------------

/**
 * Cancellation is otherwise observed only at effect boundaries, so an arm that spins without
 * performing an effect never reaches one. What happens to it is the race rule, not the scheduler:
 *
 * - an arm that CAN NO LONGER WIN (its clock is later than a settled sibling's, or equal and it is
 *   declared later) is cut at its next yield, and the run returns with the sibling as the winner;
 * - an arm that COULD STILL WIN (its clock is earlier, or equal and it is declared earlier) keeps
 *   its pure work, because cutting it there would let `yieldEvery` decide the race; if that work is
 *   a pure infinite loop it ends on the step budget, L4013, which is the run's answer.
 *
 * Three programs, one variable each. The watchdog is what distinguishes "returned" from "hung", and
 * it is real: with the cut removed the second program does not resolve inside its budget window.
 */
{
  const raceUntil = async (source: string, runId: string): Promise<{ verdict: string; logs: unknown[] }> => {
    const logs: unknown[] = [];
    const raced = run(source, {
      runId,
      handler: new SimHandler({ turns: { quick: { status: "done", at: 0 } } }),
      yieldEvery: 64,
      stepBudget: 40_000,
      onLog: (l) => logs.push(l.values[0]),
    });
    const verdict = await Promise.race([
      raced.then(() => "returned").catch((e) => `threw ${(e as Error).message.slice(0, 40)}`),
      new Promise<string>((r) => {
        setTimeout(() => r("HUNG"), 8_000);
      }),
    ]);
    return { verdict, logs };
  };

  // (b) the spinner CANNOT win: equal clocks (neither arm awaits an effect), and it is declared second.
  {
    const { verdict, logs } = await raceUntil(
      `
const out = await race({
  quick: async () => "done",
  spin: async () => { let n = 0; while (true) { n = n + 1; } },
}, { name: "who" });
log(out.index);
`,
      "f-4b",
    );
    ok("a spinning arm that cannot win is cut at its next yield and the run returns", verdict === "returned", verdict);
    ok("and the arm declared first wins the tie", logs[0] === "quick", logs);
  }

  // (c) the same two arms, the spinner declared FIRST: it could still win the tie, so its pure work
  // is not cut, and the pure infinite loop ends on the step budget.
  {
    const { verdict } = await raceUntil(
      `
const out = await race({
  spin: async () => { let n = 0; while (true) { n = n + 1; } },
  quick: async () => "done",
}, { name: "who" });
log(out.index);
`,
      "f-4c",
    );
    ok("a spinning arm that could still win is not cut: the step budget ends it (L4013)", verdict.startsWith("threw L4013"), verdict);
  }

  // (a) the spinner has the EARLIER clock: the sibling awaited a turn (the simulator advances its
  // clock by 5m), the spinner awaited nothing, so its logical time is the scope's entry. Declared
  // second, it could still win on the clock alone, and the budget ends it.
  {
    const { verdict } = await raceUntil(
      `
const a = await spawn("a");
const out = await race({
  fast: async () => await turn(a, { name: "quick" }),
  spin: async () => { let n = 0; while (true) { n = n + 1; } },
}, { name: "who" });
log(out.index);
`,
      "f-4a",
    );
    ok("a spinning arm with the earlier logical time is not cut either, whatever it is declared after (L4013)", verdict.startsWith("threw L4013"), verdict);
  }
}

// ---- 4) the ceiling is invisible to ordinary programs -------------------------------------------

/**
 * The pure cut sits at the yield boundary rather than on every dispatch, so an ordinary program
 * never meets it: cancellation is observed at effect boundaries. That claim rests on ordinary
 * programs not crossing a yield boundary between effects, which is a fact about step counts rather
 * than an intention. So measure it.
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
  // Five effects and a parallel scope cost far less than one yield interval, so no ordinary program
  // reaches the boundary where a pure cut is applied. If this ever fails, the comment is wrong
  // before the code is.
  ok("and stays well inside one yield interval (1024)", r.steps < 1_024, r.steps);
}

// ---- 4) the effect ceiling is a RUN bound, and survives a crash ------------------------------
//
// The counter lives on the interpreter, so a fresh activation starts at zero and a run pinned to
// four effects can perform six across two activations without faulting. Two individually correct
// decisions compose into that: instance fields at zero, and replayed effects deliberately not
// counted, which is right because a replay performs nothing. The journal records every dispatch,
// so the count is recoverable, and L4009 is a RUN ceiling.
//
// The shape here: pin four, release after three, resume.
{
  const NOW = 1_770_000_000_000;
  const pins = resolvePins({ runId: "r-ceil", effectCeiling: 4 }, NOW, WALKER_LANGUAGE_VERSION);
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

  // The ceiling is what the RUN is pinned to, not what one walk is. Counted per activation, this
  // returns normally having performed six effects under a ceiling of four, and says nothing.
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
