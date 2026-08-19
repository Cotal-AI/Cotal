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
 *
 * `HELD` IS EMPTY, and this sentence is here because an empty list reads as coverage: nothing is
 * outside the gate for want of a seam member, and the two cells over it therefore assert nothing
 * today. It is kept rather than deleted because the next member to land needs somewhere to be
 * pinned while it is landing, and its count is printed so the emptiness is a number rather than a
 * thing a reader has to notice.
 */
import { resumeOnEngine, runOnEngine } from "../src/engine/host.js";
import { Journal, type JournalEntry } from "../src/journal.js";
import { resume as walkResume, run as walk } from "../src/interpret.js";
import { SimHandler } from "../src/sim.js";
import { ENGINE_LANGUAGE_VERSION, WALKER_LANGUAGE_VERSION, resolvePins } from "../src/pins.js";
import { transform } from "../src/transform/index.js";
import { validate } from "../src/grammar.js";
import { BUILTINS, EFFECT_KINDS, EVENT_CONSTRUCTORS, PRIMITIVES, PURE_PRIMITIVES } from "../src/primitives.js";
import { ADMITTED_NODES } from "../src/syntax.js";
import { assertNoCode } from "../src/values.js";
import { parseModule, unbound } from "./_module-shape.js";
import { parse } from "acorn";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

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
/** Every cell this suite printed, passed or failed, in order. The config audit at the bottom reads it. */
const CELLS: string[] = [];
const ok = (name: string, cond: boolean, extra?: unknown) => {
  CELLS.push(name);
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

/** Which language each engine speaks — the pin every cross-engine refusal below is named for. */
const versionOf = { walker: WALKER_LANGUAGE_VERSION, engine: ENGINE_LANGUAGE_VERSION };

/**
 * What a logged value IS, where JSON cannot say.
 *
 * `JSON.stringify` draws `undefined`, `null`, a FUNCTION, NaN and both infinities all as `null`, so
 * a comparison over the rendering answers "identical" for five different facts — including the one
 * this wave cares about most, a live closure handed to a host where the other arm handed absence.
 * Measured, not reasoned: `log((x) => x)` and `log(o.b)` both render `[[null]]` on the walker.
 *
 * Five decisions here, each on purpose, and the fourth and fifth were lane H's after they ran the
 * first spelling against the pairs it has to separate. `null` is NAMED rather than left as
 * "object", because undefined-versus-null is the distinction this wave leans on hardest (it is why
 * `get`'s cell test is `hasOwn` and not truthiness). NaN and the infinities are named for the same
 * reason they are the problem: JSON draws them as `null` too. NEGATIVE ZERO is named, because JSON
 * draws it as `0` and `0 / -1` is an ordinary program. A container that CARRIES CODE anywhere
 * inside it is named apart from one that does not — a shallow `typeof` drew `{ g: (x) => x }` and
 * `{}` alike, which is the exact pair these rows exist to separate, and it is the NESTED closure
 * rather than the bare one that killed the worker with a DataCloneError. Everything else is bare
 * `typeof`: this stays a SHAPE, one bit per hazard, with no key names, depth or ordering in it, so
 * it never becomes a second serializer with blind spots of its own to argue about.
 *
 * ONE OF THESE FIVE DECISIONS HAS NO MUTANT BEHIND IT, and the reason is worth more than the note.
 * Naming `null` is descriptive, not discriminating: a control can only grade this signature where
 * the RENDERING already calls both arms identical, so a pair that could grade the `null` clause has
 * to be `null` against a value JSON also draws as `null` — and that set is exactly undefined, a
 * function, NaN, +Infinity and -Infinity, every one of them separately named already. `null`
 * against a record diverges a leg earlier, on the rendering. So an unnamed `null` falling to typeof
 * "object" cannot collide with anything, and no mutant for this clause can exist. That is a
 * stronger statement than a measured survivor: a survivor says the suite did not notice, and
 * invites someone to write the missing cell. This says there is no cell to write. The clause stays
 * because it says what the value IS, and a reader who assumes every decision here is graded should
 * learn from this comment that one is not.
 *
 * `carriesCode` CATCHES `assertNoCode` rather than re-implementing it, which is the load-bearing
 * part: that predicate is what the log rule itself is built on, so the signature and the rule
 * cannot drift apart. A hand-rolled walk here — which is what the first version of this file had —
 * is a second answer to "does this carry code", and the first one to change is the one nobody
 * re-reads. It carries its own `seen` set, so a cyclic value costs nothing extra, and arrays come
 * along for free because `typeof []` is "object": `[fn]` and `[undefined]` both render `[null]`.
 */
const carriesCode = (v: unknown): boolean => {
  try {
    assertNoCode(v, "v");
    return false;
  } catch {
    return true;
  }
};

const shapeOf = (v: unknown): string =>
  v === null
    ? "null"
    : Object.is(v, -0)
      ? "-0"
      : typeof v === "number" && Number.isNaN(v)
        ? "NaN"
        : typeof v === "number" && !Number.isFinite(v)
          ? v > 0
            ? "Infinity"
            : "-Infinity"
          : typeof v === "object"
            ? carriesCode(v)
              ? "object+code"
              : "object"
            : typeof v;

const shapes = (logs: readonly (readonly unknown[])[]): string => j(logs.map((line) => line.map(shapeOf)));

/** What an arm answered, as one string: the refusal it raised, or the lines it logged AND their shapes. */
const answer = (a: Arm): string => (a.error !== null ? a.error : `logs ${j(a.logs)} shapes ${shapes(a.logs)}`);

/** Where two arms differ, as the field names. Empty means identical. */
const differences = (a: Arm, b: Arm): string[] => {
  const out: string[] = [];
  // NO PROGRAM REACHES THIS LEG TODAY: a top-level `return` is a validation refusal (L1024), so a
  // validated program's run value is always absence. Kept rather than deleted, because the cell
  // below MEASURES that over the whole corpus — the day a program can produce a value, that cell
  // reds and this line is live evidence again instead of a comparison nobody restored.
  if (j(a.value) !== j(b.value)) out.push("value");
  if (j(a.logs) !== j(b.logs)) out.push("logs");
  // AND WHAT THE RENDERING CANNOT SAY, as its OWN label rather than folded into "logs": a shape-only
  // divergence is one where the line above already answered "identical", so hiding it there would
  // report the difference under a name that had just denied it.
  if (shapes(a.logs) !== shapes(b.logs)) out.push("log shapes");
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

/**
 * A corpus program, its handler script, and WHAT IT MUST DO: the fourth element is the refusal the
 * program is written to produce, and its absence means the program must COMPLETE.
 *
 * Without that split, "identical on both engines" is satisfied by two arms refusing the same thing
 * for a reason nobody wrote the program to test. Measured, and this is why the split exists:
 * `"AB".lower()` and `(2.6).round()` are FREE builtins and not method names, so the curated-methods
 * program errored L4014 on both arms before its first log — a green cell whose subject was never
 * reached, and the only passing cell the string and number tables had.
 */
const CORPUS: readonly (readonly [string, string, object, string?])[] = [
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
  ],
  ["sleep and the run clock", 'await sleep("1m", { name: "s" }); log(now() > 0);', {}],
  ["closures over a for-loop counter", "const fs = []; for (let i = 0; i < 3; i = i + 1) { fs.push(() => i); } let s = 0; for (const f of fs) { s = s + await f(); } log(s);", {}],
  ["a builtin read as a value", "const f = map; log(f([1, 2], (x) => x), map === map, json === json);", {}],
  ["refusals: a non-function callee", "const f = 1; log(f());", {}, "L4011"],
  // STEP KEYS ARE (scope path, kind, name, occurrence), and the corpus has to reach each component
  // or the comparison is over one shape. These four move the occurrence counter, the name, and the
  // scope path a nested call adds.
  ["the same effect twice, so occurrence counts", 'await sleep("1m", { name: "s" }); await sleep("2m", { name: "s" }); log(now());', {}],
  ["an effect in a loop", 'for (const n of ["a", "b", "c"]) { await sleep("1m", { name: n }); } log(now());', {}],
  ["an effect with no name of its own", 'await sleep("1m"); await sleep("2m"); log(now());', {}],
  ["an effect inside a function, called twice", 'const step = async (n) => { await sleep("1m", { name: n }); return now(); }; log(await step("one"), await step("two"));', {}],
  // EVERY EFFECT KIND THAT JOURNALS, because a step key carries the kind and a corpus of sleeps
  // compares one row of the table. `notify` and `monitor` return nothing and still journal.
  [
    "ask, wait and a timed-out wait",
    'const a = await spawn("one");\nconst answer = await ask(a, { name: "q", schema: { days: "number" } });\nconst got = await wait(replied(a), { name: "w", timeout: "5m" });\nconst missed = await wait(replied(a), { name: "w2", timeout: "5m" });\nlog(answer, got, missed);',
    { asks: { q: { value: { days: 2 }, at: 0 } }, events: { w: { value: { ok: true }, at: 0 }, w2: { value: null, at: 0 } } },
  ],
  [
    "notify and monitor, which journal and answer nothing",
    'const a = await spawn("one");\nawait notify([a], { decision: "build", outcome: "blocked" });\nawait monitor([a], { name: "m" });\nlog("done");',
    {},
  ],
  [
    "a checkpoint that expires",
    'const c = await checkpoint("go", "Go?", { timeout: "1m", onExpiry: "proceed" });\nlog(c.status);',
    { checkpoints: { go: { status: "expired", at: 0 } } },
  ],
  [
    "an effect the handler faults",
    'try { const a = await spawn("one"); await turn(a, { name: "t" }); } catch (e) { log(e.code, e.kind); }',
    { turns: { t: { status: "done", at: 0 } }, faults: [{ at: "turn:t#0", kind: "agent", code: "E_AGENT" }] },
  ],
  [
    "effects before a refusal, so the journal is a prefix",
    'const a = await spawn("one");\nawait sleep("1m", { name: "s" });\nconst o = {};\nlog(o + 1);',
    {},
    "L4018",
  ],
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
  // MEASURED, not assumed: `lower` and `round` are free builtins and not method names, so the
  // program this cell used to run refused L4014 at `"AB".lower()` before its first log — the string
  // and number tables had no passing cell at all. These are their real entries.
  ["curated methods", 'const xs = [3, 1, 2]; log(xs.map((x) => x + 1), sort(xs), "AB".toLowerCase(), "a,b".split(","), (2.6).toFixed(1), json.stringify({ a: 1 }));', {}],
  ["optional chains", "const o = { a: { b: 1 } }; log(o.a?.b, o.z?.b, o.z?.b.c);", {}],
  // ORDER, WHICH IS WHAT A STEP KEY RECORDS. Both of these journal two sleeps, and the only thing
  // that distinguishes a correct engine from one that evaluates the right side first is which entry
  // is which. A value-only comparison would pass either way: 1 + 1 is 2 whichever sleep ran first.
  ["two effects in one binary expression", 'const f = async (n) => { await sleep("1m", { name: n }); return 1; }; log(await f("a") + await f("b"));', {}],
  ["two effects in one argument list", 'const f = async (n) => { await sleep("1m", { name: n }); return n; }; log(await f("a"), await f("b"));', {}],
  ["two effects in one array literal", 'const f = async (n) => { await sleep("1m", { name: n }); return n; }; log([await f("a"), await f("b")]);', {}],
  ["two effects in one object literal", 'const f = async (n) => { await sleep("1m", { name: n }); return n; }; log({ p: await f("a"), q: await f("b") });', {}],
  ["two effects in one template", 'const f = async (n) => { await sleep("1m", { name: n }); return n; }; log(`${await f("a")}-${await f("b")}`);', {}],
  ["a member write whose key and value are both effects", 'const f = async (n) => { await sleep("1m", { name: n }); return n; }; const o = {}; o[await f("a")] = await f("b"); log(o);', {}],
  ["a compound assignment whose right side is an effect", 'const f = async (n) => { await sleep("1m", { name: n }); return 1; }; let t = 0; t += await f("a"); t += await f("b"); log(t);', {}],
  // SHORT CIRCUIT IS AN ORDER FACT TOO: the effect on the skipped side must not be journalled at all.
  ["a logical operator that skips an effect", 'const f = async (n) => { await sleep("1m", { name: n }); return true; }; const a = false && (await f("skipped")); const b = true || (await f("also-skipped")); const c = true && (await f("taken")); log(a, b, c);', {}],
  ["a conditional that skips an effect", 'const f = async (n) => { await sleep("1m", { name: n }); return n; }; log(1 === 1 ? await f("taken") : await f("skipped"));', {}],
  ["an effect in a loop header, once per pass", 'const f = async (n) => { await sleep("1m", { name: n }); return n; }; let n = 0; while (n < 2 && (await f("c")) === "c") { n = n + 1; } log(n);', {}],
  ["a for-of over an array two effects built", 'const f = async (n) => { await sleep("1m", { name: n }); return n; }; let out = ""; for (const x of [await f("a"), await f("b")]) { out = out + x; } log(out);', {}],
  ["nested calls, inner effect first", 'const f = async (n) => { await sleep("1m", { name: n }); return n; }; const g = async (x) => x + "!"; log(await g(await f("inner")));', {}],
  ["the undefined value", "const u = undefined; log(u === undefined);", {}],
  ["deep recursion", "const f = (n) => (n === 0 ? 0 : n + f(n - 1)); log(await f(50));", {}],
  ["a template that must refuse a record", "const o = { a: 1 }; log(`x=${o}`);", {}, "L4018"],
  ["a template over every scalar", "log(`${null} ${undefined} ${true} ${1.5} ${\"s\"}`);", {}],
  ["an index past the end", "const xs = [1]; log(xs[5]);", {}],
  ["a record shared into a function and written there", "const o = { a: 1 }; const f = async (r) => { r.a = 2; }; await f(o); log(o.a);", {}],
  ["string methods", 'log("Ab Cd".trim(), "a,b".split(","), "abc".slice(1), "ab".repeat(2), "abc".includes("b"), "a-b".replace("-", "+"));', {}],
  ["array methods", "const xs = [3, 1, 2]; log(xs.filter((x) => x > 1), xs.join(\"-\"), xs.at(0), [[1], [2]].flat(), await xs.reduce((a, b) => a + b, 0));", {}],
  ["number edge cases", "log(1 / 0, 0 / 0, -0, 2 ** 53 + 1, round(2.5), floor(2.4));", {}],
  ["a json round trip", "log(json.parse(json.stringify({ a: [1, { b: null }] })));", {}],
  // THE FREE SURFACE, so the coverage cell at the bottom has something to be satisfied by. The pure
  // draws are the sharpest of these: `random`, `randomInt` and `pick` derive from the run seed AND
  // the frame's key PATH, so they agree across engines only if the frames agree about where in the
  // program they are.
  ['the record builtins', 'const o = { a: 1, b: 2 }; log(keys(o), values(o), entries(o), has(o, "a"), merge(o, { c: 3 }));', {}],
  [
    "the array builtins",
    "const xs = [3, 1, 2, 1]; log(find(xs, (x) => x > 2), some(xs, (x) => x > 2), every(xs, (x) => x > 0), reverse(xs), unique(xs), range(3), sum(xs), concat(xs, [9]));",
    {},
  ],
  ["the string builtins", 'log(startsWith("abc", "a"), endsWith("abc", "c"), contains("abc", "b"), upper("ab"), lower("AB"));', {}],
  ["the number builtins", 'log(min(1, 2), max(1, 2), abs(-3), ceil(1.2), parseNumber("42"));', {}],
  ["assert, refusing and passing", 'try { assert(false, "nope"); } catch (e) { log(e.code); } assert(true, "fine"); log("past");', {}],
  ["the seeded pure draws", 'log(random(), randomInt(10), pick([1, 2, 3]), duration("1m"));', {}],
  ["a pure draw inside a function, twice", "const d = () => random(); log(await d(), await d());", {}],
  ["this run's own metadata", "const r = run(); log(r.startedAt > 0, len(r.programHash) > 0);", {}],
  // F6, ALL OF IT, held out of this corpus until lane H's host landed (d556c504) and moved up here
  // in the same change: the flag, the chain the host finishes, and the argument that must not run.
  ["an optional call on a member", "const o = { m: () => 1 }; log(await o.m?.(), await o.z?.());", {}],
  [
    "an optional call's chain, finished by the host",
    'const o = { m: () => ({ x: { y: 2 } }) }; const z = {}; log(o.m?.().x.y, z.q?.().x.y, o.m?.()?.x, z.q?.().trim());',
    {},
  ],
  // THE JOURNAL IS THE EVIDENCE HERE, not the log: the short-circuited call's argument never runs,
  // so this program journals ONE sleep and not two. An eager argument list would journal both, and
  // a resume would replay a step the walker's run never wrote.
  [
    "an optional call evaluates no argument when it short-circuits",
    'const o = { m: (v) => v }; const z = {}; log(await o.m?.(await sleep("1s", { name: "s" })), await z.q?.(await sleep("2s", { name: "t" })));',
    {},
  ],
  ["an optional call on a member that returns undefined", "const o = { m: () => undefined }; try { log(o.m?.().x); } catch (e) { log(e.code); }", {}],
  // THE CONCURRENCY SCOPES, held until the engine's scope call path landed (d556c504). The keyed
  // fan-out is the one that fans out: without `key` the walker refuses L3021 before it reaches the
  // scope at all, which is the refusing-fixture class and is carried as its own declared refusal.
  [
    "a fan-out over one agent",
    'const a = await spawn("one");\nconst rs = await fanOut([a], (m) => turn(m, { name: "t" }), { name: "f", key: (m) => m.agent });\nlog(len(rs));',
    { turns: { t: { status: "done", at: 0 } } },
  ],
  ["a fan-out with no stable key", 'const a = await spawn("one");\nawait fanOut([a], (m) => turn(m, { name: "t" }), { name: "f" });', { turns: { t: { status: "done", at: 0 } } }, "L3021"],
  // A MEMBER WRITE HAS TO TRAVEL THROUGH `set`, and until these two nothing in the corpus said so: a
  // native `o[k] = v` emission left every corpus program green and showed up only as a declared
  // divergence. Both refusals are the write path's own - the curated table on the key, the receiver
  // law on a non-record - and neither is reachable from a read.
  ["refusals: a curated key on the write path", 'const o = {}; o.__proto__ = { a: 1 }; log("after");', {}, "L4014"],
  ["refusals: a member written onto a non-record", 'const s = "ab"; s.x = 1; log("after");', {}, "L4010"],
  // AND THE SAME RECEIVER WITH THE ONE KEY THAT HAS A RULE OF ITS OWN: measured identical, both
  // arms L4010, so the receiver law is decided before the thenable law and the order is not a
  // divergence here. It is one line above, where the receiver IS a record.
  ["refusals: a callable then written onto a non-record", '"x".then = () => 1; log("after");', {}, "L4010"],
  // A LOG LINE IS DATA ON THE ENGINE, and the three refusing doors are declared divergences below;
  // this is their mirror, so the engine's rule is not read as "log refuses whatever is unusual":
  // absence and NaN are values, not functions, and both arms log them as they are. The trace is
  // not the journal.
  ["absence and NaN are data, and still log", "const o = { a: 1 }; log(o.b, 0 / 0);", {}],
  // AND THE VALUES JSON CANNOT DRAW, as programs rather than as hand-built control pairs. Measured
  // on both arms: `0 / -1`, `-0` and `0 * -1` are all a true negative zero, and dividing into one
  // gives -Infinity, so the shape leg has live evidence in the corpus and not only in its controls.
  // Both render as `0` and `null`; only the shapes say which value crossed.
  ["negative zero, three ways to reach it", "log(0 / -1, -0, 0 * -1);", {}],
  ["and the sign it carries, read back out", "const n = 0 / -1; log(1 / n);", {}],
  // AND THE SAME QUESTION WHERE THE RECEIVER IS AN ARRAY, which was the divergence this row was
  // written as: the walker answered L4014 and the engine L4018, because the engine asked the value's
  // rule before the member rule. Ruled - target-kind, then the freeze, then that kind's member rule,
  // then the value - and reordered on the engine at 2b5ac15f, so both arms now answer L4014 and this
  // is a corpus row rather than a declared divergence. `then` is not a member of an array any more
  // than `foo` is, whatever is being written into it.
  ["refusals: a callable then written onto an array", 'keys({ a: 1 }).then = () => 1; log("after");', {}, "L4014"],
  ["refusals: a non-member written onto an array, the control", 'keys({ a: 1 }).foo = 1; log("after");', {}, "L4014"],
  // AND THE VALUE LAW ON A RECORD, which is what all of the rows above are pointed at and what none
  // of them could reach. These six were NOT COMPARABLE until #657. The walker had no gate on the way
  // in, so writing a callable `then` onto a record completed there while the engine refused - three
  // declared divergences - and the ones that went on to touch the record afterwards took the
  // oracle's own PROCESS down, which is a third thing again and is why they sat in a quarantine
  // instead of a list. #657 gave the walker the rule at its four record-member write sites and the
  // engine adopted the walker's code, so all six now refuse L4021 on both arms. Measured before
  // they were moved, and the part a shared code does not buy on its own: empty log and an EMPTY
  // JOURNAL on both arms, so the prefixes are equal and not only the answers. Both spellings of the
  // key, because it is the one thing a reader expects to change the answer and it does not; and the
  // two branch names, because a branch called `then` makes the scope's own result record awaitable
  // and the refusal has to land on the argument literal, ahead of the scope digest - one entry
  // written there and these two rows would diverge on entry count with the same code on both arms.
  ["refusals: a callable then written onto a record", 'const o = {}; o.then = (r) => { r(1); }; log("after");', {}, "L4021"],
  ["refusals: a callable then written onto a record, computed", 'const o = {}; const k = "then"; o[k] = (r) => { r(1); }; log("after");', {}, "L4021"],
  ["refusals: a callable then and nothing after it", "const o = {}; o.then = (r) => { r(1); };", {}, "L4021"],
  ["refusals: a callable then, then a later reference to the record", 'const o = {}; o.then = (r) => { r(1); }; log("t", typeof o.then);', {}, "L4021"],
  ["refusals: a scope branch named then", 'await parallel({ then: async () => 1 }, { name: "p" });', {}, "L4021"],
  ["refusals: a race branch named then, where one arm is enough", 'await race({ then: async () => 1, b: async () => 2 }, { name: "r" });', {}, "L4021"],
  // AND THE FREEZE, which stands AHEAD of the member rule (H measured the order on the walker; this
  // is the shape that shows it as a program). A record handed to a host effect is frozen from then
  // on, and after that BOTH writes are L2031: the member the array does not have, which was L4014
  // one line above, and the member it does have, which completed before it was shared. Without the
  // last two rows "L2031" would just be L4014 wearing another code.
  [
    "refusals: a member written onto a record the host has seen",
    'const a = await spawn("w", { name: "a" });\nconst sch = { xs: keys({ a: 1 }) };\nawait ask(a, { name: "q", schema: sch });\nsch.xs.foo = 1;',
    { asks: { q: { value: { days: 2 }, at: 0 } } },
    "L2031",
  ],
  [
    "refusals: even a member it HAS, once the host has seen it",
    'const a = await spawn("w", { name: "a" });\nconst sch = { xs: keys({ a: 1 }) };\nawait ask(a, { name: "q", schema: sch });\nsch.xs[0] = "z";',
    { asks: { q: { value: { days: 2 }, at: 0 } } },
    "L2031",
  ],
  ["the same member written before the host saw it, the control", 'const sch = { xs: keys({ a: 1 }) };\nsch.xs[0] = "z";\nlog(sch.xs[0]);', {}],
  // The one admitted node type the gate never spelled, found by the coverage cell below rather than
  // by reading the corpus. An unbraced body is L1009, so a stray `;` between statements is the only
  // spelling the validator admits, and it is what the emitter has to carry through unchanged.
  ["an empty statement", "; let i = 0; while (i < 2) { i = i + 1; }; log(i);", {}],
  // F7 OVER WRITES, ruled after the read half: the same predicate, the same hoisted record, and
  // `set` carrying the binding name so the early write refuses instead of landing silently. Held
  // until 4f7b994c, and all four shapes the walker distinguishes are compared, not just the loud one.
  // NAMED "plainly" ON PURPOSE: bare, this row's name is a PREFIX of the two below it, and an
  // expectRed is matched as a substring - so a mutant aimed here would report a kill off either of
  // them. A cell name that is a prefix of a sibling is an ambiguous anchor, not just an untidy one.
  ["a dead-zone write, plainly", "const f = () => { n = 1; }; f(); let n = 0; log(n);", {}, "L2004"],
  ["a dead-zone write from a hoisted function", "function f() { n = 2; } f(); let n = 1; log(n);", {}, "L2004"],
  ["a dead-zone write the program catches, after which the declaration still initialises", 'function f() { n = 2; } try { f(); } catch (e) { log(e.code, e.kind); } let n = 1; log(n);', {}],
  ["a compound dead-zone write, refused after its read", 'function f() { n += 2; } try { f(); } catch (e) { log(e.code); } let n = 1; log(n);', {}],
  ["the same write once the declaration has run", "function f() { n = 2; } let n = 1; f(); log(n);", {}],
  // F7 RETIRED, both halves landed: the transform classifies the dead zone as a cell and reads it by
  // name, the host answers L2004 for an absent own `v`. Held until 93bab769, compared from here on.
  ["a temporal dead zone", "const f = () => x; const r = f(); const x = 1; log(r);", {}, "L2004"],
  ["a temporal dead zone the program catches", 'const f = () => x; try { log(f()); } catch (e) { log(e.code, e.kind); } const x = 1;', {}],
  // AND THE MIRROR: the OPTIONS BAG is evaluated BEFORE the scope. `sleep:warm` lands ahead of
  // `fanOut:f` here, so an emission that deferred everything (rather than the ruled position alone)
  // reds on order in this program while the one below stays green.
  [
    "a fan-out whose key is awaited",
    'const a = await spawn("one");\nconst keyer = async () => { await sleep("1m", { name: "warm" }); return (m) => m.agent; };\nawait fanOut([a], (m) => turn(m, { name: "t" }), { name: "f", key: await keyer() });\nlog("done");',
    { turns: { t: { status: "done", at: 0 } } },
  ],
  // AND THE BODY IS EVALUATED INSIDE THE SCOPE. Both arms journal `fanOut:f` BEFORE `sleep:warm`,
  // which is what says the body travelled unevaluated: an eager one would have journalled its sleep
  // before the scope entry it belongs inside.
  [
    "a fan-out whose body is awaited",
    'const a = await spawn("one");\nconst choose = async () => { await sleep("1m", { name: "warm" }); return (m) => turn(m, { name: "t" }); };\nawait fanOut([a], await choose(), { name: "f", key: (m) => m.agent });\nlog("done");',
    { turns: { t: { status: "done", at: 0 } } },
  ],
  [
    "a conclave",
    'const a = await spawn("one");\nawait conclave([a], async (c) => { await notify([a], { decision: "join", outcome: "done" }); return c; }, { name: "k" });\nlog("done");',
    {},
  ],
  [
    "a conclave whose body is awaited",
    'const a = await spawn("one");\nconst body = async (c) => { await notify([a], { decision: "join", outcome: "done" }); return c; };\nawait conclave([a], await (async () => { await sleep("1m", { name: "warm" }); return body; })(), { name: "k" });\nlog("done");',
    {},
  ],
  ["a race, whose losers are digested", 'const r = await race({ a: async () => "a", b: async () => "b" }, { name: "r" });\nlog(r.index);', {}],
  ["a scope combinator", 'await parallel({ one: () => sleep("1m", { name: "one" }), two: () => sleep("2m", { name: "two" }) }, { name: "both" });', {}],
  // The identical half of issue 647 below: `len` of a FREE builtin is 0 on both arms, so only a
  // program-defined function diverges. Without this the divergence reads as "len of a function",
  // which is wider than what was measured.
  ["len of a free builtin", "log(len(map), len(len));", {}],
  [
    "the event constructors",
    'const a = await spawn("one"); const c = channel("t"); log(message(c), idle(a), down(a), replied(a));',
    {},
  ],
  // A RECORD HAS NO PROTOTYPE TO REACH, so these three are undefined rather than refused - measured,
  // because the cell that assumed a refusal here was the one a mutation walked straight past.
  ["a record has no prototype to reach", "const o = { a: 1 }; log(o.constructor, o.toString, o.__proto__);", {}],
  ["refusals: a prototype member of a string", 'const s = "a"; log(s.constructor);', {}, "L4020"],
  ["refusals: a prototype member of an array", "const xs = [1]; log(xs.constructor);", {}, "L4020"],
  ["refusals: a member of a function", "const f = () => 1; log(f.call);", {}, "L4014"],
  ["an array's length is a member, not a prototype reach", "const xs = [1, 2]; log(xs.length);", {}],
  ["refusals: a method is not a value", "const xs = [1]; const m = xs.map; log(m);", {}, "L4020"],
  ["refusals: no implicit conversion", "const o = {}; log(o + 1);", {}, "L4018"],
  ["refusals: not iterable", "const o = {}; log([...o]);", {}, "L4015"],
];

/** Every journal kind an ENGINE run of a corpus program actually wrote, for the coverage cell. */
const reachedKinds = new Set<string>();

{
  let identical = 0;
  let completes = 0;
  const wrong: string[] = [];
  const valued: string[] = [];
  for (const [name, source, script, refuses] of CORPUS) {
    const [w, e] = [await arm("walker", source, script), await arm("engine", source, script)];
    const diff = differences(w, e);
    ok(`identical on both engines: ${name}`, diff.length === 0, {
      differs: diff,
      walker: { value: w.value, logs: w.logs, error: w.error, entries: w.entries.length },
      engine: { value: e.value, logs: e.logs, error: e.error, entries: e.entries.length },
    });
    if (refuses === undefined) {
      if (w.error === null && e.error === null) completes += 1;
      else wrong.push(`${name}: must complete, refused ${w.error ?? "(walker ok)"} / ${e.error ?? "(engine ok)"}`);
    } else if (w.error !== refuses || e.error !== refuses) {
      wrong.push(`${name}: declared ${refuses}, got ${w.error} / ${e.error}`);
    }
    for (const entry of e.entries) reachedKinds.add(entry.kind);
    if (w.value !== undefined || e.value !== undefined) valued.push(`${name}: ${j(w.value)} / ${j(e.value)}`);
    identical += 1;
  }
  // AND EACH ONE DID WHAT IT WAS WRITTEN TO DO. A program that refuses before it reaches its subject
  // agrees with itself on both arms and tests nothing; this is the cell that catches that class.
  ok("every corpus program completes, or refuses the code it declares", wrong.length === 0, wrong);
  // AND THE COMPARATOR'S `value` LEG HAS NO PROGRAM BEHIND IT. A top-level `return` is L1024, so a
  // validated program's run value is absence and the leg can only be exercised by hand. Measured
  // here rather than reasoned: when a program can produce a value this reds, and the leg it guards
  // stops being a comparison nobody can reach.
  ok("no validated program produces a run value, so the comparator's value leg is exercised by hand alone", valued.length === 0, valued);
  console.log(`  (${identical} programs identical on both engines: ${completes} complete, ${identical - completes} refuse a declared code)`);
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
  // BUILT BY HAND, and the name says so: no program produces a run value today (the cell above
  // measures that), so this is the only thing that exercises the comparator's `value` leg.
  found("value, built by hand because no program produces one", { ...base, value: "perturbed" }, "value");
  found("log line", { ...base, logs: [["perturbed"]] }, "logs");
  found("refusal", { ...base, error: "L9999" }, "error");
  found("entry count", { ...base, entries: base.entries.slice(1) }, "entry count");
  found("entry order", { ...base, entries: [...base.entries].reverse() }, "entry 0");
  found("step key", { ...base, entries: [{ ...(base.entries[0] as JournalEntry), name: "perturbed" }, base.entries[1] as JournalEntry] }, "entry 0");

  // AND THE LEG THAT ONLY EXISTS BECAUSE THE RENDERING LIES. These four pairs render IDENTICALLY —
  // `JSON.stringify` draws undefined, null, a function, NaN and both infinities all as `null`, and
  // a record carrying a function exactly as an empty one — so the `logs` leg says nothing and the
  // whole difference has to be found by shape. Without this cell the new leg would be a claim about
  // an empty set: every corpus row passes it today, which is precisely when a check cannot show it
  // can fail. The pairs are the five values, and the nesting the shallow version could not see.
  const shapeOnly = (label: string, left: unknown[][], right: unknown[][]) => {
    const a = { ...base, logs: left };
    const b = { ...base, logs: right };
    const d = differences(a, b);
    ok(`the comparator finds a difference the rendering cannot show: ${label}`, !d.includes("logs") && d.includes("log shapes"), {
      rendered: [j(left), j(right)],
      shapes: [shapes(left), shapes(right)],
      differences: d,
    });
  };
  shapeOnly("absence against a literal null", [[undefined]], [[null]]);
  shapeOnly("absence against a live closure, which is the hazard the log rule exists for", [[undefined]], [[(x: number) => x]]);
  shapeOnly("absence against NaN", [[undefined]], [[Number.NaN]]);
  shapeOnly("NaN against Infinity", [[Number.NaN]], [[Number.POSITIVE_INFINITY]]);
  shapeOnly("an empty record against one carrying a function, which is the nesting a shallow signature missed", [[{}]], [[{ g: (x: number) => x }]]);
  shapeOnly("an array of absence against an array carrying code, which renders the same either way", [[[undefined]]], [[[(x: number) => x]]]);
  shapeOnly("zero against negative zero, which `0 / -1` produces in an ordinary program", [[0]], [[-0]]);
  // AND THE NEGATIVE HALF: the shape leg must not report a difference where there is none, or it
  // would red every row in the suite and mean nothing.
  ok("and reports no shape difference between two arms that logged the same values", !differences({ ...base, logs: [[1, "a", null]] }, { ...base, logs: [[1, "a", null]] }).includes("log shapes"));
}

// ---- what a ruling made different, on purpose ----------------------------------------------------

/**
 * A divergence a ruling DECLARED, with the answer both arms give.
 *
 * Pinned to both answers rather than to "these differ": a divergence retired upstream must red this
 * suite the day it lands, so it is removed in the same change instead of being remembered.
 */
const DIVERGENT: readonly (readonly [string, string, object, string, string])[] = [
  // Ruling 1c's one declared divergence, in both of its shapes. The walker reads an update's
  // operand through a bare `Number(...)`, so a record is NaN and the string "5" increments to 6;
  // the engine refuses L4018, because silent coercion is the class this language refuses
  // everywhere else and rebuilding a wart for fidelity is not a goal. Filed as issue 646 — and
  // when it lands the walker starts refusing, these cells red, and the divergence is retired here
  // rather than remembered.
  ["ruling 1c / issue 646: an update's operand is a record", "const o = { c: {} }; o.c++; log(o.c);", {}, 'logs [[null]] shapes [["NaN"]]', "L4018"],
  ["ruling 1c / issue 646: an update's operand is a numeric string", 'let n = "5"; n++; log(n);', {}, 'logs [[6]] shapes [["number"]]', "L4018"],
  // Ruling 1c's second declared divergence, issue 647: `len` of a PROGRAM-DEFINED function. Neither
  // number is the program's arity — each arm reports the arity of its own closure wrapper, the
  // walker's `(frame, args)` pair and the engine's rest parameter — which the cell below measures
  // rather than asserts. Pinned to both answers, so whichever way the issue is settled this reds.
  ["ruling 1c / issue 647: `len` of a program function", "log(len((x) => x));", {}, 'logs [[2]] shapes [["number"]]', 'logs [[0]] shapes [["number"]]'],
  ["ruling 1c / issue 647: `len` of a hoisted function declaration", "function f(a, b) { return a; } log(len(f));", {}, 'logs [[2]] shapes [["number"]]', 'logs [[0]] shapes [["number"]]'],
  // A LOG LINE IS DATA ON THE ENGINE: its log sink refuses a function anywhere inside a logged value,
  // L4016 naming the value and the path, before the line reaches any transport (the worker cannot
  // even clone one - measured, it died on a host DataCloneError with the emitted module body in the
  // message). The WALKER hands its log values to the host as they are and is left that way on
  // purpose: it replays every run recorded under language version 1, and a v1 record that logs a
  // builtin must replay as recorded (journal.smoke replays a checked-in one). So this is a rule of
  // the engine, declared here with both answers - the walker's is what the comparator's JSON view
  // makes of a live closure. Three doors: the value itself, a function nested in a record, and a
  // namespace, which is a record of them.
  ["a log line is data on the engine: a function value", "log((x) => x);", {}, 'logs [[null]] shapes [["function"]]', "L4016"],
  ["a log line is data on the engine: a record carrying a function", 'log("v", { g: (x) => x });', {}, 'logs [["v",{}]] shapes [["string","object+code"]]', "L4016"],
  ["a log line is data on the engine: a namespace", "log(json);", {}, 'logs [[{}]] shapes [["object+code"]]', "L4016"],
];

{
  for (const [name, source, script, walkerAnswer, engineAnswer] of DIVERGENT) {
    const [w, e] = [await arm("walker", source, script), await arm("engine", source, script)];
    ok(`declared divergence, and both answers are what the ruling says: ${name}`, answer(w) === walkerAnswer && answer(e) === engineAnswer, {
      walker: answer(w),
      engine: answer(e),
      expected: { walker: walkerAnswer, engine: engineAnswer },
    });
  }
  console.log(`  (${DIVERGENT.length} declared divergence(s))`);

  // WHY 647 IS A LEAK AND NOT A DISAGREEMENT ABOUT ARITY. Measured on the oracle: the walker answers
  // 2 for a function of zero, one and three parameters alike, so it is reading its own wrapper and
  // not the program's function; the engine's rest-parameter wrapper reads 0 the same way. The day
  // the issue is settled, the cells above red — and this one says what the answer has to be about.
  const arities: string[] = [];
  for (const source of ["log(len(() => 1));", "log(len((x) => x));", "log(len((a, b, c) => 1));"]) {
    const a = await arm("walker", source, {});
    arities.push(a.error !== null ? a.error : j(a.logs));
  }
  ok("issue 647: neither arm's answer depends on the function's own arity", j(arities) === j([j([[2]]), j([[2]]), j([[2]])]), arities);
}

// ---- the step budget counts a different thing on each engine ------------------------------------

{
  // languageVersion 2's pin-unit change, held by measurement rather than by a sentence. `stepBudget`
  // bounds ONE WALK and is not journalled, so the walker counts its own dispatches while the engine
  // counts transformed-site hits — the same program, two numbers, neither wrong. What must be true
  // is that the difference NEVER REACHES THE JOURNAL, and that a budget between the two numbers is a
  // divergence that is declared rather than discovered.
  const source = "let n = 0; while (n < 20) { n = n + 1; } log(n);";
  const both = async (stepBudget?: number) => {
    const out: { steps: number; error: string | null; entries: number; logs: unknown[][] }[] = [];
    for (const kind of ["walker", "engine"] as const) {
      const logs: unknown[][] = [];
      const options = {
        runId: "b",
        handler: new SimHandler({}),
        journal: new Journal({ run: "b" }),
        seed: SEED,
        startedAt: AT,
        onLog: (l: { values: readonly unknown[] }) => logs.push([...l.values]),
        ...(stepBudget !== undefined ? { stepBudget } : {}),
      };
      try {
        const r = kind === "walker" ? await walk(source, options) : await runOnEngine(source, transform(source).module, { ...options, evaluate });
        out.push({ steps: r.steps, error: null, entries: r.journal.entries().length, logs });
      } catch (e) {
        out.push({ steps: -1, error: (e as { code?: string }).code ?? "?", entries: 0, logs });
      }
    }
    return out as [(typeof out)[0], (typeof out)[0]];
  };

  const [w, e] = await both();
  ok("both engines finish the program at the default budget", w.error === null && e.error === null, { walker: w.error, engine: e.error });
  ok("and the unit difference does not reach the journal or the log", j(w.logs) === j(e.logs) && w.entries === e.entries, {
    logs: [w.logs, e.logs],
    entries: [w.entries, e.entries],
  });
  ok("the two engines charge the same program different numbers of steps", w.steps !== e.steps, { walker: w.steps, engine: e.steps });
  console.log(`  (the same program: ${w.steps} walker dispatches, ${e.steps} transformed-site hits)`);

  // A budget strictly between the two counts. Declared, and pinned to BOTH answers: if the units
  // ever converge this cell reds and the divergence is retired rather than remembered.
  const between = Math.floor((Math.min(w.steps, e.steps) + Math.max(w.steps, e.steps)) / 2);
  const [wb, eb] = await both(between);
  ok("declared divergence: a budget between the two counts refuses on one engine and not the other", wb.error === "L4013" && eb.error === null, {
    budget: between,
    walker: wb.error,
    engine: eb.error ?? `finished in ${eb.steps}`,
  });
}

// ---- what the engine cannot run yet --------------------------------------------------------------

/** What each arm answers today, pinned so a DIFFERENT wrong answer reds the hold instead of keeping it. */
interface HeldAnswers {
  readonly walker: string;
  readonly engine: string;
}

/**
 * A program held OUT of the corpus, and the refusal that holds it there.
 *
 * Not a comment and not a silent omission: each entry names the substring the engine fails with
 * today, so landing the missing piece turns this cell red and the program moves up into the corpus
 * in the same change. A held list with no assertion is a coverage cap nobody can see.
 */
const HELD: readonly (readonly [string, string, object, readonly string[], HeldAnswers, string])[] = [
];
{
  for (const [name, source, script, expected, pinned, why] of HELD) {
    const [w, e] = [await arm("walker", source, script), await arm("engine", source, script)];
    const diff = differences(w, e);
    // BOTH ARMS' ANSWERS, not only the field names that differ. Pinned to the fields alone, a hold
    // stays green when the engine starts refusing something ELSE and still differs — the hold would
    // then be recording a fact about the wrong defect. This is the same rule DIVERGENT carries.
    ok(`held out of the corpus, and still differing exactly as it is held: ${name}`, j(diff) === j(expected) && answer(w) === pinned.walker && answer(e) === pinned.engine, {
      differs: diff,
      expected,
      answers: { walker: answer(w), engine: answer(e) },
      pinned,
      why,
    });
  }
  console.log(`  (${HELD.length} program(s) held out of the corpus, each pinned to both arms' answers)`);
}

// ---- what the ORACLE's own process used to not survive -------------------------------------------

/**
 * The three programs ruling 1a quarantined, checked from OUTSIDE the suite for the opposite fact.
 *
 * The quarantine is empty: #657 gave the walker its record-member rule, and all three now refuse
 * L4021 to their caller instead of taking the interpreter's own process down - so they are corpus
 * rows above, compared arm against arm like anything else. This section is what replaces the
 * quarantine rather than what is left of it, and it is NOT symmetry: a corpus row runs its program
 * IN THIS PROCESS, and the three ways these used to fail are all ways that a corpus row cannot
 * report. Measured, at the sha before the walker's rule landed: the set door died on an uncaught
 * RuntimeFault that escaped the caller's `try` and killed the process, and BOTH branch-name doors
 * never settled at all - a branch called `then` makes the scope's result record awaitable, so the
 * interpreter's await waits on a promise nothing resolves. Two of those hang this suite forever
 * and the third takes it down mid-run; none of them reds a cell. A child process's exit code is
 * still the only place the fact is observable, so the mechanism stays and the assertion inverts.
 *
 * Two clauses, both load-bearing. The exit code says the process SURVIVED. The printed refusal says
 * the failure reached the caller as a catchable throw carrying the ruled code - which is the part a
 * surviving process does not prove on its own, and the part the corpus rows depend on.
 */
const SURVIVED: readonly (readonly [string, string])[] = [
  ["issue 642 through the set door: a callable then, then any later reference to the record", "refusals: a callable then, then a later reference to the record"],
  ["issue 642 through the branch-name door: a scope branch named then", "refusals: a scope branch named then"],
  ["the same door on a race, where one arm is enough", "refusals: a race branch named then, where one arm is enough"],
];
{
  const child = new URL("./walker-child.ts", import.meta.url).pathname;
  for (const [name, row] of SURVIVED) {
    // THE SECOND ELEMENT IS A CORPUS ROW'S NAME, NOT A PROGRAM. Written out as a literal it was a
    // second copy of the same source, and nothing made the copies stay equal — so an edit to the
    // corpus row would leave this checking a program the gate no longer runs, and PASSING while it
    // did. That is the worst shape available here: what this section guards is the corpus row
    // hanging the suite, so a silent drift turns the guard into a green cell above a hang. One copy
    // of each program, looked up by name, and a cell of its own for the lookup.
    const entry = CORPUS.find(([n]) => n === row);
    ok(`the survival check names a corpus row that still exists, so the two cannot drift apart: ${name}`, entry !== undefined, { names: row });
    const source = entry === undefined ? "" : entry[1];
    const run = spawnSync(process.execPath, ["--import", "tsx", child, source], { encoding: "utf8" });
    const out = `${run.stdout}${run.stderr}`;
    ok(`the oracle's own process survives it, and hands the refusal back to its caller: ${name}`,
      run.status === 0 && out.includes("REFUSED L4021"),
      { status: run.status, out: out.slice(0, 160) });
  }
  console.log(`  (${SURVIVED.length} program(s) the oracle used to die on, checked in a child because a regression HANGS this suite rather than reding it)`);
}

// ---- one journal, one engine: each arm resumes its own and refuses the other's -----------------

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
 * one and is not — measured, four of the five programs below RUN TO COMPLETION against it (only the
 * unscripted turn refuses, L6001), so eight of the ten crossings would have proved nothing while
 * reading as though they proved everything.
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

  // A JOURNAL IS REPLAYABLE BY THE ENGINE THAT WROTE IT, AND BY NO OTHER ONE.
  //
  // Both halves are asserted here for every resumable program, because the version split made them
  // opposite answers to the same question and each is worthless alone. Within an engine the journal
  // is still a journal: the resume reads it, dispatches nothing, and lands on the same logs and the
  // same value. Across engines it is refused BY NAME - v1 and v2 are different languages (log is
  // data in one and not the other, and a step is a different unit), so a record replayed by an
  // engine that does not speak its language is exactly what the pin exists to stop. Asserting only
  // the refusal would leave this gate with no proof that a journal can be resumed at all; asserting
  // only the replay would let the split pass unnoticed.
  const resumeOn = async (
    on: "walker" | "engine",
    source: string,
    journal: Journal,
    pins: Awaited<ReturnType<typeof walk>>["pins"],
    sink: unknown[][],
  ) => {
    const back = { runId: "d", handler: new RefusesEverything() as never, pins, seed: SEED, startedAt: AT, onLog: (l: { values: readonly unknown[] }) => sink.push([...l.values]) };
    try {
      const r =
        on === "walker"
          ? await walkResume(source, journal, back as never)
          : await resumeOnEngine(source, transform(source).module, journal, { ...(back as never), evaluate });
      return { value: r.value as unknown, fault: null as null | { code?: string; recorded?: unknown; supplied?: unknown } };
    } catch (e) {
      return { value: undefined as unknown, fault: e as { code?: string; recorded?: unknown; supplied?: unknown } };
    }
  };

  let replays = 0;
  let refusals = 0;
  for (const [name, source, script] of RESUMABLE) {
    for (const [wrote, other] of [
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
        continue;
      }

      // The pins travel with the journal. Re-resolving them would be a different run wearing this
      // one's history: the epoch moves to the resuming host and every pure draw changes.
      const again: unknown[][] = [];
      const own = await resumeOn(wrote, source, original.journal, original.pins, again);
      ok(`the ${wrote} resumes the journal it wrote itself, reading it rather than dispatching: ${name}`, own.fault === null && j(again) === j(logs) && j(own.value) === j(original.value), {
        fault: own.fault === null ? null : (own.fault.code ?? `${(own.fault as Error).name}: ${(own.fault as Error).message.slice(0, 80)}`),
        logs: { first: logs, resumed: again },
        value: { first: original.value, resumed: own.value },
      });
      replays += 1;

      // AND THE OTHER ENGINE REFUSES IT, saying which version wrote the record and which one is
      // reading — a bare code would be satisfied by any refusal on the path, including one that
      // never looked at the version.
      const across: unknown[][] = [];
      const crossed = await resumeOn(other, source, original.journal, original.pins, across);
      ok(`and the ${other} refuses that journal by name, naming the version that wrote it and its own: ${name}`, crossed.fault !== null && crossed.fault.code === "L5008" && crossed.fault.recorded === versionOf[wrote] && crossed.fault.supplied === versionOf[other] && across.length === 0, {
        code: crossed.fault === null ? null : crossed.fault.code,
        recorded: crossed.fault === null ? null : crossed.fault.recorded,
        supplied: crossed.fault === null ? null : crossed.fault.supplied,
        dispatched: across.length,
      });
      refusals += 1;
    }
  }
  console.log(`  (${replays} journals resumed by the engine that wrote them and ${refusals} refused by the other, every one against a handler that refuses every dispatch)`);
}

// ---- a run its host stopped, finished by the engine that paused it ------------------------------

{
  // THE OPERATIONAL STORY, not a synthetic one. A driver pauses a run - an operator asked, a work
  // horizon was reached - and something else picks it up later. `shouldStop` is asked before every
  // effect that is not already recorded, so the run stops exactly where its journal says it is, and
  // the engine that finishes it need not be the engine that started it. That is the whole promise of
  // the wave stated as one program, and it is checked in BOTH directions.
  const source = 'const a = await spawn("one");\nawait sleep("1m", { name: "s1" });\nawait sleep("2m", { name: "s2" });\nlog("done", a.agent);';
  const finished: { logs: unknown[][]; entries: JournalEntry[]; value: unknown }[] = [];
  for (const [wrote, other] of [
    ["walker", "engine"],
    ["engine", "walker"],
  ] as const) {
    // The pins are resolved ONCE and travel with the journal, the way a run record carries them.
    const pins = resolvePins({ runId: "d", seed: SEED, startedAt: AT }, AT, wrote === "walker" ? WALKER_LANGUAGE_VERSION : ENGINE_LANGUAGE_VERSION);
    const journal = new Journal({ run: "d" });
    let asked = 0;
    const first = {
      runId: "d",
      handler: new SimHandler({}),
      journal,
      pins,
      shouldStop: () => (asked++ >= 2 ? "operator paused" : undefined),
    };
    let stopped: string | null = null;
    try {
      if (wrote === "walker") await walk(source, first);
      else await runOnEngine(source, transform(source).module, { ...first, evaluate });
    } catch (e) {
      stopped = (e as { code?: string }).code ?? (e as Error).name;
    }
    ok(`the ${wrote} stops where its host asked it to`, stopped === "L5012" && journal.entries().length === 2, {
      stopped,
      entries: journal.entries().length,
    });

    // GUARDED, like the resumes above: an engine that cannot finish the resume must red one named
    // cell, not take the suite down before its summary line and turn a real red into a dead run.
    const finish = async (on: "walker" | "engine") => {
      const logs: unknown[][] = [];
      const back = { runId: "d", handler: new SimHandler({}), pins, onLog: (l: { values: readonly unknown[] }) => logs.push([...l.values]) };
      try {
        const r =
          on === "walker"
            ? await walkResume(source, journal, back as never)
            : await resumeOnEngine(source, transform(source).module, journal, { ...(back as never), evaluate });
        return { logs, run: r as Awaited<ReturnType<typeof walkResume>> | null, fault: null as null | { code?: string; recorded?: unknown; supplied?: unknown } };
      } catch (e) {
        return { logs, run: null, fault: e as { code?: string; recorded?: unknown; supplied?: unknown } };
      }
    };

    // THE HALF THE SPLIT LEAVES STANDING: a paused run is finished by the engine that paused it.
    const own = await finish(wrote);
    ok(`and the ${wrote} finishes its own paused run from there`, own.fault === null && own.run !== null && j(own.logs) === j([["done", "sim.one"]]) && own.run.journal.entries().length === 3, {
      fault: own.fault === null ? null : own.fault.code,
      logs: own.logs,
      entries: own.run === null ? null : own.run.journal.entries().length,
    });

    // AND THE HALF IT TAKES AWAY, asserted rather than left to be discovered: the operational story
    // of "another host picks it up" now ends at the language boundary, and it says so by name.
    const crossed = await finish(other);
    ok(`and the ${other} refuses to finish it, naming the version that paused it and its own`, crossed.fault !== null && crossed.fault.code === "L5008" && crossed.fault.recorded === versionOf[wrote] && crossed.fault.supplied === versionOf[other] && crossed.logs.length === 0, {
      code: crossed.fault === null ? null : crossed.fault.code,
      recorded: crossed.fault === null ? null : crossed.fault.recorded,
      supplied: crossed.fault === null ? null : crossed.fault.supplied,
      dispatched: crossed.logs.length,
    });

    finished.push({ logs: own.logs, entries: own.run === null ? [] : [...own.run.journal.entries()], value: own.run === null ? undefined : own.run.value });
  }
  const [a, b] = finished as [(typeof finished)[0], (typeof finished)[0]];
  // TWO SYMMETRIC DEATHS ARE NOT AGREEMENT. A crossing whose resume throws still pushes a
  // placeholder above — empty entries, empty logs, an undefined value — so comparing two FAILED
  // crossings compares two identical nothings and passes. Measured, at 29f861c2 and with no version
  // split in play: hand both resumes a record the replaying engine does not speak and both finish
  // cells red with L5008 while this comparison printed `ok`, entries [0, 0]. The cell that carries
  // "the same journal, not the same rendering" went green BECAUSE its two subjects died together.
  //
  // So a comparison whose subjects may not exist has to say they exist FIRST. `produced` is the
  // predicate, named rather than inlined because it outlived the cell it was written for: the two
  // journals compared here are now each engine finishing its OWN paused run, since the crossing that
  // used to produce them is refused, and the hazard came across unchanged — two runs that both
  // failed to produce a journal agree perfectly. The property this carries is the one the split does
  // not touch: the same program, paused at the same place, finishes to the SAME journal on either
  // engine, entry for entry, which is what makes "the same journal" mean a journal and not a
  // rendering of one.
  const produced = (x: (typeof finished)[0]) => x.entries.length > 0 && x.logs.length > 0;
  ok(
    "and the two finished journals are the same journal, entry for entry, with two journals there to compare",
    produced(a) && produced(b) && j(a.entries) === j(b.entries) && j(a.logs) === j(b.logs) && j(a.value) === j(b.value),
    { entries: [a.entries.length, b.entries.length], logs: [a.logs.length, b.logs.length] },
  );

  // AND THE REFUSAL THAT PROTECTS IT, on both engines. A journal with recorded steps and no pins is
  // a different run wearing this one's history: the epoch would move to the resuming host and every
  // pure draw would change, and neither is a recorded fact a replay could diverge on.
  const refusals: (string | null)[] = [];
  for (const kind of ["walker", "engine"] as const) {
    const journal = new Journal({ run: "d" });
    const pins = resolvePins({ runId: "d", seed: SEED, startedAt: AT }, AT, WALKER_LANGUAGE_VERSION);
    try {
      await walk(source, { runId: "d", handler: new SimHandler({}), journal, pins });
    } catch {
      /* the first run is only here to fill the journal */
    }
    try {
      const opts = { runId: "d", handler: new SimHandler({}) };
      if (kind === "walker") await walkResume(source, journal, opts);
      else await resumeOnEngine(source, transform(source).module, journal, { ...opts, evaluate });
      refusals.push(null);
    } catch (e) {
      refusals.push((e as { code?: string }).code ?? (e as Error).name);
    }
  }
  ok("both engines refuse a journal handed back without its pins", j(refusals) === j(["L5021", "L5021"]), refusals);
}

// ---- every program in every list is a program, and does something -------------------------------

{
  // AN INVALID PROGRAM AGREES PERFECTLY ON BOTH ARMS. Two of these were caught this way: `ask` takes
  // its options as the SECOND argument and a `notify` fact is a bounded decision record, so two
  // corpus entries were refused by the validator identically on the walker and on the engine, and
  // their cells were green over nothing. The validator is the corpus's own gate now.
  const every = [...CORPUS, ...DIVERGENT.map(([n, src, sc]) => [n, src, sc] as const), ...HELD.map(([n, src, sc]) => [n, src, sc] as const), ...RESUMABLE];
  const invalid: string[] = [];
  for (const [name, source] of every) {
    try {
      validate(source);
    } catch (e) {
      invalid.push(`${name}: ${((e as { errors?: { code: string }[] }).errors ?? []).map((x) => x.code).join(",") || String(e).slice(0, 60)}`);
    }
  }
  ok("every program in every list is one the validator admits", invalid.length === 0, invalid);
  console.log(`  (${every.length} programs validated across the corpus, the divergences, the holds and the crossings)`);

  // AND EACH ONE IS OBSERVABLE. A program that logs nothing, journals nothing and refuses nothing
  // compares equal for the same reason an invalid one does.
  const silent: string[] = [];
  for (const [name, source, script] of CORPUS) {
    const w = await arm("walker", source, script);
    if (w.logs.length === 0 && w.entries.length === 0 && w.error === null) silent.push(name);
  }
  ok("every corpus program logs, journals or refuses something", silent.length === 0, silent);
}

// ---- the free surface, counted against its own table --------------------------------------------

{
  // THE UNIVERSE COMES FROM THE TABLE, NOT FROM THE CORPUS. A coverage claim whose universe is the
  // thing being covered is always complete. So the set is `primitives.ts`'s own, and a name added
  // there reds this cell until a program reaches it on both engines.
  //
  // Names are collected as identifiers the source spells. That over-counts a program that declares
  // a local of the same name, which none of these do — and the direction of the error is the one
  // that matters here: it can only make the cell pass, so the list below is checked to empty rather
  // than trusted to be right.
  const spelled = new Set<string>();
  const collect = (n: unknown): void => {
    if (Array.isArray(n)) return void n.forEach(collect);
    if (n === null || typeof n !== "object") return;
    const node = n as Record<string, unknown>;
    if (node.type === "Identifier" && typeof node.name === "string") spelled.add(node.name);
    for (const [k, v] of Object.entries(node)) if (k !== "type") collect(v);
  };
  for (const [, source] of [...CORPUS, ...HELD.map(([n, src]) => [n, src] as const)]) {
    collect(parse(source, { ecmaVersion: 2023, sourceType: "module", allowAwaitOutsideFunction: true }));
  }
  const table = [...BUILTINS, ...Object.keys(PURE_PRIMITIVES), ...Object.keys(EVENT_CONSTRUCTORS), ...Object.keys(PRIMITIVES)];
  const missing = table.filter((n) => !spelled.has(n)).sort();
  ok("every free name the language has is reached by a program in the corpus", missing.length === 0, missing);
  console.log(`  (${table.length} free names in the table, ${table.length - missing.length} reached)`);
}

// ---- the gate's own coverage, derived from the tables rather than remembered ---------------------

{
  // WHAT THIS GATE DOES NOT REACH, MECHANIZED. `transform.smoke` derives its universe from
  // `syntax.ts` and reds on an unreached node type; this suite imported neither table, so its own
  // coverage was a number somebody had measured once. Both halves are derived here, and the second
  // is the stronger one: a kind counts as reached only when an ENGINE run of a corpus program
  // actually WROTE it to the journal, which spelling a primitive's name in a program that never
  // reaches the call does not do.
  const spelledTypes = new Set<string>();
  const types = (n: unknown): void => {
    if (Array.isArray(n)) return void n.forEach(types);
    if (n === null || typeof n !== "object") return;
    const node = n as Record<string, unknown>;
    if (typeof node.type === "string") spelledTypes.add(node.type);
    for (const [k, v] of Object.entries(node)) if (k !== "type" && k !== "start" && k !== "end") types(v);
  };
  for (const [, source] of CORPUS) types(parse(source, { ecmaVersion: 2023, sourceType: "module", allowAwaitOutsideFunction: true }));
  const missingTypes = [...ADMITTED_NODES].filter((t) => !spelledTypes.has(t));
  ok("the corpus reaches every node type the validator admits", missingTypes.length === 0, missingTypes);

  const kinds = [...new Set([...EFFECT_KINDS, ...Object.entries(PRIMITIVES).filter(([, spec]) => spec.opensScope === true).map(([n]) => n)])];
  const missingKinds = kinds.filter((k) => !reachedKinds.has(k));
  ok("and a corpus program journals every kind the engine can write", missingKinds.length === 0, missingKinds);
  console.log(`  (${ADMITTED_NODES.size} admitted node types and ${kinds.length} journal kinds, each reached by a corpus program the engine ran)`);
}

// ---- and the surface that holds the compartment closed, over THIS corpus ------------------------

{
  // MEASURED BY LANE H, and it changes what this is worth: inside the shipped SES compartment an
  // unbound READ evaluates to `undefined` and throws nothing - the scope proxy answers `has` for
  // every name - while an unbound WRITE still refuses. So the host's loud free-identifier clause is
  // a backstop for the write half only, and what holds the read half closed is that the emitted
  // module has no free identifier to begin with.
  //
  // `transform.smoke` asserts that over ITS corpus, which is a list written to reach every node
  // type. This one is the list of programs the gate actually RUNS, and it is five times the size;
  // a shape that only lives here would have had nothing checking it. The resolver is shared with
  // that suite, where a positive control requires it to name a free name that does exist.
  //
  // AND IT WALKS EVERY LIST THE GATE RUNS, not just the corpus. It used to iterate `CORPUS` alone
  // while this comment claimed the wider set — a sentence naming a universe its loop did not walk,
  // which is the shape that hides a gap rather than reporting one. The divergences and the
  // crossings are transformed and executed on the engine exactly as corpus rows are, so a free
  // identifier in one of them is the same silent read, and the twelve of them were outside the only
  // check that can see it. Widening cost nothing and found nothing: latent, not live, and said
  // that way rather than as a fix that caught something.
  const RAN = [
    ...CORPUS.map(([n, src]) => [n, src] as const),
    ...DIVERGENT.map(([n, src]) => [n, src] as const),
    ...HELD.map(([n, src]) => [n, src] as const),
    ...RESUMABLE.map(([n, src]) => [n, src] as const),
  ];
  const open: string[] = [];
  for (const [name, source] of RAN) {
    const free = unbound(parseModule(transform(source).module));
    if (free.length > 0) open.push(`${name}: ${free.join(",")}`);
  }
  ok("every program the gate runs emits a module with no free identifier, which is what the compartment cannot catch", open.length === 0, open);
  console.log(`  (${RAN.length} emitted modules resolved across the corpus, the divergences, the holds and the crossings, ${open.length} with a free identifier)`);
}

// ---- the mutation config, audited against the cells this suite prints --------------------------

/**
 * The same instrument the surface suite carries, over this suite's own config.
 *
 * `expectRed` is matched as a SUBSTRING of the run's output, which fails toward confidence three
 * ways and did, all three in these two configs: a sentence left behind by a renamed cell grades
 * WRONG-RED at fold time; a sentence that is a PREFIX of a sibling can report a kill off the wrong
 * cell; and a sentence that is a THROW MESSAGE rather than a cell grades a crash as a kill. Exactly
 * one printed cell per aim catches all three. Cells are recorded whether they passed or FAILED,
 * because this suite counts rather than exits — an aim naming a cell that fails is still an aim
 * naming a cell, and the alternative would make this red for the wrong reason on a real divergence.
 */
{
  const cfg = JSON.parse(readFileSync(new URL("./mutations/transform-differential.json", import.meta.url), "utf8")) as {
    suite: string;
    mutations: { name: string; expectRed: string }[];
  };
  ok("the config audited here is the one that names this suite", cfg.suite.endsWith("differential.smoke.ts"), cfg.suite);
  // THIS CELL COUNTS ITSELF, and it has to: a config may aim a mutant at the audit, and the audit's
  // own name is not in `CELLS` yet when it runs — `ok` records after it decides. Left out, an aim at
  // this cell reads as a stale sentence and the audit reds over its own existence.
  const AUDIT = "every mutation's expectRed names exactly one cell this suite printed";
  const known = [...CELLS, AUDIT];
  const wrong = cfg.mutations
    .map((m) => ({ m, hits: known.filter((c) => c.includes(m.expectRed)).length }))
    .filter(({ hits }) => hits !== 1)
    .map(({ m, hits }) => `${m.name}: ${hits} printed cell(s) match ${JSON.stringify(m.expectRed)}`);
  ok(AUDIT, wrong.length === 0, wrong);
  console.log(`  (${cfg.mutations.length} expectRed strings audited against ${CELLS.length} printed cells)`);
}

console.log(`\ndifferential.smoke: ${pass + failures.length} cells, ${pass} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  FAILED: ${f}`);
  process.exitCode = 1;
}
