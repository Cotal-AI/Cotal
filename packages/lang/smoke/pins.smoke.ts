/**
 * The pins' proof: a run's resolved seed, logical epoch and three limits are recorded once and
 * bound on every resume, and a caller who supplies a different one is refused rather than obeyed.
 *
 * The load-bearing case is section 3. A resumed run's `now()` before its first effect must be the
 * epoch the run STARTED at, not the clock of whatever host is resuming it — otherwise a program
 * that branches on elapsed time takes a branch determined by when someone happened to restart it,
 * and nothing in the journal records that it did. Every other cell here is a guard around that one.
 *
 * Refusals are tested by code AND by what they name. "It threw" is not the property; a resume that
 * fails without saying which pin disagreed is a failure an author cannot act on.
 */
import { run, resume } from "../src/interpret.js";
import { SimHandler } from "../src/sim.js";
import { Journal } from "../src/journal.js";
import { CATALOG } from "../src/errors.js";
import { LANGUAGE_VERSION, PIN_DEFAULTS, PinMismatch, bindPins, resolvePins } from "../src/pins.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ok ${name}`);
};

/** Run a program and hand back the result, so a cell reads as one line. */
const exec = async (source: string, options: Parameters<typeof run>[1]) => await run(source, options);

const logged: unknown[][] = [];
const sink = (line: { scope: string; values: readonly unknown[] }) => {
  logged.push([...line.values]);
};

// ---- 1) a fresh run RESOLVES its pins, and the resolved value is what is pinned ---------------

{
  const pins = resolvePins({ runId: "r-1" }, 1_000);
  ok("the seed defaults from the run id", pins.seed === "r-1");
  ok("the logical epoch defaults to the host clock read once", pins.startedAt === 1_000);
  ok("the three limits default to the documented values",
    pins.yieldEvery === PIN_DEFAULTS.yieldEvery
    && pins.stepBudget === PIN_DEFAULTS.stepBudget
    && pins.effectCeiling === PIN_DEFAULTS.effectCeiling);
  ok("and the language version is stamped", pins.languageVersion === LANGUAGE_VERSION);

  const supplied = resolvePins({ runId: "r-1", seed: "s-9", startedAt: 42, effectCeiling: 7 }, 1_000);
  ok("a supplied seed is what gets pinned", supplied.seed === "s-9");
  ok("a supplied epoch is what gets pinned", supplied.startedAt === 42);
  ok("a supplied ceiling is what gets pinned", supplied.effectCeiling === 7);
}

// ---- 2) a run hands its pins back, and the program can read its own epoch ---------------------

const EPOCH_PROGRAM = `
log(run().startedAt);
await sleep("1m");
`;

{
  logged.length = 0;
  const r = await exec(EPOCH_PROGRAM, {
    runId: "r-2",
    handler: new SimHandler({ clock: { start: 5_000 } }),
    onLog: sink,
  });
  ok("a run hands its resolved pins back for the run record", r.pins.startedAt === 5_000 && r.pins.seed === "r-2");
  ok("run() hands the program its startedAt", logged[0]?.[0] === 5_000);
}

// ---- 3) a RESUME derives now() from the pinned epoch, not from the resuming host --------------

const CLOCK_PROGRAM = `
const t0 = now();
await sleep("1h");
log(now() - t0);
`;

{
  logged.length = 0;
  const first = await exec(CLOCK_PROGRAM, {
    runId: "r-3",
    handler: new SimHandler({ clock: { start: 1_000 } }),
    onLog: sink,
  });
  const elapsedLive = logged[0]?.[0];
  ok("the live run measures the sleep it performed", elapsedLive === 3_600_000);

  // Resume on a host whose clock is somewhere else entirely, with an EMPTY script: the simulator
  // refuses any unscripted effect, so completing is itself proof the sleep replayed.
  logged.length = 0;
  const j = new Journal({ run: "r-3", entries: first.journal.entries() });
  const again = await resume(CLOCK_PROGRAM, j, {
    runId: "r-3",
    handler: new SimHandler({ clock: { start: 9_999_999 } }),
    pins: first.pins,
    onLog: sink,
  });
  ok("the resumed run measures the same elapsed time", logged[0]?.[0] === 3_600_000, logged[0]?.[0]);
  ok("because its clock started at the PINNED epoch, not the resuming host's", again.pins.startedAt === 1_000);
}

// ---- 4) a resume BINDS every pin from the record rather than re-defaulting --------------------

{
  const recorded = resolvePins({ runId: "r-4", seed: "s-4", effectCeiling: 3 }, 700);
  const bound = bindPins(recorded, { runId: "r-4" });
  ok("an absent option takes the recorded pin", bound.seed === "s-4" && bound.effectCeiling === 3);

  const agreeing = bindPins(recorded, { runId: "r-4", seed: "s-4", startedAt: 700 });
  ok("an option that AGREES is harmless", agreeing.startedAt === 700);
}

// ---- 5) a pin the caller changed is REFUSED (L5009), and the refusal names it -----------------

{
  const recorded = resolvePins({ runId: "r-5", seed: "s-5" }, 700);

  const cases: readonly [string, Record<string, unknown>][] = [
    ["seed", { seed: "s-other" }],
    ["startedAt", { startedAt: 701 }],
    ["yieldEvery", { yieldEvery: 8 }],
    ["stepBudget", { stepBudget: 9 }],
    ["effectCeiling", { effectCeiling: 10 }],
  ];
  for (const [pin, override] of cases) {
    let caught: unknown;
    try {
      bindPins(recorded, { runId: "r-5", ...override });
    } catch (e) {
      caught = e;
    }
    ok(`a changed ${pin} is refused`, caught instanceof PinMismatch && caught.code === "L5009", String(caught));
    ok(`and the refusal names ${pin}`, caught instanceof PinMismatch && caught.pin === pin);
  }

  let caught: unknown;
  try {
    bindPins(recorded, { runId: "r-5", seed: "s-other" });
  } catch (e) {
    caught = e;
  }
  ok("the refusal carries BOTH values, so an author can see the difference",
    caught instanceof PinMismatch && caught.recorded === "s-5" && caught.supplied === "s-other");
  ok("and its message offers fork as the way forward",
    caught instanceof Error && caught.message.includes("fork(run"));
}

// ---- 6) a run pinned to another language version is REFUSED (L5008) --------------------------

{
  const foreign = { ...resolvePins({ runId: "r-6" }, 700), languageVersion: "0" };
  let caught: unknown;
  try {
    bindPins(foreign, { runId: "r-6" });
  } catch (e) {
    caught = e;
  }
  ok("a journal from another language version is refused", caught instanceof PinMismatch && caught.code === "L5008");
  ok("and the refusal names both versions",
    caught instanceof PinMismatch && caught.recorded === "0" && caught.supplied === LANGUAGE_VERSION);
  ok("the version check runs BEFORE the pin comparison, so a foreign version is not reported as a seed problem",
    caught instanceof PinMismatch && caught.pin === "languageVersion");
}

// ---- 7) the pinned limits are the ones the interpreter enforces -------------------------------

const LOOP_PROGRAM = `
let n = 0;
while (n < 50) {
  await sleep("1s");
  n = n + 1;
}
`;

{
  // The ceiling is pinned LOW on the record and the caller passes nothing. If the interpreter
  // re-defaulted instead of binding, this program would finish.
  const pins = { ...resolvePins({ runId: "r-7" }, 0), effectCeiling: 5 };
  let caught: unknown;
  try {
    await exec(LOOP_PROGRAM, { runId: "r-7", handler: new SimHandler({}), pins });
  } catch (e) {
    caught = e;
  }
  ok("a pinned effect ceiling is what stops the run", caught instanceof Error && caught.message.includes("L4009"), String(caught));
  ok("and the message quotes the PINNED ceiling, not the default",
    caught instanceof Error && caught.message.includes("more than 5 effects"));
}

// ---- 9) A RESUME MAY NOT DECLINE TO SAY WHICH RUN IT IS RESUMING ------------------------------
//
// Section 3 proves the epoch is honoured when the pins are HANDED OVER. This is the hole beside it:
// the pins were optional, so a caller could pass history and omit them, and nothing refused. The
// harm is measured below rather than asserted — with the guard removed, the same journal resumed on
// a host a day later ran at the resuming host's epoch and re-seeded its PRNG, and no divergence
// fired, because neither the clock nor a pure draw is a recorded fact for a replay to compare.

{
  const P = `
let t = now()
let r = random()
log({ t: t, r: r })
await sleep("1s", { name: "s" })
`;
  const EPOCH = 1_000_000_000_000;
  const LATER = EPOCH + 86_400_000;
  const seen: unknown[] = [];
  const sink = (l: { values: readonly unknown[] }) => { seen.push(l.values[0]); };

  const live = await run(P, {
    runId: "r-9", seed: "a-deliberate-seed",
    handler: new SimHandler({ clock: { start: EPOCH } }), onLog: sink,
  });

  let refused: unknown;
  try {
    await resume(P, new Journal({ run: "r-9", entries: live.journal.entries() }), {
      runId: "r-9", handler: new SimHandler({ clock: { start: LATER } }), onLog: sink,
    });
  } catch (e) { refused = e; }
  ok("a resume over a recorded journal with no pins is REFUSED", (refused as { code?: string })?.code === "L5021", String(refused).slice(0, 90));
  ok("and the refusal says the pins are what decide the epoch and the seed",
    String(refused).includes("logical epoch") && String(refused).includes("seed"), String(refused).slice(0, 200));

  // NARROWNESS, and it is load-bearing: a journal with NO entries is a fresh run being handed a
  // journal for its store, not a resume. Refusing that would break the ordinary way a driver
  // supplies storage, so the guard must read the entries and not merely the option.
  const fresh = await run(P, {
    runId: "r-9b", handler: new SimHandler({ clock: { start: EPOCH } }),
    journal: new Journal({ run: "r-9b" }),
  }).then(() => null, (e: unknown) => e as Error);
  ok("while a run handed an EMPTY journal is still a fresh run, not a refused resume", fresh === null, String(fresh).slice(0, 90));

  const liveDraw = (seen[0] as { r: number })?.r;

  // And the pins that were handed over are the ones the resume ran under, so the cell above is
  // about the omission rather than about resuming at all.
  seen.length = 0;
  const carried = await resume(P, new Journal({ run: "r-9", entries: live.journal.entries() }), {
    runId: "r-9", pins: live.pins, handler: new SimHandler({ clock: { start: LATER } }), onLog: sink,
  });
  ok("a resume that carries the pins replays at the RECORDED epoch, not this host's",
    (seen[0] as { t: number })?.t === EPOCH, seen[0]);
  ok("and draws the same number, because the seed came back with the pins rather than being re-defaulted",
    (seen[0] as { r: number })?.r === liveDraw && carried.pins.seed === "a-deliberate-seed",
    { live: liveDraw, replayed: (seen[0] as { r: number })?.r, seed: carried.pins.seed });
}

// ---- 8) the two codes exist in the catalog, with their titles -------------------------

{
  ok("L5009 is in the catalog", CATALOG.L5009 === "Resume pin mismatch");
  ok("L5008 is in the catalog", CATALOG.L5008 === "Resume under a different language version");
  ok("L5005's title says what an author must do about it",
    CATALOG.L5005 === "A pending effect cannot be recovered");
  ok("L5021 is in the catalog", CATALOG.L5021 === "Resume over a journal without the run's pins");
}

console.log(`pins.smoke: ${pass} checks passed`);
