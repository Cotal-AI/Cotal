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
import { createHash } from "node:crypto";
import { run, resume } from "../src/interpret.js";
import { SimHandler } from "../src/sim.js";
import { Journal } from "../src/journal.js";
import { CATALOG } from "../src/errors.js";
import { ENGINE_LANGUAGE_VERSION, LANGUAGE_VERSION, PIN_DEFAULTS, PinMismatch, WALKER_LANGUAGE_VERSION, bindPins, resolvePins } from "../src/pins.js";

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
  const pins = resolvePins({ runId: "r-1" }, 1_000, WALKER_LANGUAGE_VERSION);
  ok("the seed defaults from the run id", pins.seed === "r-1");
  ok("the logical epoch defaults to the host clock read once", pins.startedAt === 1_000);
  ok("the three limits default to the documented values",
    pins.yieldEvery === PIN_DEFAULTS.yieldEvery
    && pins.stepBudget === PIN_DEFAULTS.stepBudget
    && pins.effectCeiling === PIN_DEFAULTS.effectCeiling);
  ok("and the language version is stamped, by the ENGINE that resolved them", pins.languageVersion === WALKER_LANGUAGE_VERSION);

  const supplied = resolvePins({ runId: "r-1", seed: "s-9", startedAt: 42, effectCeiling: 7 }, 1_000, WALKER_LANGUAGE_VERSION);
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
  const recorded = resolvePins({ runId: "r-4", seed: "s-4", effectCeiling: 3 }, 700, WALKER_LANGUAGE_VERSION);
  const bound = bindPins(recorded, { runId: "r-4" }, WALKER_LANGUAGE_VERSION);
  ok("an absent option takes the recorded pin", bound.seed === "s-4" && bound.effectCeiling === 3);

  const agreeing = bindPins(recorded, { runId: "r-4", seed: "s-4", startedAt: 700 }, WALKER_LANGUAGE_VERSION);
  ok("an option that AGREES is harmless", agreeing.startedAt === 700);
}

// ---- 5) a pin the caller changed is REFUSED (L5009), and the refusal names it -----------------

{
  const recorded = resolvePins({ runId: "r-5", seed: "s-5" }, 700, WALKER_LANGUAGE_VERSION);

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
      bindPins(recorded, { runId: "r-5", ...override }, WALKER_LANGUAGE_VERSION);
    } catch (e) {
      caught = e;
    }
    ok(`a changed ${pin} is refused`, caught instanceof PinMismatch && caught.code === "L5009", String(caught));
    ok(`and the refusal names ${pin}`, caught instanceof PinMismatch && caught.pin === pin);
  }

  let caught: unknown;
  try {
    bindPins(recorded, { runId: "r-5", seed: "s-other" }, WALKER_LANGUAGE_VERSION);
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
  const foreign = { ...resolvePins({ runId: "r-6" }, 700, WALKER_LANGUAGE_VERSION), languageVersion: "0" };
  let caught: unknown;
  try {
    bindPins(foreign, { runId: "r-6" }, WALKER_LANGUAGE_VERSION);
  } catch (e) {
    caught = e;
  }
  ok("a journal from another language version is refused", caught instanceof PinMismatch && caught.code === "L5008");
  ok("and the refusal names both versions",
    caught instanceof PinMismatch && caught.recorded === "0" && caught.supplied === WALKER_LANGUAGE_VERSION);
  ok("the version check runs BEFORE the pin comparison, so a foreign version is not reported as a seed problem",
    caught instanceof PinMismatch && caught.pin === "languageVersion");
}

// ---- 6b) TWO ENGINES, TWO VERSIONS: the version is passed IN, and each engine compares its own --
//
// The version is a property of the engine that runs a program, not of this module, and these cells
// are what keep it that way. Bumping one shared constant was measured and is not available: the
// walker would stamp 2 and compare 1, and every walker fresh-run-then-resume round trip fails - 7
// of 18 suites red, the differential gate among them. Leaving the constant at 1 while the engine
// speaks 2 fails the other way, on the checked-in v1 records. Each engine stamping AND comparing
// its own is the only arrangement that breaks neither, so both halves are asserted here: that the
// two versions are DIFFERENT, and that neither function reads a version out of this module.

{
  ok("the walker's version and the engine's are two different languages", WALKER_LANGUAGE_VERSION !== ENGINE_LANGUAGE_VERSION,
    { walker: WALKER_LANGUAGE_VERSION, engine: ENGINE_LANGUAGE_VERSION });
  // The CURRENT language is the engine's. `LANGUAGE_VERSION` is what a caller means by "this
  // language" and it must move with the newest engine, not with the oldest one still supported.
  ok("and the current language is the ENGINE's, not the walker's", LANGUAGE_VERSION === ENGINE_LANGUAGE_VERSION,
    { current: LANGUAGE_VERSION, engine: ENGINE_LANGUAGE_VERSION });

  // NEITHER FUNCTION MAY READ A VERSION OUT OF THIS MODULE, and a version belonging to no engine is
  // how that gets proved: if `resolvePins` reached for a constant, this would come back as one of
  // the two real ones and look entirely reasonable.
  ok("a resolver stamps the version it was HANDED, whatever it is", resolvePins({ runId: "r-6b" }, 700, "42").languageVersion === "42",
    resolvePins({ runId: "r-6b" }, 700, "42").languageVersion);

  const byWalker = resolvePins({ runId: "r-6b" }, 700, WALKER_LANGUAGE_VERSION);
  const byEngine = resolvePins({ runId: "r-6b" }, 700, ENGINE_LANGUAGE_VERSION);
  ok("a record binds under the engine that wrote it, on both sides",
    bindPins(byWalker, { runId: "r-6b" }, WALKER_LANGUAGE_VERSION).languageVersion === WALKER_LANGUAGE_VERSION
    && bindPins(byEngine, { runId: "r-6b" }, ENGINE_LANGUAGE_VERSION).languageVersion === ENGINE_LANGUAGE_VERSION);

  // AND IS REFUSED UNDER THE OTHER, BOTH DIRECTIONS. One direction alone would pass for a check
  // that refuses everything older, or everything newer; a run does not get to be resumed by a
  // future engine any more than by a past one, because "different semantics" has no direction.
  const refusal = (recorded: typeof byWalker, engine: string): PinMismatch | undefined => {
    try { bindPins(recorded, { runId: "r-6b" }, engine); return undefined; } catch (e) { return e as PinMismatch; }
  };
  const forward = refusal(byWalker, ENGINE_LANGUAGE_VERSION);
  const backward = refusal(byEngine, WALKER_LANGUAGE_VERSION);
  ok("a walker record is refused by the engine, and an engine record by the walker",
    forward instanceof PinMismatch && forward.code === "L5008"
    && backward instanceof PinMismatch && backward.code === "L5008",
    { forward: forward?.code, backward: backward?.code });
  ok("and each refusal names the version RECORDED and the version asking, not a constant",
    forward?.recorded === WALKER_LANGUAGE_VERSION && forward?.supplied === ENGINE_LANGUAGE_VERSION
    && backward?.recorded === ENGINE_LANGUAGE_VERSION && backward?.supplied === WALKER_LANGUAGE_VERSION,
    { forward: [forward?.recorded, forward?.supplied], backward: [backward?.recorded, backward?.supplied] });
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
  const pins = { ...resolvePins({ runId: "r-7" }, 0, WALKER_LANGUAGE_VERSION), effectCeiling: 5 };
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

// ---- 9) the draw is the derivation the reference states, byte for byte ------------------------
//
// `spec/cotal-lang.md` §8.2: a draw is the first 48 bits of SHA-256 over the UTF-8 bytes of the
// seed, U+0000, the scope path string, U+0000, and the decimal draw index, divided by 2^48. This
// cell computes that from the sentence, with node's own hash and no interpreter, and requires the
// interpreter's `random()` to be the same number: the document and the code cannot separate.

{
  const draws: number[] = [];
  await run(`log(random(), random())`, {
    runId: "r-10", seed: "run-1", handler: new SimHandler({}),
    onLog: (l) => draws.push(...(l.values as number[])),
  });
  const stated = (seed: string, scopePath: string, n: number): number => {
    const h = createHash("sha256").update(`${seed}\u0000${scopePath}\u0000${n}`, "utf8").digest();
    let v = 0;
    for (let i = 0; i < 6; i += 1) v = v * 256 + (h[i] as number);
    return v / 2 ** 48;
  };
  ok("random() at the root scope is the reference's derivation: sha256(seed U+0000 path U+0000 n), first 48 bits, over 2^48",
    draws[0] === stated("run-1", "", 0) && draws[1] === stated("run-1", "", 1), { draws, stated: [stated("run-1", "", 0), stated("run-1", "", 1)] });
  ok("and a space in place of U+0000 is a different stream, so the separator is part of the contract",
    createHash("sha256").update("run-1  0", "utf8").digest("hex") !== createHash("sha256").update(`run-1\u0000\u00000`, "utf8").digest("hex"));
}

console.log(`pins.smoke: ${pass} checks passed`);
