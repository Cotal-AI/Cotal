/**
 * The primary gate of the engine wave: the same program, through both engines, one journal.
 *
 * `surface.smoke` holds what the emitted module IS and `engine.smoke` holds what the host's seam
 * DOES. Neither can answer the question this wave exists to answer, which is whether the second
 * engine is the same engine: a transform can emit a closed module that reaches every ruled member
 * and still walk a program in a different order, and order is exactly what a step key records. So
 * each program here runs on the walker and on the engine with nothing between them, and the arms
 * must agree on the value, the log, the refusal, AND the journal entry for entry — the step keys
 * and their sequence, not merely the output.
 *
 * THREE LISTS, AND THE TWO SMALL ONES ARE THE HONEST PART. `CORPUS` must be identical on both
 * arms. `DIVERGENT` is what a ruling deliberately made different, each with the answer BOTH arms
 * give, so the day the divergence is retired this suite reds instead of quietly passing. `HELD` is
 * what the engine cannot run yet, each pinned to the way it fails — landing the missing member
 * reds the hold rather than leaving a program silently outside the gate. A suite that dropped
 * either list would report the same green over a smaller universe.
 */
import { resumeOnEngine, runOnEngine } from "../src/engine/host.js";
import { Journal, type JournalEntry } from "../src/journal.js";
import { resume as walkResume, run as walk } from "../src/interpret.js";
import { SimHandler } from "../src/sim.js";
import { transform } from "../src/transform/index.js";

let pass = 0;
const failures: string[] = [];
/**
 * COUNTING, NOT FAIL-FAST, and that is a property of what this suite is for.
 *
 * A differential run's answer is "which programs disagree", and a suite that exits at the first one
 * reports a single divergence where there may be nine — the other lane reads this output to know
 * what to fix. It also makes the mutation proof honest: with a fail-fast suite every mutation is
 * graded on whichever cell happens to be earliest, so a mutation aimed at ORDER is judged by a cell
 * about member reads. The summary line at the bottom prints on both outcomes, which is what lets
 * `mutation-proof` tell a real red from a run that died early.
 */
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ok ${name}`);
    return;
  }
  failures.push(name);
  console.log(`  FAIL ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
};

const SEED = "differential-seed";
const AT = 1_700_000_000_000;

/**
 * Turning a module string into a function.
 *
 * A plain evaluator, and `host.ts` requires the caller to say so: this suite compares two engines
 * on validator-accepted source inside a test process, where confinement is not what is under test.
 * The worker's evaluator is the confined one.
 */
const evaluate = (module: string) => new Function(`return (${module})`)() as never;

interface Arm {
  readonly value: unknown;
  readonly logs: readonly unknown[][];
  readonly entries: readonly JournalEntry[];
  readonly error: string | null;
}

const arm = async (kind: "walker" | "engine", source: string, script: object): Promise<Arm> => {
  const logs: unknown[][] = [];
  // A HANDLER IS STATEFUL, so each arm gets its own from the same script. Sharing one would let the
  // first arm consume the scripted turns and the second see a different world.
  const handler = new SimHandler(script as never);
  const journal = new Journal({ run: "d" });
  const options = { runId: "d", handler, journal, seed: SEED, startedAt: AT, onLog: (l: { values: readonly unknown[] }) => logs.push([...l.values]) };
  try {
    const r = kind === "walker" ? await walk(source, options) : await runOnEngine(source, transform(source).module, { ...options, evaluate });
    return { value: r.value, logs, entries: r.journal.entries(), error: null };
  } catch (e) {
    return { value: undefined, logs, entries: journal.entries(), error: (e as { code?: string }).code ?? `${(e as Error).name}: ${(e as Error).message.slice(0, 80)}` };
  }
};

const j = (v: unknown) => JSON.stringify(v);

/** Where two arms differ, as the field names. Empty means identical. */
const differences = (a: Arm, b: Arm): string[] => {
  const out: string[] = [];
  if (j(a.value) !== j(b.value)) out.push("value");
  if (j(a.logs) !== j(b.logs)) out.push("logs");
  if (a.error !== b.error) out.push("error");
  // ENTRY FOR ENTRY, in order. A journal that agreed as a set and disagreed on sequence would be a
  // replay that resumes into the wrong step, which is the failure this whole gate exists to catch.
  if (a.entries.length !== b.entries.length) out.push("entry count");
  else for (let i = 0; i < a.entries.length; i += 1) if (j(a.entries[i]) !== j(b.entries[i])) out.push(`entry ${i}`);
  return out;
};

// ---- the corpus ----------------------------------------------------------------------------------

const WORKFLOW_SCRIPT = {
  turns: {
    "draft-plan": { status: "done", at: 0 },
    build: [
      { status: "blocked", at: 0 },
      { status: "done", at: 0 },
    ],
    unblock: { status: "done", at: 0 },
  },
  checkpoints: { "approve-plan": { status: "resolved", value: true, at: 0 } },
  clock: { start: 1_000_000 },
};

const CORPUS: readonly (readonly [string, string, object])[] = [
  ["sleep and the run clock", 'await sleep("1m", { name: "s" }); log(now() > 0);', {}],
  // STEP KEYS ARE (scope path, kind, name, occurrence), and the corpus has to reach each component
  // or the comparison is over one shape. These four move the occurrence counter, the name, and the
  // scope path a nested call adds.
  ["the same effect twice, so occurrence counts", 'await sleep("1m", { name: "s" }); await sleep("2m", { name: "s" }); log(now());', {}],
  ["an effect in a loop", 'for (const n of ["a", "b", "c"]) { await sleep("1m", { name: n }); } log(now());', {}],
  ["an effect with no name of its own", 'await sleep("1m"); await sleep("2m"); log(now());', {}],
  ["an effect inside a function, called twice", 'const step = async (n) => { await sleep("1m", { name: n }); return now(); }; log(await step("one"), await step("two"));', {}],
  ["literals and names", 'const a = 1; const b = "t"; const c = true; const d = null; log(a, b, c, d);', {}],
  ["template interpolation", "const n = 2; log(`n=${n}!`);", {}],
  ["array and object literals", "const xs = [1, 2]; const o = { a: 1, b: xs }; log(o, xs);", {}],
  ["spread", "const xs = [1, 2]; const ys = [0, ...xs]; const o = { ...{ a: 1 }, b: 2 }; log(ys, o);", {}],
  ["member read and write", "const o = { a: 1 }; o.a = 2; const xs = [1]; xs[0] = 3; log(o.a, xs[0]);", {}],
  ["nested binary operands", "log((5 + 1) + (3 + 4), 2 * 3 - 4 / 2);", {}],
  ["operators", "const a = 1 + 2 * 3; log(a, -a, ~a, !true, a === 7, a % 2, a ** 2, a > 1, a & 1);", {}],
  ["logical and conditional", "const a = 1 || 2; const b = null ?? 3; log(a, b, a ? 1 : 2, a && b);", {}],
  ["update operators on numbers", "let n = 0; n++; ++n; const o = { c: 0 }; o.c++; log(n, o.c);", {}],
  ["assignment operators", "let n = 1; n += 2; n -= 1; n ||= 9; n &&= 4; let m = null; m ??= 5; log(n, m);", {}],
  ["while with break and continue", "let n = 0; while (true) { n = n + 1; if (n === 2) { continue; } if (n > 3) { break; } } log(n);", {}],
  ["for over items", "let s = 0; for (const x of [1, 2, 3]) { s = s + x; } log(s);", {}],
  ["switch", 'const a = 2; switch (a) { case 1: { log("one"); break; } case 2: { log("two"); break; } default: { log("other"); break; } }', {}],
  ["try/catch/finally and completions", 'const f = () => { try { return 1; } finally { return 2; } }; try { throw { code: "x" }; } catch (e) { log(e.code); } finally { log("done"); } log(await f());', {}],
  ["try with no parameter", "try { throw 1; } catch { log(2); }", {}],
  // THE WHOLE CAUGHT VALUE, not one field of it. `e.code` reads the same on a raw record and on the
  // walker's `{code, kind, message}`, so a catch that bound the raw throw would agree on `e.code`
  // and disagree on everything else - which is exactly what a mutation proved this corpus missed.
  ["the value a catch binds", 'try { throw { code: "x" }; } catch (e) { log(e); }', {}],
  ["catching a value that is not a record", "try { throw 1; } catch (e) { log(e); }", {}],
  ["catching what a refusal throws", "try { const o = {}; log(o + 1); } catch (e) { log(e); }", {}],
  ["destructuring and rest", "const { a, b: bb, ...rest } = { a: 1, b: 2, c: 3 }; const [x, , ...ys] = [1, 2, 3, 4]; log(a, bb, rest, x, ys);", {}],
  ["destructuring assignment", "let a = 1; let b = 2; [a, b] = [b, a]; log(a, b);", {}],
  ["default and rest parameters", "function f(a, b = 2, ...rest) { return a + b + len(rest); } log(await f(1), await f(1, 2, 3, 4));", {}],
  ["a captured mutable binding", "let seen = 0; const bump = () => { seen = seen + 1; }; await bump(); log(seen);", {}],
  ["a recursive named function expression", "const fact = function walk(n) { return n === 0 ? 1 : n * walk(n - 1); }; log(await fact(4));", {}],
  ["curated methods", 'const xs = [3, 1, 2]; log(xs.map((x) => x + 1), sort(xs), "AB".lower(), (2.6).round(), json.stringify({ a: 1 }));', {}],
  ["optional chains", "const o = { a: { b: 1 } }; log(o.a?.b, o.z?.b, o.z?.b.c);", {}],
  // ORDER, WHICH IS WHAT A STEP KEY RECORDS. Both of these journal two sleeps, and the only thing
  // that distinguishes a correct engine from one that evaluates the right side first is which entry
  // is which. A value-only comparison would pass either way: 1 + 1 is 2 whichever sleep ran first.
  ["two effects in one binary expression", 'const f = async (n) => { await sleep("1m", { name: n }); return 1; }; log(await f("a") + await f("b"));', {}],
  ["two effects in one argument list", 'const f = async (n) => { await sleep("1m", { name: n }); return n; }; log(await f("a"), await f("b"));', {}],
  ["two effects in one array literal", 'const f = async (n) => { await sleep("1m", { name: n }); return n; }; log([await f("a"), await f("b")]);', {}],
  ["the undefined value", "const u = undefined; log(u === undefined);", {}],
  // A RECORD HAS NO PROTOTYPE TO REACH, so these three are undefined rather than refused - measured,
  // because the cell that assumed a refusal here was the one a mutation walked straight past.
  ["a record has no prototype to reach", "const o = { a: 1 }; log(o.constructor, o.toString, o.__proto__);", {}],
  ["refusals: a prototype member of a string", 'const s = "a"; log(s.constructor);', {}],
  ["refusals: a prototype member of an array", "const xs = [1]; log(xs.constructor);", {}],
  ["refusals: a member of a function", "const f = () => 1; log(f.call);", {}],
  ["an array's length is a member, not a prototype reach", "const xs = [1, 2]; log(xs.length);", {}],
  ["refusals: a method is not a value", "const xs = [1]; const m = xs.map; log(m);", {}],
  ["refusals: no implicit conversion", "const o = {}; log(o + 1);", {}],
  ["refusals: not iterable", "const o = {}; log([...o]);", {}],
];

{
  let identical = 0;
  for (const [name, source, script] of CORPUS) {
    const [w, e] = [await arm("walker", source, script), await arm("engine", source, script)];
    const diff = differences(w, e);
    ok(`identical on both engines: ${name}`, diff.length === 0, {
      differs: diff,
      walker: { value: w.value, logs: w.logs, error: w.error, entries: w.entries.length },
      engine: { value: e.value, logs: e.logs, error: e.error, entries: e.entries.length },
    });
    identical += 1;
  }
  console.log(`  (${identical} programs identical on both engines)`);
}

// ---- the comparator's own positive control -------------------------------------------------------

{
  // AN EMPTY DIFFERENCE LIST MEANS "NONE", NEVER "THE COMPARISON DID NOT LOOK". Every cell above is
  // an assertion that a list is empty, so a comparator that returned `[]` for two unrelated runs
  // would report a perfect gate over nothing. These perturb one field at a time and require it to
  // be found — including a journal that agrees as a set and disagrees on ORDER, which is the exact
  // failure the entry-by-entry walk exists for and the one a length check would miss.
  const [source, script] = ['const a = await spawn("one"); const b = await spawn("two"); log(a.agent, b.agent);', {}];
  const base = await arm("walker", source, script);
  ok("the control pair is identical before it is perturbed", differences(base, await arm("engine", source, script)).length === 0);
  ok("the comparator has something to compare", base.entries.length === 2 && base.logs.length === 1, { entries: base.entries.length, logs: base.logs.length });

  const found = (label: string, mutated: Arm, field: string) =>
    ok(`the comparator reports a perturbed ${label}`, differences(base, mutated).includes(field), differences(base, mutated));
  found("value", { ...base, value: "perturbed" }, "value");
  found("log line", { ...base, logs: [["perturbed"]] }, "logs");
  found("refusal", { ...base, error: "L9999" }, "error");
  found("entry count", { ...base, entries: base.entries.slice(1) }, "entry count");
  found("entry order", { ...base, entries: [...base.entries].reverse() }, "entry 0");
  found("step key", { ...base, entries: [{ ...(base.entries[0] as JournalEntry), name: "perturbed" }, base.entries[1] as JournalEntry] }, "entry 0");
}

// ---- what a ruling made different, on purpose ----------------------------------------------------

/**
 * A divergence a ruling DECLARED, with the answer both arms give.
 *
 * Pinned to both answers rather than to "these differ": a divergence retired upstream must red this
 * suite the day it lands, so it is removed in the same change instead of being remembered.
 */
const DIVERGENT: readonly (readonly [string, string, object, string, string])[] = [
  // EMPTY, and not because there are none. Ruling 1c declared exactly one — `x++` on a non-number,
  // where the walker coerces (issue 646) and the engine refuses L4018 — and it is not reachable
  // yet: the host's `unary` does not carry the `update` selector, so the engine answers L1000
  // "not implemented" rather than the refusal the ruling names. It sits in HELD below with both
  // answers written down, and moves up here the moment the selector lands.
];

{
  for (const [name, source, script, walkerAnswer, engineAnswer] of DIVERGENT) {
    const [w, e] = [await arm("walker", source, script), await arm("engine", source, script)];
    const answer = (a: Arm) => (a.error !== null ? a.error : `logs ${j(a.logs)}`);
    ok(`declared divergence, and both answers are what the ruling says: ${name}`, answer(w) === walkerAnswer && answer(e) === engineAnswer, {
      walker: answer(w),
      engine: answer(e),
      expected: { walker: walkerAnswer, engine: engineAnswer },
    });
  }
  console.log(`  (${DIVERGENT.length} declared divergence(s))`);
}

// ---- what the engine cannot run yet --------------------------------------------------------------

/**
 * A program held OUT of the corpus, and the refusal that holds it there.
 *
 * Not a comment and not a silent omission: each entry names the substring the engine fails with
 * today, so landing the missing piece turns this cell red and the program moves up into the corpus
 * in the same change. A held list with no assertion is a coverage cap nobody can see.
 */
const HELD: readonly (readonly [string, string, object, readonly string[], string])[] = [
  [
    "a real workflow: spawn, turn, checkpoint, loop",
    `const team = channel("feat-auth");
const planner = await spawn("planner", { worktree: "wt-1", join: [team] });
const builder = await spawn("builder", { worktree: "wt-1", join: [team] });
await turn(planner, { name: "draft-plan" });
const approval = await checkpoint("approve-plan", "Approve the plan?", { timeout: "10m", onExpiry: "proceed" });
if (approval.status === "expired") {
  await notify([planner], { decision: "approve-plan", outcome: "auto-proceeded" });
}
let r = await turn(builder, { name: "build" });
let rounds = 0;
while (r.status === "blocked") {
  rounds = rounds + 1;
  await turn(planner, { name: "unblock" });
  r = await turn(builder, { name: "build" });
}
log("rounds", rounds, r.status);`,
    WORKFLOW_SCRIPT,
    ["logs", "error", "entry count"],
    "the engine's `free` serves the library's builtins only, so `channel` is L2001; `freeConstructors` landed in perform.ts and is not wired into the seam yet",
  ],
  [
    "closures over a for-loop counter",
    "const fs = []; for (let i = 0; i < 3; i = i + 1) { fs.push(() => i); } let s = 0; for (const f of fs) { s = s + await f(); } log(s);",
    {},
    ["logs", "error"],
    "a program function stored through a mutating method is stored ADAPTED, and the program reads back something it cannot call",
  ],
  [
    "a builtin read as a value",
    "const f = map; log(f([1, 2], (x) => x), map === map);",
    {},
    ["logs"],
    "the value form of `free` does not adapt the arguments of the call that follows, and mints a fresh adapter per read, so a callback receives the run's own frame and `map === map` is false",
  ],
  ["refusals: a non-function callee", "const f = 1; log(f());", {}, ["error"], "`callee` is member 14 as of ruling 1c and the host's seam does not carry it yet"],
  [
    "ruling 1c / issue 646: an update's operand on a record",
    "const o = { c: {} }; o.c++; log(o.c);",
    {},
    ["logs", "error"],
    "THIS IS A DECLARED DIVERGENCE WAITING FOR ITS ENGINE HALF: the walker coerces to NaN and the engine must refuse L4018, but the host's `unary` has no `update` selector yet, so it answers L1000. When the selector lands this moves into DIVERGENT as walker `logs [[null]]` against engine `L4018`",
  ],
  [
    "a race, whose losers are digested",
    'const r = await race({ a: async () => "a", b: async () => "b" }, { name: "r" });\nlog(r.index);',
    {},
    ["logs", "error", "entry count"],
    "the engine refuses every scope-opener loudly (L1000) until its scope machinery lands; the transform ships the race's branch payload already",
  ],
  [
    "a scope combinator",
    'await parallel({ one: () => sleep("1m", { name: "one" }), two: () => sleep("2m", { name: "two" }) }, { name: "both" });',
    {},
    ["error", "entry count"],
    "the same loud refusal of every scope-opener",
  ],
];

{
  for (const [name, source, script, expected, why] of HELD) {
    const [w, e] = [await arm("walker", source, script), await arm("engine", source, script)];
    const diff = differences(w, e);
    ok(`held out of the corpus, and still differing exactly as it is held: ${name}`, j(diff) === j(expected), {
      differs: diff,
      expected,
      why,
      engine: e.error ?? e.logs,
    });
  }
  console.log(`  (${HELD.length} program(s) held out of the corpus, each pinned to the difference that holds it)`);
}

// ---- one journal, either engine: each arm resumes from the other's ------------------------------

/**
 * The strongest form of "the same journal", and the one equality alone cannot reach.
 *
 * Two journals can compare equal and still not be interchangeable, because a journal is not a
 * transcript — it is what a RESUMED run reads instead of dispatching. So each program runs on one
 * engine and is then resumed on the OTHER from the journal it wrote, against a handler that
 * REFUSES EVERY EFFECT. A resume that reached the handler at all therefore fails loudly rather
 * than quietly re-dispatching and agreeing by luck.
 *
 * The refusing handler is written here rather than reached for: an empty `SimHandler` looks like
 * one and is not — measured, it answers `sleep` perfectly happily, so five of these crossings would
 * have proved nothing while reading as though they proved everything.
 */
class RefusesEverything {
  static readonly REACHED = "the resume dispatched an effect instead of reading the journal";
  now(): number {
    return AT;
  }
}
for (const m of ["spawn", "turn", "ask", "checkpoint", "sleep", "wait", "notify", "monitor", "openConclave", "closeConclave"]) {
  (RefusesEverything.prototype as unknown as Record<string, unknown>)[m] = () => {
    throw new Error(`${RefusesEverything.REACHED} (${m})`);
  };
}

const RESUMABLE: readonly (readonly [string, string, object])[] = [
  ["sleep and the run clock", 'await sleep("1m", { name: "s" }); log(now() > 0);', {}],
  ["the same effect twice", 'await sleep("1m", { name: "s" }); await sleep("2m", { name: "s" }); log(now());', {}],
  ["an effect in a loop", 'for (const n of ["a", "b", "c"]) { await sleep("1m", { name: n }); } log(now());', {}],
  ["an effect inside a function, called twice", 'const step = async (n) => { await sleep("1m", { name: n }); return now(); }; log(await step("one"), await step("two"));', {}],
  ["two agents and a turn", 'const a = await spawn("one"); await turn(a, { name: "t" }); log(a.agent);', { turns: { t: { status: "done", at: 0 } } }],
];

{
  // THE CONTROL FOR THE CONTROL. Every crossing below is silent about the handler, and silence is
  // only evidence if the handler would have spoken. So each resumable program is first run FRESH
  // against the same refusing handler, and every one of them has to fail: that is what makes "the
  // resume said nothing" mean "the resume dispatched nothing".
  let spoke = 0;
  for (const [name, source] of RESUMABLE) {
    let reached = false;
    try {
      await walk(source, { runId: "c", handler: new RefusesEverything() as never, journal: new Journal({ run: "c" }), seed: SEED, startedAt: AT });
    } catch (e) {
      reached = String((e as Error).message).includes(RefusesEverything.REACHED);
    }
    if (reached) spoke += 1;
    else ok(`the refusing handler is reached by a fresh run of: ${name}`, false);
  }
  ok("every resumable program dispatches an effect the refusing handler answers loudly", spoke === RESUMABLE.length, { spoke, of: RESUMABLE.length });

  let crossings = 0;
  for (const [name, source, script] of RESUMABLE) {
    for (const [wrote, replays] of [
      ["walker", "engine"],
      ["engine", "walker"],
    ] as const) {
      const logs: unknown[][] = [];
      const journal = new Journal({ run: "d" });
      const first = { runId: "d", handler: new SimHandler(script as never), journal, seed: SEED, startedAt: AT, onLog: (l: { values: readonly unknown[] }) => logs.push([...l.values]) };
      // THE FIRST RUN IS GUARDED TOO. Unguarded, an engine that cannot finish the program takes the
      // whole suite down before it prints its summary — which reads to `mutation-proof` as a run
      // that died rather than a cell that went red, and discards the evidence it was there to
      // collect. Measured: the argument-order mutant graded INCONCLUSIVE for exactly this.
      let original: Awaited<ReturnType<typeof walk>>;
      try {
        original = wrote === "walker" ? await walk(source, first) : await runOnEngine(source, transform(source).module, { ...first, evaluate });
      } catch (e) {
        ok(`the ${wrote} completes the program it is to be resumed from: ${name}`, false, {
          error: (e as { code?: string }).code ?? `${(e as Error).name}: ${(e as Error).message.slice(0, 80)}`,
        });
        crossings += 1;
        continue;
      }

      // The pins travel with the journal. Re-resolving them would be a different run wearing this
      // one's history: the epoch moves to the resuming host and every pure draw changes.
      const again: unknown[][] = [];
      const back = { runId: "d", handler: new RefusesEverything() as never, pins: original.pins, seed: SEED, startedAt: AT, onLog: (l: { values: readonly unknown[] }) => again.push([...l.values]) };
      let error: string | null = null;
      let value: unknown;
      try {
        const r =
          replays === "walker"
            ? await walkResume(source, original.journal, back as never)
            : await resumeOnEngine(source, transform(source).module, original.journal, { ...(back as never), evaluate });
        value = r.value;
      } catch (e) {
        error = (e as { code?: string }).code ?? `${(e as Error).name}: ${(e as Error).message.slice(0, 80)}`;
      }
      ok(`${replays} resumes from the journal the ${wrote} wrote: ${name}`, error === null && j(again) === j(logs) && j(value) === j(original.value), {
        error,
        logs: { first: logs, resumed: again },
        value: { first: original.value, resumed: value },
      });
      crossings += 1;
    }
  }
  console.log(`  (${crossings} journal crossings, each resumed against a handler that refuses every dispatch)`);
}

console.log(`\ndifferential.smoke: ${pass + failures.length} cells, ${pass} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  FAILED: ${f}`);
  process.exitCode = 1;
}
