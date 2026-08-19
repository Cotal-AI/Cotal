/**
 * The engine seam: `__ctx`, the whole surface a transformed program can reach.
 *
 * These are FIRST-PARTY cells, not differential ones. The differential suite (lane T's
 * `differential.smoke.ts`) is the primary gate and compares journals against the walker; what lives
 * here is what the walker cannot grade: the seam's own shape, the fuel unit (which CHANGES in
 * languageVersion 2 — the walker charges a dispatch, the engine charges a transformed-site hit), the
 * thenable gate (a program the walker cannot run at all: it dies as an unhandled rejection, filed as
 * a walker defect), and the calling-convention adapter, which exists only on this side.
 *
 * WHAT THESE CELLS DRIVE, AND WHAT THAT IS WORTH. Lane T's transform is not landed, so each cell
 * hand-writes the module string the transform will emit. That proves the HOST is correct for the
 * shape the seam ruling fixed; it does NOT prove lane T emits that shape. Only the differential
 * suite over real transform output proves the pair, and until it runs, every claim here is about the
 * host alone. The hand-written modules are deliberately written in the ruled shape — a closed
 * function expression with zero free identifiers, taking the context as its call argument — so the
 * day the transform lands, the same cells run against its output unchanged.
 */

import { Journal, RunClock } from "../src/journal.js";
import { KeyScope, programHashOf, stepKeyString } from "../src/keys.js";
import { resolvePins } from "../src/pins.js";
import { RuntimeFault, RunDivergence } from "../src/errors.js";
import { Cancelled } from "../src/effects.js";
import { LangErrors } from "../src/errors.js";
import { SimHandler } from "../src/sim.js";
import { arrayMethods, numberMethods, stringMethods } from "../src/library.js";
import { parse } from "acorn";
import { stripPositions } from "../src/interpret.js";
import { BUILTINS } from "../src/primitives.js";
import { Prng } from "../src/values.js";
import { createCtx, createEngine, type EngineCtx, type EngineRun, type Site } from "../src/engine/ctx.js";
import { NODE_FLOOR, assertNodeFloor, runOnEngine, resumeOnEngine } from "../src/engine/host.js";
import * as workerModule from "../src/engine/worker.js";
import { runInWorker } from "../src/engine/worker.js";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { run as walkerRun } from "../src/interpret.js";
import { EngineFrame, Signal, currentFrame, withFrame } from "../src/engine/frame.js";

let pass = 0;
const ok = (name: string, cond: boolean, extra?: unknown): void => {
  if (!cond) throw new Error(`FAIL: ${name}${extra !== undefined ? ` - ${JSON.stringify(extra)}` : ""}`);
  pass += 1;
  console.log(`  ok ${name}`);
};

/** Never yield: one step past any budget these cells use, so the boundary is never crossed. */
const NEVER = Number.MAX_SAFE_INTEGER;

interface Harness {
  readonly ctx: EngineCtx;
  readonly run: EngineRun;
  readonly frame: EngineFrame;
  /** Run `body` inside the root frame, as the host does when it calls the transformed module. */
  inFrame<T>(body: () => T | Promise<T>): Promise<T>;
}

function harness(opts: {
  script?: ConstructorParameters<typeof SimHandler>[0];
  stepBudget?: number;
  yieldEvery?: number;
  runId?: string;
} = {}): Harness {
  const runId = opts.runId ?? "eng-1";
  const handler = new SimHandler(opts.script ?? {});
  const pins = resolvePins(
    {
      runId,
      ...(opts.stepBudget !== undefined ? { stepBudget: opts.stepBudget } : {}),
      ...(opts.yieldEvery !== undefined ? { yieldEvery: opts.yieldEvery } : {}),
    },
    handler.now(),
  );
  const run: EngineRun = {
    runId,
    programHash: programHashOf("// engine smoke"),
    journal: new Journal({ run: runId }),
    handler,
    pins,
  };
  const frame = new EngineFrame(new KeyScope(), new RunClock(pins.startedAt), new Signal());
  return {
    ctx: createCtx(run),
    run,
    frame,
    inFrame: async <T,>(body: () => T | Promise<T>): Promise<T> => await withFrame(frame, async () => await body()),
  };
}

const caught = async (body: () => unknown): Promise<unknown> => {
  try {
    await body();
    return undefined;
  } catch (e) {
    return e;
  }
};
const codeOf = (e: unknown): string | undefined => (e as RuntimeFault | undefined)?.code;

/** A plain evaluator. The confined path is the worker; this is a test process comparing two engines. */
const plainly = (module: string): ((ctx: EngineCtx) => () => Promise<unknown>) =>
  // eslint-disable-next-line no-eval
  (0, eval)(module) as (ctx: EngineCtx) => () => Promise<unknown>;

// ---- 1) the seam runs a program, and the journal is the walker's shape -------------------------
//
// The whole point of the lane in one cell: a module in the ruled shape (closed expression, zero free
// identifiers, context as the CALL argument) performs a real effect through the seam and the entry
// lands with the step key the walker would have allocated.

{
  const h = harness({ script: { turns: { build: { status: "done" } } } });
  // What the transform emits, hand-written: `await turn(agent, { name: "build" })`.
  const module = `(ctx) => async () => {
    await ctx.fuel();
    const agent = await ctx.effect("spawn", ["builder", ctx.born({ name: "hire" })]);
    const r = await ctx.effect("turn", [agent, ctx.born({ name: "build" })]);
    return ctx.get(r, "status");
  }`;
  // eslint-disable-next-line no-eval
  const factory = (0, eval)(module) as (c: EngineCtx) => () => Promise<unknown>;
  const value = await h.inFrame(() => factory(h.ctx)());

  ok("a module in the ruled shape runs through the seam and answers the program's value", value === "done", value);

  const entries = h.run.journal.entries();
  ok("it wrote exactly the two entries the two effects owe", entries.length === 2, entries.length);
  ok(
    "and their step keys are the walker's, in order",
    entries.map((e) => `${e.kind}:${e.name}#${e.occurrence}`).join(" ") === "spawn:hire#0 turn:build#0",
    entries.map((e) => `${e.kind}:${e.name}#${e.occurrence}`),
  );
  ok("each is settled ok", entries.every((e) => e.state === "settled" && e.status === "ok"), entries.map((e) => e.status));
  ok(
    "the turn's entry carries the request id it was begun under",
    typeof entries[1]?.requestId === "string" && entries[1].requestId.length === 43,
    entries[1]?.requestId,
  );
}

// ---- 2) member reads: no prototype reach, the curated tables, and a method is not a value -------

{
  const h = harness();
  await h.inFrame(() => {
    const rec = h.ctx.born({ a: 1 });
    ok("a record answers its own field", h.ctx.get(rec, "a") === 1);
    // The hole the walker's member-access mutation guards: a host prototype must not be reachable.
    ok("a record answers undefined for `constructor`", h.ctx.get(rec, "constructor") === undefined);
    ok("and for `toString` and `hasOwnProperty`", h.ctx.get(rec, "toString") === undefined && h.ctx.get(rec, "hasOwnProperty") === undefined);

    const xs = h.ctx.born([1, 2, 3]);
    ok("an array answers length and an index", h.ctx.get(xs, "length") === 3 && h.ctx.get(xs, "1") === 2);
    ok("a string answers length and an index", h.ctx.get("abc", "length") === 3 && h.ctx.get("abc", "0") === "a");
    return undefined;
  });

  // A number has no `length` and no index: its whole surface is the curated table, reachable only at
  // a call.
  ok("a number's members are its curated table, at the call", (await h.inFrame(() => h.ctx.call(3.14159, "toFixed", [2]))) === "3.14");
  ok("and a name outside that table is L4014", codeOf(await caught(() => h.inFrame(() => h.ctx.call(1, "nope", [])))) === "L4014");

  ok("a method read as a VALUE is L4020, not a bound function", codeOf(await caught(() => h.inFrame(() => h.ctx.get(h.ctx.born([1]), "map")))) === "L4020");
  ok("a name outside the table is L4014", codeOf(await caught(() => h.inFrame(() => h.ctx.get(h.ctx.born([1]), "nope")))) === "L4014");
  ok(
    "and the L4014 message lists the table, so the author sees what IS a member",
    ((await caught(() => h.inFrame(() => h.ctx.get(h.ctx.born([1]), "nope")))) as Error).message.includes("flatMap"),
  );
  ok("reading a member of null is L4010", codeOf(await caught(() => h.inFrame(() => h.ctx.get(null, "a")))) === "L4010");
  // The computed-key door: `o[{}]` would enter host ToPrimitive, which runs a program closure with
  // no frame. Refused before String() is reached.
  ok(
    "a computed key that is a record is L4018 before any coercion",
    codeOf(await caught(() => h.inFrame(() => h.ctx.get(h.ctx.born({ a: 1 }), { valueOf: () => "a" })))) === "L4018",
  );
}

// ---- 3) member writes: the two halves of freeze-on-share, and the shapes JavaScript would allow --

{
  const h = harness();
  await h.inFrame(() => {
    const rec = h.ctx.born({ a: 1 });
    ok("a fresh local record may be written, and the write answers the value", h.ctx.set(rec, "a", 2) === 2 && h.ctx.get(rec, "a") === 2);
    const xs = h.ctx.born([1, 2]);
    ok("writing AT the length appends", h.ctx.set(xs, "2", 3) === 3 && h.ctx.get(xs, "length") === 3);
    ok("and truncating via length is allowed", h.ctx.set(xs, "length", 1) === 1 && h.ctx.get(xs, "length") === 1);
    return undefined;
  });

  const frozen = Object.freeze({ a: 1 });
  ok("a value that crossed an effect boundary is frozen and refuses a write (L2031)", codeOf(await caught(() => h.inFrame(() => h.ctx.set(frozen, "a", 2)))) === "L2031");

  // L2032's runtime half, reached through a VALUE rather than a binding: born at depth 0, written
  // from a depth-1 frame. This is the alias path the static walk provably cannot see.
  {
    const h2 = harness();
    const outer = await h2.inFrame(() => h2.ctx.born({ a: 1 }));
    const inner = h2.frame.branch("parallel", "p", 0, "b");
    ok(
      "a value born outside a concurrent branch and written inside it is L2032",
      codeOf(await caught(() => withFrame(inner, () => h2.ctx.set(outer, "a", 2)))) === "L2032",
    );
    ok(
      "a value born INSIDE the branch may be written there",
      (await withFrame(inner, () => {
        const v = h2.ctx.born({ a: 1 });
        return h2.ctx.set(v, "a", 2);
      })) === 2,
    );
  }

  ok(
    "a write past the end of an array is L4019, because a hole is not a value here",
    codeOf(await caught(() => h.inFrame(() => h.ctx.set(h.ctx.born([]), "2", 1)))) === "L4019",
  );
  ok(
    "a LONGER length is L4017 for the same reason",
    codeOf(await caught(() => h.inFrame(() => h.ctx.set(h.ctx.born([1]), "length", 5)))) === "L4017",
  );
  ok("`__proto__` as a field is L4014", codeOf(await caught(() => h.inFrame(() => h.ctx.set(h.ctx.born({}), "__proto__", {})))) === "L4014");
  ok("a non-index member of an array is L4014", codeOf(await caught(() => h.inFrame(() => h.ctx.set(h.ctx.born([]), "x", 1)))) === "L4014");
  ok("writing a member of null is L4010", codeOf(await caught(() => h.inFrame(() => h.ctx.set(null, "a", 1)))) === "L4010");
}

// ---- 4) the thenable gate: the one rule the oracle cannot grade ----------------------------------
//
// A program value with an own CALLABLE `then` is assimilated by the host's await machinery, which
// runs that closure with the host's own settlement functions as its arguments — measured at every
// return of a program value out of an async function, and at every await. The walker cannot grade
// this: the same program takes its process down as an unhandled rejection (a filed walker defect),
// so these programs are QUARANTINED from the differential corpus and live here instead.

{
  const h = harness();
  // NOT `return h.ctx.born(...)`: with the gate dropped, returning the value out of this async
  // boundary assimilates it, its `then` never settles, and the cell hangs instead of failing. The
  // cell has to be able to report its own failure, which is what the mutation config grades.
  ok(
    "a literal with an own callable `then` refuses at birth",
    codeOf(
      await caught(() =>
        h.inFrame(() => {
          h.ctx.born({ then: () => 1 });
          return undefined;
        }),
      ),
    ) === "L4018",
  );
  // The boundary in the other direction: a NON-callable `then` is legal, and the walker settles it
  // clean. A gate that refused every own `then` would refuse a program the oracle accepts.
  ok(
    "a non-callable `then` field stays legal",
    (await h.inFrame(() => h.ctx.get(h.ctx.born({ then: 1 }), "then"))) === 1,
  );
  ok(
    "a FUNCTION carrying an own callable `then` refuses at birth too",
    codeOf(
      await caught(() =>
        h.inFrame(() => {
          const f = (): number => 1;
          (f as unknown as Record<string, unknown>).then = (): number => 1;
          h.ctx.born(f);
          return undefined;
        }),
      ),
    ) === "L4018",
  );
  // The second door: a record can ACQUIRE the field after birth, and a computed key reaches it past
  // any static spelling of `then`.
  ok(
    "writing a callable into the field `then` refuses (L4018)",
    codeOf(await caught(() => h.inFrame(() => h.ctx.set(h.ctx.born({}), "then", () => 1)))) === "L4018",
  );
  ok(
    "including through a computed key no static analysis can read",
    codeOf(await caught(() => h.inFrame(() => h.ctx.set(h.ctx.born({}), "th" + "en", () => 1)))) === "L4018",
  );
  ok(
    "writing a NON-callable into `then` stays legal",
    (await h.inFrame(() => h.ctx.set(h.ctx.born({}), "then", 1))) === 1,
  );
  // The third door, and the one that proves the gate runs BEFORE the host: if `await` reached the
  // value first, `then` would already have been called.
  {
    let fired = 0;
    const thenable = { then: (resolve: (v: unknown) => void): void => { fired += 1; resolve(9); } };
    const e = await caught(() => h.inFrame(() => h.ctx.await(thenable)));
    ok("awaiting an own-callable-`then` value is L4018", codeOf(e) === "L4018");
    ok("and the refusal happened BEFORE the host called it", fired === 0, fired);
  }
  // LANE T'S DOOR E, IN THE ENGINE'S SHAPE. On the walker, `merge({}, { then: f })` mints the hazard
  // past both birth and write, because the walker has no birth gate. Under the transform the literal
  // reaches `born` FIRST, so the builtin is never called at all — which is what makes the entry
  // doors sufficient here, and it is asserted rather than reasoned: the closure must never run.
  {
    let ran = 0;
    const e = await caught(() =>
      h.inFrame(() => {
        h.ctx.free("merge", [h.ctx.born({}), h.ctx.born({ then: () => { ran += 1; return 1; } })]);
        return undefined;
      }),
    );
    ok("a builtin ARGUMENT built as a literal is refused at birth, before the builtin runs", codeOf(e) === "L4018", String(e));
    ok("and the program closure never ran", ran === 0, ran);
  }
  // The other half of the same claim, so nobody reads the cell above as "merge refuses records":
  // the same call without a callable `then` goes through.
  ok(
    "the same shape without a callable `then` merges normally",
    JSON.stringify(await h.inFrame(() => h.ctx.free("merge", [h.ctx.born({ a: 1 }), h.ctx.born({ then: 1 })]))) === '{"a":1,"then":1}',
  );

  // A HOST promise must pass through: its `then` is on the prototype, not own, which is exactly what
  // separates it from a program value.
  ok("a host promise still awaits normally", (await h.inFrame(() => h.ctx.await(Promise.resolve(7)))) === 7);
  ok("and a plain value awaits to itself", (await h.inFrame(() => h.ctx.await(5))) === 5);
}

// ---- 5) fuel: the budget fires, and the yield is measured against a control ---------------------
//
// The unit is NOT the walker's. The walker charges one dispatch per node walked; the engine charges
// one transformed-site hit, which is languageVersion 2's pin-unit change. Journals are unaffected
// (steps are never recorded), so this is a first-party cell by construction, not by preference.

{
  const h = harness({ stepBudget: 50, yieldEvery: NEVER });
  const e = await caught(() =>
    h.inFrame(async () => {
      for (let i = 0; i < 1000; i += 1) await h.ctx.fuel();
    }),
  );
  ok("the step budget fires as L4013", codeOf(e) === "L4013", String(e));
  ok("and its message says it bounds ONE WALK, not the run", (e as Error).message.includes("bounds ONE WALK, not the run"));
  ok(
    "and it fires AT the budget rather than after it",
    (e as Error).message.includes("more than 50 interpreter steps"),
    (e as Error).message.slice(0, 80),
  );
}

{
  // THE PAIR. "A host timer fires during the run" is worthless alone — a timer also fires if the run
  // simply ends. The claim is the DIFFERENCE between yielding and not yielding, so the control runs
  // the identical loop with yielding effectively off.
  const spin = async (yieldEvery: number): Promise<boolean> => {
    const h = harness({ stepBudget: 1_000_000, yieldEvery });
    let timerFired = false;
    const t = setTimeout(() => {
      timerFired = true;
    }, 0);
    await h.inFrame(async () => {
      for (let i = 0; i < 20_000; i += 1) await h.ctx.fuel();
    });
    clearTimeout(t);
    return timerFired;
  };
  const withYield = await spin(64);
  const withoutYield = await spin(NEVER);
  ok("with yielding on, a host macrotask timer fires DURING the run", withYield);
  ok("and the control proves the cell can fail: with yielding off, it does not", !withoutYield);
}

{
  // The cut, and only the cut. An arm that can no longer win is abandoned at its next yield; an arm
  // that could still win keeps its pure work, so a live race is decided by the recorded clocks and
  // declaration order rather than by how many steps a tail takes against `yieldEvery`.
  const h = harness({ stepBudget: 1_000_000, yieldEvery: 8 });
  const branch = h.frame.branch("race", "r", 0, "loser");
  branch.signal.cancel("a sibling branch won the race", { cutPure: true });
  const e = await caught(() =>
    withFrame(branch, async () => {
      for (let i = 0; i < 1000; i += 1) await h.ctx.fuel();
    }),
  );
  ok("a branch cut at the pure level is abandoned at its next yield", e instanceof Cancelled, String(e));

  const h2 = harness({ stepBudget: 400, yieldEvery: 8 });
  const soft = h2.frame.branch("race", "r", 0, "still-in");
  soft.signal.cancel("cancelled but could still win", { cutPure: false });
  const e2 = await caught(() =>
    withFrame(soft, async () => {
      for (let i = 0; i < 100_000; i += 1) await h2.ctx.fuel();
    }),
  );
  ok(
    "a branch cancelled WITHOUT the cut runs its pure work to the budget instead (L4013)",
    codeOf(e2) === "L4013",
    String(e2),
  );
}

// ---- 6) template, binary, unary, iter -----------------------------------------------------------

{
  const h = harness();
  await h.inFrame(() => {
    ok("template interpolates primitives as JavaScript does", h.ctx.template(["a", "c"], ["b"]) === "abc");
    ok("a number interpolates by its JavaScript spelling", h.ctx.template(["", ""], [1.5]) === "1.5");
    ok("`===` on two records is native identity, not a coercion", h.ctx.binary("===", {}, {}) === false);
    ok("and `===` on the same record is true", (() => { const r = {}; return h.ctx.binary("===", r, r); })() === true);
    ok("arithmetic means what JavaScript means", h.ctx.binary("+", 1, 2) === 3 && h.ctx.binary("**", 2, 10) === 1024);
    ok("string concatenation and comparison work through the host leg", h.ctx.binary("+", "a", "b") === "ab" && h.ctx.binary("<", "a", "b") === true);
    ok("unary `-` and `~` mean what JavaScript means", h.ctx.unary("-", 3) === -3 && h.ctx.unary("~", 0) === -1);
    ok("`!` and `typeof` are answered here too", h.ctx.unary("!", 0) === true && h.ctx.unary("typeof", "x") === "string");
    ok("iter spreads an array and a string", h.ctx.iter([1, 2]).length === 2 && h.ctx.iter("ab").join("") === "ab");
    // `update` is the operand of `++`/`--` on the slow path: the transform emits a native increment
    // when it can see a number, and asks here when it cannot.
    ok("unary `update` answers a number operand unchanged", h.ctx.unary("update", 5) === 5);
    return undefined;
  });
  ok("a STRING operand of `++` refuses (L4018) rather than counting", codeOf(await caught(() => h.inFrame(() => h.ctx.unary("update", "5")))) === "L4018");
  ok("and so does a record", codeOf(await caught(() => h.inFrame(() => h.ctx.unary("update", {})))) === "L4018");
  ok("and undefined", codeOf(await caught(() => h.inFrame(() => h.ctx.unary("update", undefined)))) === "L4018");
  ok("a record operand is L4018, on either side", codeOf(await caught(() => h.inFrame(() => h.ctx.binary("+", {}, 1)))) === "L4018");
  ok("including the right-hand side", codeOf(await caught(() => h.inFrame(() => h.ctx.binary("+", 1, {})))) === "L4018");
  ok("a record interpolated into a template is L4018", codeOf(await caught(() => h.inFrame(() => h.ctx.template(["", ""], [{}])))) === "L4018");
  ok("a function interpolated is L4018 too", codeOf(await caught(() => h.inFrame(() => h.ctx.template(["", ""], [(): number => 1])))) === "L4018");
  ok("a record is not iterable (L4015)", codeOf(await caught(() => h.inFrame(() => h.ctx.iter({})))) === "L4015");
  ok("and neither is null", codeOf(await caught(() => h.inFrame(() => h.ctx.iter(null)))) === "L4015");
  ok("an unsupported unary operator is L1000, not a silent answer", codeOf(await caught(() => h.inFrame(() => h.ctx.unary("void", 1)))) === "L1000");
}

{
  // A DECLARED DIVERGENCE, ruled in 1c and asserted rather than hidden.
  //
  // The walker reads the operand of `++` through `Number(...)`, so a string counts and a record
  // settles as NaN, while `o + 1` on the very same values does something else entirely - the
  // silent-coercion class, filed against the walker as Cotal-AI/Cotal#646. The engine refuses
  // instead. Both halves are MEASURED here, so the day the walker's behaviour changes this cell
  // reds and the divergence is re-decided rather than inherited.
  const logs: unknown[][] = [];
  const walker = await walkerRun(`let n = "5";\nn++;\nlog("n", n);\n`, {
    runId: "upd-1",
    handler: new SimHandler({}),
    onLog: (l) => logs.push([...l.values]),
  });
  ok("the walker COUNTS a string operand, which is the divergence", JSON.stringify(logs) === '[["n",6]]', logs);
  ok("and it completes rather than refusing", walker.journal.entries().length === 0);
  const h = harness();
  ok(
    "the engine refuses the same operand, by rule and not by accident",
    codeOf(await caught(() => h.inFrame(() => h.ctx.unary("update", "5")))) === "L4018",
  );
}

// ---- 6b) callee: the L4011 refusal at a non-function callee -------------------------------------
//
// Seam member 14, granted in ruling 1c. The transform emits it behind a `typeof`, so a real call
// stays a native call and only the refusal comes here. The message is the walker's own words,
// because the differential suite compares what the program sees, not merely the code.

{
  const h = harness();
  await h.inFrame(() => {
    const f = (): number => 1;
    ok("a function callee passes through as itself", h.ctx.callee(f) === f);
    return undefined;
  });
  for (const [what, v] of [["a record", {}], ["undefined", undefined], ["a number", 3], ["a string", "f"], ["null", null]] as const) {
    ok(`calling ${what} is L4011`, codeOf(await caught(() => h.inFrame(() => h.ctx.callee(v)))) === "L4011");
  }
  // The walker's words are MEASURED, not quoted: the same refusal is provoked on the oracle and the
  // two messages are compared, so a reworded walker reds here instead of drifting apart silently.
  const fromWalker = await caught(() => walkerRun(`const x = 1;\nx();\n`, { runId: "callee-1", handler: new SimHandler({}) }));
  const fromEngine = await caught(() => h.inFrame(() => h.ctx.callee(1)));
  ok("the walker refuses the same program", codeOf(fromWalker) === "L4011", String(fromWalker));
  ok(
    "and the two engines refuse in the same words",
    (fromEngine as Error).message === (fromWalker as Error).message,
    { engine: (fromEngine as Error).message, walker: (fromWalker as Error).message },
  );
}

// ---- 7) caught: the uncatchable stay uncatchable, and the catch parameter is a record -----------

{
  const h = harness();
  await h.inFrame(() => {
    const e = h.ctx.caught(new RuntimeFault("L4014", "nope")) as Record<string, unknown>;
    ok("a runtime fault becomes a frozen record with a code", e.code === "L4014" && e.kind === "runtime" && Object.isFrozen(e));
    ok("and the raw host object is NOT what the program binds", !(e instanceof Error));
    const h2 = h.ctx.caught(new TypeError("boom")) as Record<string, unknown>;
    ok("any other host error becomes L4000/host", h2.code === "L4000" && h2.kind === "host");
    return undefined;
  });
  ok(
    "a Cancelled is rethrown rather than handed to the program",
    (await caught(() => h.inFrame(() => h.ctx.caught(new Cancelled("cut"))))) instanceof Cancelled,
  );
}

// ---- 8) free and call: the calling-convention adapter, both directions --------------------------
//
// The transform emits plain `async (...args)` closures; library.ts calls callbacks as
// `(frame, args)`. The host adapts at every crossing, and this is the cell that says so — a program
// closure handed to a curated method, and a builtin read as a VALUE and then called natively.

{
  const h = harness();
  await h.inFrame(async () => {
    ok("a free builtin is called through the seam", (await h.ctx.free("upper", ["ab"])) === "AB");
    ok("and one that builds a container stamps it", Array.isArray(await h.ctx.free("range", [3])));

    // A program closure crossing INTO a curated method.
    const doubled = (await h.ctx.call([1, 2, 3], "map", [async (x: unknown) => (x as number) * 2])) as number[];
    ok("a plain program closure works as a curated method's callback", doubled.join(",") === "2,4,6", doubled);

    // A program closure crossing into a free builtin.
    const filtered = (await h.ctx.free("filter", [[1, 2, 3, 4], async (x: unknown) => (x as number) % 2 === 0])) as number[];
    ok("and as a free builtin's callback", filtered.join(",") === "2,4", filtered);

    // A builtin read as a VALUE, then called natively — what `const f = upper` and `map(xs, upper)`
    // both need. Without the outward adaptation a native call would pass `(x)` where the library
    // expects `(frame, [x])`.
    const asValue = h.ctx.free("upper") as (...a: unknown[]) => Promise<unknown>;
    ok("a builtin read as a value is callable in the program's convention", (await asValue("cd")) === "CD");
    const mapped = (await h.ctx.free("map", [["a", "b"], asValue])) as string[];
    ok("and round-trips back through a builtin that calls it", mapped.join(",") === "A,B", mapped);

    // `json` is a builtin that is a RECORD, so the outward walk has to reach its members.
    const json = h.ctx.free("json") as Record<string, (...a: unknown[]) => Promise<unknown>>;
    ok("a record-shaped builtin hands out program-convention members", (await json.stringify({ b: 1, a: 2 })) === '{"a":2,"b":1}');
    // The outcome is CAPTURED rather than awaited into the expression, so a mutant that breaks the
    // own-field call path fails THIS cell by name instead of throwing out of the block and killing
    // the suite anonymously.
    let viaSeam: unknown;
    try {
      viaSeam = await h.ctx.call(h.ctx.free("json"), "stringify", [[1, 2]]);
    } catch (e) {
      viaSeam = e;
    }
    ok("and a member call through the seam agrees", viaSeam === "[1,2]", String(viaSeam));
    return undefined;
  });
  ok("an unknown free name is L2001, never undefined", codeOf(await caught(() => h.inFrame(() => h.ctx.free("nope", [])))) === "L2001");
  ok("calling a non-function value is L4011", codeOf(await caught(() => h.inFrame(() => h.ctx.call(h.ctx.born({ a: 1 }), "a", [])))) === "L4011");
}

// ---- 8b) the adaptation is INVISIBLE, and the frame never crosses --------------------------------
//
// Ruling 1c's invariant: a value the program hands to a library function and reads back must behave
// AND compare `===` as the one it handed in. Adapting every function in an argument list broke both
// halves - a mutating method STORED the walker view, and the program read back something that did
// not call and did not compare equal. The other half of the same section is the hazard underneath
// it: an unadapted crossing hands the RUN'S OWN FRAME to the program as an argument, and the frame
// carries the key scope, the clock and the cancellation signal, all writable.

{
  const h = harness();
  await h.inFrame(async () => {
    const f = async (x: unknown): Promise<unknown> => x;

    // Every mutating method that STORES an argument. `concat` is here too: it does not mutate, but
    // it puts the argument in the value it answers, which is the same crossing.
    const pushed = h.ctx.born([]) as unknown[];
    await h.ctx.call(pushed, "push", [f]);
    const unshifted = h.ctx.born([]) as unknown[];
    await h.ctx.call(unshifted, "unshift", [f]);
    const spliced = h.ctx.born([0]) as unknown[];
    await h.ctx.call(spliced, "splice", [0, 0, f]);
    const joined = (await h.ctx.call(h.ctx.born([]), "concat", [h.ctx.born([f])])) as unknown[];
    const written = h.ctx.born([]) as unknown[];
    h.ctx.set(written, 0, f);

    ok(
      "a program closure stored through a library method reads back as the SAME value",
      [pushed, unshifted, spliced.slice(0, 1), joined, written].every((xs) => h.ctx.get(xs, 0) === f),
      [pushed, unshifted, spliced, joined, written].map((xs) => (h.ctx.get(xs, 0) === f ? "===" : "adapted")),
    );

    // THE ELEMENT DOOR. Classifying a member by what it answered rather than by its NAME made an
    // array element that happens to be a closure look like a curated method: measured, `fs[0]("a")`
    // answered the EngineFrame and the callback saw `EngineFrame` where it expected `"a"`.
    const seen: unknown[] = [];
    const fs = h.ctx.born([async (x: unknown) => { seen.push(x); return x; }]) as unknown[];
    const back = await h.ctx.call(fs, 0, ["a"]);
    ok("a function ELEMENT is called as a program closure, not as a curated method", back === "a", String(back));
    ok(
      "so the run's frame never reaches the program through an element call",
      seen.length === 1 && seen[0] === "a",
      seen.map((v) => (v === null || typeof v !== "object" ? String(v) : (v as object).constructor.name)),
    );

    // The second half of the invariant: it still CALLS. Before the fix this was
    // `args is not iterable` - the stored walker view read its second argument as the argument list.
    ok("and it still calls, in the program's own convention", (await h.ctx.call(pushed, 0, ["z"])) === "z");
    return undefined;
  });
}

{
  const h = harness();
  await h.inFrame(async () => {
    // THE READ-FORM DOOR. `const f = map; f(xs, cb)` reaches library.ts through a different path
    // than `map(xs, cb)`, and the path that did not adapt handed `cb` the frame: measured,
    // `f([1, 2], (x) => x)` answered `[<EngineFrame>, <EngineFrame>]`.
    const seen: unknown[] = [];
    const asValue = h.ctx.free("map") as (...a: unknown[]) => Promise<unknown>;
    const out = (await asValue(h.ctx.born([1, 2]), async (x: unknown) => { seen.push(x); return x; })) as unknown[];
    ok("a builtin read as a VALUE adapts the callback it is handed", JSON.stringify(out) === "[1,2]", out);
    ok(
      "and the run's frame never reaches the program through it",
      seen.length === 2 && seen.every((v) => typeof v === "number"),
      seen.map((v) => (v === null || typeof v !== "object" ? String(v) : (v as object).constructor.name)),
    );

    // A builtin is ONE immutable binding for the whole run, so two reads are one value. A fresh
    // adapter per read makes `map !== map`, which is false on the walker.
    ok("a builtin read twice is the same value", h.ctx.free("map") === h.ctx.free("map"));
    ok("a record-shaped builtin too", h.ctx.free("json") === h.ctx.free("json"));
    const json = h.ctx.free("json") as Record<string, unknown>;
    ok("and so are its members", json.stringify === (h.ctx.free("json") as Record<string, unknown>).stringify);
    return undefined;
  });
}

{
  // WHERE THE LIBRARY CALLS ITS ARGUMENT, DERIVED RATHER THAN DECLARED.
  //
  // The seam adapts exactly one position per name, and that list is a reading of library.ts's
  // `asCallable` sites - a reading drifts. So this cell measures the real thing: every name in
  // every curated table and every free builtin is called THROUGH THE SEAM with a marker in each of
  // the first three argument positions, and a position is recorded when the marker FIRES. It fires
  // whether the library called it in the walker's convention or the program's, so what is observed
  // does not depend on what is declared, and a table that grows a callback position reds here
  // instead of quietly storing an adapted value somewhere.
  const h = harness();
  const lib = {
    runId: "probe",
    programHash: "probe",
    startedAt: 0,
    prng: new Prng("probe"),
    assertWritable: (): void => {},
  };
  const tables: readonly (readonly [string, readonly string[]])[] = [
    ["array", Object.keys(arrayMethods(lib))],
    ["string", Object.keys(stringMethods())],
    ["number", Object.keys(numberMethods())],
  ];
  const observed = new Set<string>();
  const marker = (hit: { fired: boolean }) => (...a: unknown[]): unknown => {
    hit.fired = true;
    return typeof a[0] === "number" ? a[0] : true;
  };
  const probe = async (key: string, at: number, call: (m: unknown) => Promise<unknown>): Promise<void> => {
    const hit = { fired: false };
    try {
      await call(marker(hit));
    } catch {
      // Wrong arguments for this name. What matters is only whether OUR function was called.
    }
    if (hit.fired) observed.add(`${key}@${at}`);
  };

  await h.inFrame(async () => {
    for (const [kind, names] of tables) {
      for (const name of names) {
        for (let at = 0; at < 3; at += 1) {
          const filler = [0, 0].slice(0, at);
          const receiver = (): unknown => (kind === "array" ? h.ctx.born([1, 2]) : kind === "string" ? "ab" : 3.5);
          await probe(`${kind}.${name}`, at, async (m) => await h.ctx.call(receiver(), name, [...filler, m]));
        }
      }
    }
    for (const name of BUILTINS) {
      const value = h.ctx.free(name);
      if (value !== null && typeof value === "object") {
        // A record-shaped builtin (`json`) reaches its members through the own-field path.
        for (const member of Object.keys(value as Record<string, unknown>)) {
          for (let at = 0; at < 3; at += 1) {
            const filler = [0, 0].slice(0, at);
            await probe(`builtin.${name}.${member}`, at, async (m) => await h.ctx.call(value, member, [...filler, m]));
          }
        }
        continue;
      }
      for (let at = 0; at < 3; at += 1) {
        const filler = at === 0 ? [] : [h.ctx.born([1, 2]), 0].slice(0, at);
        await probe(`builtin.${name}`, at, async (m) => await h.ctx.free(name, [...filler, m]));
      }
    }
    return undefined;
  });

  const expected = [
    ...["map", "filter", "find", "findIndex", "findLast", "findLastIndex", "some", "every", "forEach", "reduce", "flatMap"].map(
      (n) => `array.${n}@0`,
    ),
    ...["map", "filter", "find", "some", "every", "sort"].map((n) => `builtin.${n}@1`),
  ].sort();
  const found = [...observed].sort();
  ok("the library calls exactly the argument positions the seam adapts", JSON.stringify(found) === JSON.stringify(expected), {
    missing: expected.filter((k) => !observed.has(k)),
    extra: found.filter((k) => !expected.includes(k)),
  });
  ok("and the probe found something to compare", found.length === 17, found.length);
}

// ---- 9) a seam call with no frame fails loudly ---------------------------------------------------
//
// No fallback root frame, deliberately: inventing one would give a stray call a key namespace, a
// clock and a depth belonging to no branch, and the step would land in the wrong place in the
// journal instead of failing.

{
  const h = harness();
  const e = await caught(() => h.ctx.born({ a: 1 }));
  ok("a seam call outside any frame throws rather than inventing a root frame", e instanceof Error && (e as Error).message.includes("no frame"), String(e));
  ok("and the ambient frame is what a framed call reads", (await h.inFrame(() => currentFrame())) === h.frame);
}

// ---- 10) the scope-openers' emission contract ----------------------------------------------------
//
// `fanOut` and `conclave` take their body UNEVALUATED. The walker evaluates that argument INSIDE the
// scope, after its entry has begun (measured; see `deferredBody`), so an emission that hands over an
// already-evaluated body has journalled its effects in the wrong place and a resume would replay a
// step the walker's run never recorded. The seam refuses rather than accepting the wrong shape.

{
  const h = harness();
  const e = await caught(() => h.inFrame(() => h.ctx.effect("fanOut", [[], 5, h.ctx.born({ name: "f" })])));
  ok("a scope body handed over already evaluated is refused", codeOf(e) === "L1000" && (e as Error).message.includes("UNEVALUATED"), String(e));
  ok("and the refusal says what the order costs", (e as Error).message.includes("journalled its effects in the wrong place"), String(e).slice(0, 200));
  // The entry HAS begun by then, and settles failed: the refusal happens inside the scope, which is
  // exactly where the walker evaluates that argument.
  const entries = h.run.journal.entries();
  ok("the scope's entry was begun and settled failed, not skipped", entries.length === 1 && entries[0]?.kind === "fanOut" && entries[0]?.status === "failed", entries.map((x) => `${x.kind}/${x.status}`));
}

// ---- 11) replay: a recorded effect returns its recorded result and dispatches nothing -----------

{
  const first = harness({ script: { turns: { build: { status: "done" } } }, runId: "eng-replay" });
  const module = `(ctx) => async () => {
    const agent = await ctx.effect("spawn", ["builder", ctx.born({ name: "hire" })]);
    return await ctx.effect("turn", [agent, ctx.born({ name: "build" })]);
  }`;
  // eslint-disable-next-line no-eval
  const factory = (0, eval)(module) as (c: EngineCtx) => () => Promise<unknown>;
  const live = (await first.inFrame(() => factory(first.ctx)())) as Record<string, unknown>;

  // The SAME journal, replayed by a fresh seam over a handler that would throw if it were asked.
  const handler = new SimHandler({});
  const pins = first.run.pins;
  const replayRun: EngineRun = {
    runId: first.run.runId,
    programHash: first.run.programHash,
    journal: new Journal({ run: first.run.runId, entries: first.run.journal.entries() }),
    handler,
    pins,
  };
  const ctx2 = createCtx(replayRun);
  const frame2 = new EngineFrame(new KeyScope(), new RunClock(pins.startedAt), new Signal());
  const replayed = (await withFrame(frame2, () => factory(ctx2)())) as Record<string, unknown>;

  ok("a replayed run answers the RECORDED result", JSON.stringify(replayed) === JSON.stringify(live), { live, replayed });
  ok(
    "and it dispatched nothing: the unscripted handler was never asked",
    replayRun.journal.entries().length === 2,
    replayRun.journal.entries().length,
  );
  ok(
    "the replayed keys are the same keys",
    replayRun.journal.entries().map((e) => stepKeyString({ scope: [], kind: e.kind, name: e.name, occurrence: e.occurrence })).join(" ") ===
      first.run.journal.entries().map((e) => stepKeyString({ scope: [], kind: e.kind, name: e.name, occurrence: e.occurrence })).join(" "),
  );
}

// ---- 12) the host: the walker's own run shape, and the first end-to-end journal comparison ------
//
// `runOnEngine` exists so the differential suite can call one engine and then the other with nothing
// between them. The cells below are NOT the differential gate - that is lane T's suite over the real
// transform's output, on a real corpus. What they prove is that the wiring produces the walker's
// RunResult and, for one hand-written pair, the SAME journal. One program is an existence proof, not
// a gate, and it is written down here so nobody reads it as one.

const SOURCE = `
const builder = await spawn("builder", { name: "hire" });
const r = await turn(builder, { name: "build" });
log("status", r.status);
`;
const MODULE = `(ctx) => async () => {
  await ctx.fuel();
  const builder = await ctx.effect("spawn", ["builder", ctx.born({ name: "hire" })]);
  const r = await ctx.effect("turn", [builder, ctx.born({ name: "build" })]);
  await ctx.free("log", ["status", ctx.get(r, "status")]);
}`;
const SCRIPT = { turns: { build: { status: "done" as const } } };

{
  const logs: unknown[][] = [];
  // CAPTURED, like every other run-level cell here: `runOnEngine` refuses before it does anything -
  // the node floor, then the validator, then the resume rules - and a refusal awaited straight into
  // the assertions below would leave the block and kill the suite anonymously.
  let engine: Awaited<ReturnType<typeof runOnEngine>> | undefined;
  let refused: unknown;
  try {
    engine = await runOnEngine(SOURCE, MODULE, {
      runId: "host-1",
      handler: new SimHandler(SCRIPT),
      evaluate: plainly,
      onLog: (l) => logs.push([...l.values]),
    });
  } catch (e) {
    refused = e;
  }
  ok("runOnEngine RAN this program rather than refusing it at the boundary", refused === undefined, String(refused));
  engine = engine as Awaited<ReturnType<typeof runOnEngine>>;

  ok("runOnEngine answers the walker's RunResult shape", typeof engine.programHash === "string" && engine.journal instanceof Journal);
  ok("its programHash is the SOURCE's hash, not the module's", engine.programHash === programHashOf(SOURCE), engine.programHash);
  ok("it charged steps and reports them", engine.steps > 0, engine.steps);
  ok("and the log builtin reached the host's onLog", JSON.stringify(logs) === '[["status","done"]]', logs);

  // THE COMPARISON. Same source, same script, same run id - so the same seed and the same logical
  // epoch - through the walker and through the engine.
  const walker = await walkerRun(SOURCE, { runId: "host-1", handler: new SimHandler(SCRIPT) });

  ok("both engines agree on the program hash", walker.programHash === engine.programHash);
  ok(
    "and on every pin",
    JSON.stringify(walker.pins) === JSON.stringify(engine.pins),
    { walker: walker.pins, engine: engine.pins },
  );

  const strip = (j: Journal): string => JSON.stringify(j.entries());
  ok("the journals are IDENTICAL, entry for entry", strip(walker.journal) === strip(engine.journal), {
    walker: walker.journal.entries().map((e) => `${e.kind}:${e.name}#${e.occurrence}/${e.status}`),
    engine: engine.journal.entries().map((e) => `${e.kind}:${e.name}#${e.occurrence}/${e.status}`),
  });
  // The comparator's own failure mode is that two EMPTY journals compare equal. A corpus program
  // that journals nothing would pass every comparison ever written.
  ok("and there was something to compare", engine.journal.entries().length === 2, engine.journal.entries().length);

  // THE DECLARED DIVERGENCE, asserted rather than excluded. The walker charges one dispatch per node
  // it walks; the engine charges one transformed-site hit. Steps are never journalled, so this
  // changes no record - but it is the languageVersion 2 pin-unit change, and a suite that quietly
  // dropped `steps` from its comparison would be hiding a real difference rather than declaring one.
  ok("the step COUNTS differ, which is the declared v2 pin-unit divergence", walker.steps !== engine.steps, {
    walker: walker.steps,
    engine: engine.steps,
  });
}

{
  // The validator runs first, on the SOURCE, whichever engine is about to execute.
  //
  // "Something threw" is NOT the claim and would not have been worth writing: with the validator
  // removed this program still throws, because the module it is paired with performs an unscripted
  // effect. A mutation run caught exactly that - the cell SURVIVED the removal of `validate`. The
  // claim has two halves and both are asserted: the refusal is the VALIDATOR'S, and the module was
  // never evaluated at all.
  let evaluated = false;
  const refused = await caught(() =>
    runOnEngine("const x = new Date();", MODULE, {
      runId: "host-bad",
      handler: new SimHandler({}),
      evaluate: (m) => {
        evaluated = true;
        return plainly(m);
      },
    }),
  );
  ok("invalid source is refused by the VALIDATOR", refused instanceof LangErrors, String(refused));
  ok("and the module was never evaluated", !evaluated);

  // The evaluator is the injection point, and it is used: no hidden default path.
  let sawModule: string | undefined;
  await runOnEngine(SOURCE, MODULE, {
    runId: "host-2",
    handler: new SimHandler(SCRIPT),
    evaluate: (m) => {
      sawModule = m;
      return plainly(m);
    },
  });
  ok("the caller's evaluator is what turns the module into a factory", sawModule === MODULE);
}

{
  // A resume that will not say which run it is resuming.
  const first = await runOnEngine(SOURCE, MODULE, { runId: "host-3", handler: new SimHandler(SCRIPT), evaluate: plainly });
  const carried = new Journal({ run: "host-3", entries: first.journal.entries() });
  ok(
    "a journal with entries and no pins is L5021, not a silently different run",
    codeOf(
      await caught(() =>
        runOnEngine(SOURCE, MODULE, { runId: "host-3", handler: new SimHandler(SCRIPT), evaluate: plainly, journal: carried }),
      ),
    ) === "L5021",
  );
  ok(
    "and another run's journal is L5011",
    codeOf(
      await caught(() =>
        runOnEngine(SOURCE, MODULE, {
          runId: "host-other",
          handler: new SimHandler(SCRIPT),
          evaluate: plainly,
          journal: new Journal({ run: "host-3" }),
          pins: first.pins,
        }),
      ),
    ) === "L5011",
  );
}

{
  // THE EFFECT CEILING IS A RUN BOUND, and the engine's own wiring is what seeds it. Counted per
  // activation instead, a runaway loop that crashed or was released periodically would never reach
  // the ceiling however much it performed against the world - and the fault text would claim a
  // run-scoped fact from an activation-scoped counter.
  const CEIL_SOURCE = `
await sleep("1m", { name: "s0" });
await sleep("1m", { name: "s1" });
await sleep("1m", { name: "s2" });
await sleep("1m", { name: "s3" });
`;
  const sleeps = (n: number): string => `(ctx) => async () => {
    for (let i = 0; i < ${n}; i += 1) {
      await ctx.fuel();
      await ctx.effect("sleep", ["1m", ctx.born({ name: "s" + i })]);
    }
  }`;

  const journal = new Journal({ run: "ceil" });
  const first = await runOnEngine(CEIL_SOURCE, sleeps(4), {
    runId: "ceil",
    handler: new SimHandler({}),
    evaluate: plainly,
    effectCeiling: 4,
    journal,
  });
  ok("a run right up to its ceiling completes", journal.entries().length === 4, journal.entries().length);

  // The resume: four recorded sleeps replay, and the FIFTH is the one the ceiling has to refuse.
  const resumed = new Journal({ run: "ceil", entries: journal.entries() });
  const e = await caught(() =>
    runOnEngine(CEIL_SOURCE, sleeps(6), {
      runId: "ceil",
      handler: new SimHandler({}),
      evaluate: plainly,
      journal: resumed,
      pins: first.pins,
    }),
  );
  ok("a RESUMED run reaches the ceiling the RUN was pinned to, not a fresh one", codeOf(e) === "L4009", String(e));
  ok("the message quotes the pinned ceiling", (e as Error).message.includes("more than 4 effects"), (e as Error).message.slice(0, 70));
  // The discriminating half: counted per activation, the resume would have had a full fresh
  // allowance and simply performed the two remaining sleeps, ending green with six entries.
  ok(
    "and it dispatched nothing new: the count started where the run left off",
    resumed.entries().length === 4,
    resumed.entries().length,
  );
}

{
  // The fuel gauge is the host's, not the program's: everything on EngineCtx is reachable from
  // inside the compartment, so a program that could read its own step count could shape itself
  // around one.
  const h = harness();
  const e = createEngine(h.run);
  ok("the step count is NOT a member of the seam", !("steps" in (e.ctx as unknown as Record<string, unknown>)));
  ok("and it is not enumerable on the object the program holds", !Object.keys(e.ctx).includes("steps"));
  ok("but the host can read it", typeof e.steps() === "number");
}


// ---- 13) the free VALUE constructors: the two pure primitives and the four events ----------------
//
// Design §3A: `channel`, `run`, `replied`, `message`, `idle` and `down` are free values, not
// journalled effects, and `free()` serves them. They are the walker's own table (perform.ts) rather
// than a second copy, and the cell that says so compares the SHAPES both engines produce, because a
// fork here is a fork in what a handle or an event descriptor IS on the wire.

{
  const CONSTRUCTOR_SOURCE = `
const c = channel("ops");
const a = await spawn("builder", { name: "hire" });
log("shapes", [c, run(), replied(a), message(c, { from: a, matches: "hi" }), idle(c, "5m"), down(a)]);
`;
  const CONSTRUCTOR_MODULE = `(ctx) => async () => {
  await ctx.fuel();
  const c = ctx.free("channel", ["ops"]);
  const a = await ctx.effect("spawn", ["builder", ctx.born({ name: "hire" })]);
  await ctx.free("log", ["shapes", ctx.born([
    c,
    ctx.free("run", []),
    ctx.free("replied", [a]),
    ctx.free("message", [c, ctx.born({ from: a, matches: "hi" })]),
    ctx.free("idle", [c, "5m"]),
    ctx.free("down", [a]),
  ])]);
}`;
  const script = {};
  const engineLogs: unknown[][] = [];
  const walkerLogs: unknown[][] = [];
  // The outcome is CAPTURED: a name `free()` does not serve throws L2001 out of the run, and a cell
  // that let it through would kill the suite anonymously instead of failing by its own name.
  let served: unknown;
  try {
    served = await runOnEngine(CONSTRUCTOR_SOURCE, CONSTRUCTOR_MODULE, {
      runId: "free-1",
      handler: new SimHandler(script),
      evaluate: plainly,
      onLog: (l) => engineLogs.push([...l.values]),
    });
  } catch (e) {
    served = e;
  }
  const walker = await walkerRun(CONSTRUCTOR_SOURCE, {
    runId: "free-1",
    handler: new SimHandler(script),
    onLog: (l) => walkerLogs.push([...l.values]),
  });

  ok("free() serves the pure primitives and the event constructors", engineLogs.length === 1, String(served));
  const engine = served as Awaited<ReturnType<typeof runOnEngine>>;
  ok("and every shape is the walker's, field for field", JSON.stringify(engineLogs) === JSON.stringify(walkerLogs), {
    engine: engineLogs,
    walker: walkerLogs,
  });
  ok(
    "and there were six shapes to compare",
    Array.isArray(engineLogs[0]?.[1]) && (engineLogs[0]?.[1] as unknown[]).length === 6,
    engineLogs[0]?.[1],
  );
  ok("the journals stay identical across them", JSON.stringify(engine.journal.entries()) === JSON.stringify(walker.journal.entries()));
  // A constructor is a VALUE, so reading one without calling it has to work as well.
  const read = await runOnEngine("log(\"x\", 1);", `(ctx) => async () => { await ctx.fuel(); return typeof ctx.free("channel"); }`, {
    runId: "free-2",
    handler: new SimHandler({}),
    evaluate: plainly,
  });
  ok("a constructor read as a VALUE is a function, not L2001", read.value === "function", read.value);
}

// ---- 14) branch semantics: the key namespace, the depth, and the two degrees of cancellation ----
//
// The scope machinery itself is private to interpret.ts and is being extracted; what is gradeable
// TODAY is the part the engine owns either way - what a branch frame IS. It is the part most likely
// to be subtly wrong, because it decides where every step under a scope lands in the journal.

{
  // THE KEY ALLOCATION IS THE WALKER'S, and it is COMPARED rather than asserted: the same named
  // `parallel` with the same two arms is run on the oracle, and the engine's frames are asked for
  // the same keys. A step key that differs by one character is a step the resume cannot find.
  const SRC = `
await parallel({
  a: async () => { await sleep("1s"); },
  b: async () => { await sleep("2s"); },
}, { name: "both" });
`;
  const walker = await walkerRun(SRC, { runId: "branch-1", handler: new SimHandler({}) });
  const walkerKeys = walker.journal
    .entries()
    .map((e) => `${(e as unknown as { scope: string }).scope}/${e.name === "" ? e.kind : `${e.kind}:${e.name}`}#${e.occurrence}`);

  const root = new EngineFrame(new KeyScope(), new RunClock(0), new Signal());
  const occurrence = root.keys.nextScope("parallel", "both");
  const engineKeys = [
    stepKeyString(root.keys.scopeKey("parallel", "both", occurrence)),
    ...["a", "b"].map((k) => stepKeyString(root.branch("parallel", "both", occurrence, k).keys.nextEffect("sleep"))),
  ];
  ok("a branch frame allocates the walker's own step keys", JSON.stringify(engineKeys) === JSON.stringify(walkerKeys), {
    walker: walkerKeys,
    engine: engineKeys,
  });
  ok("and the two arms landed in DIFFERENT namespaces", new Set(walkerKeys).size === 3, walkerKeys);
}

{
  const root = new EngineFrame(new KeyScope(), new RunClock(100), new Signal());
  const occurrence = root.keys.nextScope("parallel", null);
  const arm = root.branch("parallel", null, occurrence, "a");

  ok("a concurrent branch raises the depth", arm.depth === root.depth + 1, { root: root.depth, arm: arm.depth });
  // `conclave` opens a scope but not a race: one body, nothing running beside it, so a write from
  // inside it is as ordered as a write anywhere else (interpret.ts, Frame.branch).
  const room = root.branch("conclave", null, root.keys.nextScope("conclave", null), "0");
  ok("and a conclave body does NOT, because it has no sibling to race", room.depth === root.depth, room.depth);

  // A branch inherits the clock it forked from and then moves on its own. Sharing one clock would
  // let a sibling's effect decide a race the recorded clocks should decide.
  ok("a branch inherits the clock at the fork", arm.clock.now() === 100);
  arm.clock.advance(500);
  ok("and moves without moving the parent's", root.clock.now() === 100 && arm.clock.now() === 500, {
    root: root.clock.now(),
    arm: arm.clock.now(),
  });
  root.clock.join([arm.clock]);
  ok("the join takes the branch's history", root.clock.now() === 500, root.clock.now());

  // A branch's cancellation is its own. Sharing the parent's signal would make one arm's loss the
  // whole run's, which is the opposite of what a scope cancelling its losers means.
  arm.signal.cancel("this arm lost");
  ok("cancelling a branch does not cancel the run it branched from", !root.signal.cancelled && arm.signal.cancelled);
}

{
  // L2032's runtime half, through the depth a branch frame carries. The static walk refuses a
  // BINDING written inside a branch; this is the value that got there by an alias it cannot see.
  const h = harness();
  const root = new EngineFrame(new KeyScope(), new RunClock(0), new Signal());
  const outer = (await withFrame(root, () => h.ctx.born({ n: 0 }))) as Record<string, number>;
  const occurrence = root.keys.nextScope("parallel", null);
  const arm = root.branch("parallel", null, occurrence, "a");
  const room = root.branch("conclave", null, root.keys.nextScope("conclave", null), "0");

  const inArm = await caught(() => withFrame(arm, () => h.ctx.set(outer, "n", 1)));
  ok("a value born outside a concurrent branch refuses a write inside it", codeOf(inArm) === "L2032", String(inArm));
  const inRoom = await caught(() => withFrame(room, () => h.ctx.set(outer, "n", 2)));
  ok("and the same write inside a conclave body is allowed, because the depth did not move", inRoom === undefined, String(inRoom));
  ok("and it actually landed", outer.n === 2, outer.n);
}

{
  // THE TWO DEGREES. `cancelled` is the law - a cancelled branch performs no NEW effect. `cutPure`
  // is the stronger cut a scope applies to an arm that can no longer win, and it is observed only
  // at a fuel yield. A signal cancelled softly can be ESCALATED afterwards, which is the case a
  // race re-decides when a cancelled arm's own clock lands past the frontier.
  const parent = new Signal();
  const child = parent.child();
  ok("a child of a live signal starts live", !child.cancelled && !child.cutPure);

  const heard: string[] = [];
  child.onCancel((reason, cut) => heard.push(`${reason}/${cut}`));
  parent.cancel("a sibling branch won the race", { cutPure: false });
  ok("a parent's cancellation reaches the child", child.cancelled && child.reason === "a sibling branch won the race");
  ok("softly, when the parent cancelled softly", !child.cutPure);

  parent.cancel("landed past the frontier", { cutPure: true });
  ok("and the ESCALATION reaches an already-cancelled child", child.cutPure);
  ok("the reason stays the FIRST one, because that is what cancelled the branch", child.reason === "a sibling branch won the race", child.reason);
  ok("the listener heard the cancel and the escalation, and nothing else", heard.length === 2, heard);

  parent.cancel("again", { cutPure: true });
  ok("a repeated cancellation is not a third event", heard.length === 2, heard);

  // A branch launched AFTER its parent was cut starts cut: it cannot win either.
  const late = parent.child();
  ok("a child made after the cut starts cancelled AND cut", late.cancelled && late.cutPure, {
    cancelled: late.cancelled,
    cutPure: late.cutPure,
  });
  ok("with the reason it inherited", late.reason === "a sibling branch won the race", late.reason);
}

// ---- 15) the optional call: `o.m?.()` ------------------------------------------------------------
//
// Seam member 4 gains a flag (F6, ruled 1d), not a fifteenth member. Every answer below was MEASURED
// on the walker first and is compared against it here, because two of them are not what "optional"
// suggests: `?.` guards a NULLISH MEMBER and nothing else - it softens neither L4014 nor L4011 - and
// a short-circuited call evaluates NO ARGUMENT AT ALL.

{
  /** The same program on the oracle: what it logged, what it journalled, or what it refused. */
  const onWalker = async (src: string): Promise<string> => {
    const logs: unknown[][] = [];
    try {
      const r = await walkerRun(src, { runId: "f6", handler: new SimHandler({}), onLog: (l) => logs.push([...l.values]) });
      return `ok ${JSON.stringify(logs)} ${JSON.stringify(r.journal.entries().map((e) => e.kind))}`;
    } catch (e) {
      return `refused ${codeOf(e)}`;
    }
  };
  const h = harness({ script: {} });

  ok("the walker short-circuits an absent member", (await onWalker(`const o = { a: 1 };\nconst r = o.m?.();\nlog("r", r);\n`)) === 'ok [["r",null]] []');
  // CAPTURED, not awaited into the assertion: without the short-circuit this call THROWS L4011, and
  // written the other way the throw left the block and killed the suite anonymously instead of
  // failing the cell that names the rule.
  let absent: unknown;
  try {
    absent = await h.inFrame(() => h.ctx.call(h.ctx.born({ a: 1 }), "m", () => [], true));
  } catch (e) {
    absent = e;
  }
  ok("and so does the engine, with nothing called", absent === undefined, String(absent));

  ok("the walker invokes a member that IS a function", (await onWalker(`const o = { m: () => 1 };\nconst r = o.m?.();\nlog("r", r);\n`)) === 'ok [["r",1]] []');
  ok(
    "and so does the engine",
    (await h.inFrame(() => h.ctx.call(h.ctx.born({ m: async () => 1 }), "m", () => [], true))) === 1,
  );

  ok("the walker refuses a member that is NOT a function, optional or not", (await onWalker(`const o = { m: 5 };\nconst r = o.m?.();\nlog("r", r);\n`)) === "refused L4011");
  ok(
    "and so does the engine: `?.` does not soften L4011",
    codeOf(await caught(() => h.inFrame(() => h.ctx.call(h.ctx.born({ m: 5 }), "m", () => [], true)))) === "L4011",
  );

  ok("the walker refuses a name the curated table does not have, optional or not", (await onWalker(`const xs = [1, 2];\nconst r = xs.nope?.();\nlog("r", r);\n`)) === "refused L4014");
  ok(
    "and so does the engine: `?.` does not soften L4014 either",
    codeOf(await caught(() => h.inFrame(() => h.ctx.call(h.ctx.born([1, 2]), "nope", () => [], true)))) === "L4014",
  );

  // A curated method is never nullish, so the optional form reaches the table path unchanged.
  const mapped = await h.inFrame(() => h.ctx.call(h.ctx.born([1, 2]), "map", () => [async (x: unknown) => (x as number) * 3], true));
  ok("an optional call on a curated method is just the call", JSON.stringify(mapped) === "[3,6]", mapped);

  // THE ONE THAT DECIDES THE SHAPE. The walker checks the member BEFORE it evaluates arguments, so a
  // short-circuited call performs nothing; the control beside it proves the argument would otherwise
  // have run. That is why the optional form takes a thunk: an array would already have been evaluated.
  ok(
    "a short-circuited call on the walker journals NOTHING",
    (await onWalker(`const o = { a: 1 };\nconst r = o.m?.(await sleep("1s"));\nlog("r", r);\n`)) === 'ok [["r",null]] []',
  );
  ok(
    "while the same argument on a PRESENT method journals its effect",
    (await onWalker(`const o = { m: (x) => x };\nconst r = o.m?.(await sleep("1s"));\nlog("r", r);\n`)) === 'ok [["r",null]] ["sleep"]',
  );
  let evaluated = 0;
  const short = await h.inFrame(() =>
    h.ctx.call(h.ctx.born({ a: 1 }), "m", () => {
      evaluated += 1;
      return [];
    }, true),
  );
  ok("and the engine's short-circuit never asks for its arguments", short === undefined && evaluated === 0, evaluated);
  let ran = 0;
  await h.inFrame(() =>
    h.ctx.call(h.ctx.born({ m: async () => 1 }), "m", () => {
      ran += 1;
      return [];
    }, true),
  );
  ok("while a present member does ask, exactly once", ran === 1, ran);

  // THE THUNK IS `async`, because any argument the transform emits may itself hold an `await` - so it
  // is AWAITED here. Lane T found this against my e7819fe3 and I reproduced it before touching the
  // line: unawaited, `args()` handed the spread a Promise, so an ordinary `o.m?.(1)` died on "Spread
  // syntax requires ...iterable" and `xs.map?.(f)` reached the curated method with a Promise where
  // its argument list should be. Both shapes are below, each against the oracle.
  ok("the walker calls a present member with a plain argument", (await onWalker(`const o = { m: (x) => x };\nlog("r", o.m?.(1));\n`)) === 'ok [["r",1]] []');
  // CAPTURED, like every other cell here whose subject is a refusal or a throw: unawaited the thunk
  // hands the spread a Promise, and that TypeError would leave the block and kill the suite
  // anonymously rather than failing the cell that names the rule.
  let plainArg: unknown;
  try {
    plainArg = await h.inFrame(() => h.ctx.call(h.ctx.born({ m: async (x: unknown) => x }), "m", async () => [1], true));
  } catch (e) {
    plainArg = e;
  }
  ok("and the engine awaits the thunk, so the arguments arrive as a LIST rather than as a promise", plainArg === 1, String(plainArg));
  const held = harness({ script: {} });
  try {
    await held.inFrame(() =>
      held.ctx.call(held.ctx.born({ m: async (x: unknown) => x }), "m", async () => [await held.ctx.effect("sleep", ["1s"])], true),
    );
  } catch {
    // The journal below is the assertion; how the call ended is the cell above's business.
  }
  ok(
    "an effect INSIDE the argument reaches the journal, matching the walker cell above",
    JSON.stringify(held.run.journal.entries().map((e) => e.kind)) === '["sleep"]',
    held.run.journal.entries().map((e) => e.kind),
  );
  ok("the walker runs a curated method through the optional form", (await onWalker(`const xs = [1, 2];\nlog("r", xs.map?.((x) => x * 3));\n`)) === 'ok [["r",[3,6]]] []');
  let curated: unknown;
  try {
    curated = await h.inFrame(() => h.ctx.call(h.ctx.born([1, 2]), "map", async () => [async (x: unknown) => (x as number) * 3], true));
  } catch (e) {
    curated = e;
  }
  ok("and the engine's curated path reads that same awaited list", JSON.stringify(curated) === "[3,6]", String(curated));

  // No silent acceptance of an already-evaluated list on the optional path: the short-circuit would
  // be a lie, because the arguments ran before the seam was reached.
  ok(
    "an optional call handed an ARRAY refuses, rather than short-circuiting after the fact",
    codeOf(await caught(() => h.inFrame(() => h.ctx.call(h.ctx.born({ a: 1 }), "m", [], true)))) === "L1000",
  );
  ok(
    "and an ordinary call still takes a plain array",
    (await h.inFrame(() => h.ctx.call(h.ctx.born({ m: async (x: unknown) => x }), "m", ["z"]))) === "z",
  );

  // THE CHAIN AFTER THE CALL. `o.m?.().x` cannot be guarded on the returned value: measured, an
  // absent member answers undefined and a member that RETURNS undefined refuses L4010, and both
  // give undefined to any guard written outside. Only the host knows which happened, so the rest of
  // the chain comes here as a closure and the host applies its own decision.
  ok("the walker short-circuits the whole chain after an absent member", (await onWalker(`const o = { a: 1 };\nlog("r", o.z?.().x);\n`)) === 'ok [["r",null]] []');
  ok("and refuses L4010 when the member was PRESENT and returned undefined", (await onWalker(`const o = { m: () => undefined };\nlog("r", o.m?.().x);\n`)) === "refused L4010");
  ok("and reads the field when it returned a record", (await onWalker(`const o = { m: () => ({ x: 7 }) };\nlog("r", o.m?.().x);\n`)) === 'ok [["r",7]] []');
  ok("the walker swallows a DEEP chain too", (await onWalker(`const o = { a: 1 };\nlog("r", o.z?.().x.y);\n`)) === 'ok [["r",null]] []');
  ok("and a trailing CALL", (await onWalker(`const o = { a: 1 };\nlog("r", o.z?.().trim());\n`)) === 'ok [["r",null]] []');

  // CAPTURED: with the chain unguarded it runs against undefined and throws L4010, which awaited
  // into the assertion would leave the block and kill the suite anonymously.
  let continued = 0;
  let chained: unknown;
  try {
    chained = await h.inFrame(() =>
      h.ctx.call(h.ctx.born({ a: 1 }), "z", () => [], true, (v) => {
        continued += 1;
        return h.ctx.get(v, "x");
      }),
    );
  } catch (e) {
    chained = e;
  }
  ok("the engine short-circuits the chain and never runs it", chained === undefined && continued === 0, {
    chained: String(chained),
    continued,
  });

  let refused: unknown;
  try {
    refused = await h.inFrame(() =>
      h.ctx.call(h.ctx.born({ m: async () => undefined }), "m", () => [], true, (v) => h.ctx.get(v, "x")),
    );
  } catch (e) {
    refused = e;
  }
  ok("but a member that RETURNED undefined reaches the chain, and it refuses L4010", codeOf(refused) === "L4010", String(refused));

  const read = await h.inFrame(() =>
    h.ctx.call(h.ctx.born({ m: async () => h.ctx.born({ x: 7 }) }), "m", () => [], true, (v) => h.ctx.get(v, "x")),
  );
  ok("and a record answers the field through the chain", read === 7, read);

  ok(
    "a continuation without the optional flag is refused, not silently run",
    codeOf(await caught(() => h.inFrame(() => h.ctx.call(h.ctx.born({ m: async () => 1 }), "m", [], false, (v) => v)))) === "L1000",
  );
}

// ---- 16) the worker: one locked-down thread per run, RUN FROM `dist` -----------------------------
//
// `lockdown()` is irreversible and realm-wide, so a run gets its own realm to harden and the host
// keeps an isolate whose intrinsics it still owns. The whole run happens inside that thread - the
// seam, the journal, the effect path and the handler - because `handler.now()` and every journal
// call in the effect path are SYNCHRONOUS and a proxy over a message port is not.
//
// THIS LEG RUNS THE BUILT PACKAGE, and every cell in it says so by name. A worker thread does not
// necessarily get the loader its parent has: on node 22 it measurably does not, so a `.ts` entry
// dies on its own `../journal.js` there while answering fine on 26. The entry is therefore an INPUT
// (`worker.ts` derives nothing), this suite hands it the artifact, and `smoke:lang-engine` builds
// before it runs. The leg grades what SHIPS rather than a second copy of it, and it grades the same
// thing on every node instead of on whichever one has a loader that reaches threads.

/** The built entry. Named, not derived: the derivation is exactly what `worker.ts` refuses to do. */
const WORKER_ENTRY = new URL("../dist/engine/worker-entry.js", import.meta.url);
/** The handler module the THREAD imports. Plain JS over `dist`, for the same reason as the entry. */
const SIM_HANDLER = new URL("./_sim-handler.mjs", import.meta.url).href;

{
  const HANDLER = { module: SIM_HANDLER, config: SCRIPT };

  const started = Date.now();
  const logs: unknown[][] = [];
  const run = runInWorker(
    { source: SOURCE, module: MODULE, runId: "host-1", handler: HANDLER },
    { entry: WORKER_ENTRY, onLog: (l) => logs.push([...l.values]) },
  );
  const answer = await run.done;
  const coldMs = Date.now() - started;

  ok("a run completes in its own locked-down thread, spawned from the BUILT package", answer.ok === true, JSON.stringify(answer).slice(0, 200));
  const got = answer as Extract<typeof answer, { ok: true }>;
  ok("and its log lines reached the host", JSON.stringify(logs) === '[["status","done"]]', logs);

  // THE COMPARISON THAT MATTERS: the same program on the oracle, in this process, with nothing
  // between them but a thread boundary and a Compartment.
  const walker = await walkerRun(SOURCE, { runId: "host-1", handler: new SimHandler(SCRIPT) });
  ok(
    "the journal it brings back is the WALKER'S, entry for entry",
    JSON.stringify(got.entries) === JSON.stringify(walker.journal.entries()),
    { worker: got.entries.map((e) => `${e.kind}#${e.occurrence}/${e.status}`), walker: walker.journal.entries().map((e) => `${e.kind}#${e.occurrence}/${e.status}`) },
  );
  ok("and there were entries to compare", got.entries.length === 2, got.entries.length);
  ok("the pins crossed intact", JSON.stringify(got.pins) === JSON.stringify(walker.pins), { worker: got.pins, walker: walker.pins });
  ok("and the hash is the source's, as it is in this process", got.programHash === walker.programHash);
  // Reported rather than bounded tightly: the number is the point, and a tight bound on a shared
  // machine is a flaky cell. Measured on this floor at 22.8-26.4ms for the thread alone.
  ok(`a cold worker run took ${coldMs}ms, thread and lockdown included`, coldMs < 30_000, coldMs);
}

{
  // THE CONFINEMENT, MEASURED THROUGH THE REAL WORKER rather than in a probe beside it. What the
  // program can reach is the whole security claim, so it is asked from inside the Compartment the
  // shipping path builds.
  const PROBE = `(ctx) => async () => {
    await ctx.fuel();
    const probe = (f) => { try { f(); return "ran"; } catch (e) { return "threw"; } };
    return ctx.born({
      dateNow: probe(() => Date.now()),
      mathRandom: probe(() => Math.random()),
      processIs: typeof process,
      ownGlobals: Object.keys(globalThis).length,
      sharesIntrinsics: ({}).constructor === Object,
      functionEscape: probe(() => (function () {}).constructor("return typeof process")()),
    });
  }`;
  const answer = await runInWorker({
    source: `log("x", 1);`,
    module: PROBE,
    runId: "confine-1",
    handler: { module: SIM_HANDLER, config: {} },
  }, { entry: WORKER_ENTRY }).done;
  ok("the confinement probe ran", answer.ok === true, JSON.stringify(answer).slice(0, 200));
  const seen = (answer as Extract<typeof answer, { ok: true }>).value as Record<string, unknown>;
  ok("inside the Compartment `Date.now()` throws", seen.dateNow === "threw", seen.dateNow);
  ok("and so does `Math.random()`", seen.mathRandom === "threw", seen.mathRandom);
  ok("`process` is not there at all", seen.processIs === "undefined", seen.processIs);
  ok("and `globalThis` has no own keys: the seam is the CALL ARGUMENT, never a global", seen.ownGlobals === 0, seen.ownGlobals);
  ok("the Function-constructor escape is refused", seen.functionEscape === "threw", seen.functionEscape);
  // CONFINEMENT, NOT HIDING, and it is asserted rather than left as a footnote: the program shares
  // the realm's intrinsics and simply cannot reach out of it. A cell that expected otherwise would
  // be testing a different security model than the one this host actually has.
  ok("while `({}).constructor === Object` still holds, which is the model", seen.sharesIntrinsics === true, seen.sharesIntrinsics);
}

{
  // CANCELLATION IS THE ONLY THING THAT CROSSES DURING A RUN, and it crosses through shared memory
  // because `shouldStop` is read synchronously between effects. No wall-clock timeout and no
  // terminate() on a deadline: a thread killed mid-effect leaves a step pending with nothing able
  // to settle it.
  const SPIN = `(ctx) => async () => {
    for (let i = 0; i < 50; i += 1) {
      await ctx.fuel();
      await ctx.effect("sleep", ["1s"]);
    }
    return "finished";
  }`;
  const run = runInWorker({
    source: `await sleep("1s");`,
    module: SPIN,
    runId: "stop-1",
    handler: { module: SIM_HANDLER, config: {} },
  }, { entry: WORKER_ENTRY });
  run.stop("the operator asked this run to stop");
  const answer = await run.done;
  ok("a stopped run ends through its own cancellation path", answer.ok === false, JSON.stringify(answer).slice(0, 160));
  const failed = answer as Extract<typeof answer, { ok: false }>;
  ok("and it carries the reason the host wrote into shared memory", failed.message.includes("the operator asked this run to stop"), failed.message.slice(0, 120));
}

{
  // A run whose value cannot cross answers to the LANGUAGE's crossing rule, not to the structured
  // clone algorithm's: a DataCloneError would name a host algorithm for something the language
  // already has a word for.
  // CAPTURED rather than awaited into the assertion: unrefused, a function reaches `postMessage` and
  // the thread dies on a DataCloneError with nothing to answer with, which awaited here would kill
  // the suite anonymously instead of failing the cell that names the rule.
  let answer: Awaited<ReturnType<typeof runInWorker>["done"]> | unknown;
  try {
    answer = await runInWorker({
      source: `log("x", 1);`,
      module: `(ctx) => async () => { await ctx.fuel(); return () => 1; }`,
      runId: "cross-1",
      handler: { module: SIM_HANDLER, config: {} },
    }, { entry: WORKER_ENTRY }).done;
  } catch (e) {
    answer = e;
  }
  const failed = answer as { ok?: boolean; name?: string; message?: string };
  ok("a run that returns a function is refused by the crossing rule", failed.ok === false, JSON.stringify(answer).slice(0, 160));
  ok("and the refusal names the language's rule, not a clone algorithm", failed.name === "NotCrossable", { name: failed.name, message: String(failed.message).slice(0, 100) });
}

{
  // A HANDLER IS NOT SERIALISABLE - it holds sockets, a client and a clock - so the request names a
  // module and the thread builds the handler there. A module that cannot build one says so by name.
  const answer = await runInWorker({
    source: `log("x", 1);`,
    module: `(ctx) => async () => { await ctx.fuel(); return 1; }`,
    runId: "nohandler-1",
    handler: { module: SIM_HANDLER, export: "nothingHere", config: {} },
  }, { entry: WORKER_ENTRY }).done;
  ok("a request naming an export that is not there is refused", answer.ok === false, JSON.stringify(answer).slice(0, 160));
  const missing = answer as Extract<typeof answer, { ok: false }>;
  ok("and the refusal names the export it looked for", missing.message.includes("nothingHere"), missing.message.slice(0, 140));
}

{
  // A RESUME THROUGH THE THREAD: the recorded entries go in, the recorded results come back, and
  // the handler is never asked. The journal is not a transcript - it is what a resumed run reads
  // INSTEAD of dispatching - so this is the shape that says the boundary preserved it.
  const first = await runInWorker({
    source: SOURCE,
    module: MODULE,
    runId: "resume-w",
    handler: { module: SIM_HANDLER, config: SCRIPT },
  }, { entry: WORKER_ENTRY }).done;
  ok("the first run recorded its steps", first.ok === true && first.entries.length === 2, JSON.stringify(first).slice(0, 160));
  const recorded = (first as Extract<typeof first, { ok: true }>);
  const again = await runInWorker({
    source: SOURCE,
    module: MODULE,
    runId: "resume-w",
    handler: { module: SIM_HANDLER, config: {} },
    pins: recorded.pins,
    entries: recorded.entries,
  }, { entry: WORKER_ENTRY }).done;
  ok("the resume completes against an EMPTY script", again.ok === true, JSON.stringify(again).slice(0, 200));
  const back = again as Extract<typeof again, { ok: true }>;
  ok(
    "and its journal is the first run's, entry for entry",
    JSON.stringify(back.entries) === JSON.stringify(recorded.entries),
    { first: recorded.entries.length, again: back.entries.length },
  );
}

// ---- 17) the concurrency scopes -----------------------------------------------------------------
//
// The engine calls the SAME `performScope` and `runScope` the walker calls, with the same arguments
// in the same order. So these cells are comparisons, not re-derivations: what they have to show is
// that the two things this side owns - the calling convention and the missing AST - leave the
// journal byte-identical.

{
  /**
   * The call site's static payload, computed the way the emitter will compute it: the arm bodies
   * with positions stripped, keyed by branch name. Parsed from the SOURCE here rather than written
   * out by hand, because a hand-written copy of a stripped AST is a second answer to what the
   * walker digests.
   */
  const siteFor = (source: string, combinator: string): Site | undefined => {
    const program = parse(source, { ecmaVersion: "latest", sourceType: "module", allowAwaitOutsideFunction: true }) as unknown as Record<string, unknown>;
    let arms: Record<string, unknown> | undefined;
    const walk = (node: unknown): void => {
      if (node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const c of node) walk(c);
        return;
      }
      const n = node as Record<string, unknown>;
      if (n.type === "CallExpression" && (n.callee as { name?: string } | undefined)?.name === combinator) {
        const first = (n.arguments as unknown[])[0] as Record<string, unknown> | undefined;
        if (first?.type === "ObjectExpression") {
          const out: Record<string, unknown> = {};
          for (const prop of first.properties as Record<string, unknown>[]) {
            const key = prop.key as { name?: string; value?: string } | undefined;
            const named = key?.name ?? key?.value;
            if (named !== undefined) out[named] = stripPositions(prop.value);
          }
          arms = out;
        }
      }
      for (const v of Object.values(n)) walk(v);
    };
    walk(program);
    return arms === undefined ? undefined : { branchDigests: arms };
  };

  /** The site as the emitter writes it INTO the module: a literal, because the engine has no AST. */
  const siteLiteral = (source: string, combinator: string): string => JSON.stringify(siteFor(source, combinator) ?? {});

  /** One program on both engines, compared on what a run IS: its value, its log, and its journal. */
  const both = async (
    label: string,
    source: string,
    module: string,
    script: ConstructorParameters<typeof SimHandler>[0] = {},
  ): Promise<{ walker: Awaited<ReturnType<typeof walkerRun>>; engine: Awaited<ReturnType<typeof runOnEngine>> }> => {
    const wLogs: unknown[][] = [];
    const eLogs: unknown[][] = [];
    const walker = await walkerRun(source, { runId: "scope-1", handler: new SimHandler(script), onLog: (l) => wLogs.push([...l.values]) });
    // The journal is handed IN, so a refusal still leaves this side something to compare - and so a
    // refusal fails the cell that names it rather than leaving the block and killing the suite.
    const journal = new Journal({ run: "scope-1" });
    let engine: Awaited<ReturnType<typeof runOnEngine>> | undefined;
    let refused: unknown;
    try {
      engine = await runOnEngine(source, module, {
        runId: "scope-1",
        handler: new SimHandler(script),
        evaluate: plainly,
        journal,
        onLog: (l) => eLogs.push([...l.values]),
      });
    } catch (e) {
      refused = e;
    }
    ok(`${label}: the engine ran a program the walker ran, rather than refusing it`, refused === undefined, String(refused));
    ok(`${label}: the journals are IDENTICAL, entry for entry`, JSON.stringify(walker.journal.entries()) === JSON.stringify(journal.entries()), {
      walker: walker.journal.entries().map((e) => `${e.kind}:${e.name}#${e.occurrence}/${e.status}`),
      engine: journal.entries().map((e) => `${e.kind}:${e.name}#${e.occurrence}/${e.status}`),
    });
    ok(`${label}: and the scope was actually journalled`, journal.entries().length > 1, journal.entries().length);
    ok(`${label}: the log is the same`, JSON.stringify(wLogs) === JSON.stringify(eLogs), { walker: wLogs, engine: eLogs });
    return { walker, engine: engine as Awaited<ReturnType<typeof runOnEngine>> };
  };

  // ---- parallel ---------------------------------------------------------------------------------
  const PARALLEL = `
const r = await parallel({
  a: async () => { await sleep("1s", { name: "s" }); return 1; },
  b: async () => { await sleep("2s", { name: "t" }); return 2; },
}, { name: "both" });
log("a", r.a);
`;
  await both(
    "parallel",
    PARALLEL,
    `(ctx) => async () => {
      await ctx.fuel();
      const r = await ctx.effect("parallel", [
        ctx.born({
          a: async () => { await ctx.fuel(); await ctx.effect("sleep", ["1s", ctx.born({ name: "s" })]); return 1; },
          b: async () => { await ctx.fuel(); await ctx.effect("sleep", ["2s", ctx.born({ name: "t" })]); return 2; },
        }),
        ctx.born({ name: "both" }),
      ]);
      await ctx.free("log", ["a", ctx.get(r, "a")]);
    }`,
  );

  // ---- race, and the digest the engine has no AST to compute --------------------------------------
  const RACE = `
const r = await race({
  quick: async () => { await sleep("1s", { name: "q" }); return "quick"; },
  slow: async () => { await sleep("9s", { name: "w" }); return "slow"; },
}, { name: "first" });
log("won", r.index);
`;
  const RACE_MODULE = `(ctx) => async () => {
      await ctx.fuel();
      const r = await ctx.effect("race", [
        ctx.born({
          quick: async () => { await ctx.fuel(); await ctx.effect("sleep", ["1s", ctx.born({ name: "q" })]); return "quick"; },
          slow: async () => { await ctx.fuel(); await ctx.effect("sleep", ["9s", ctx.born({ name: "w" })]); return "slow"; },
        }),
        ctx.born({ name: "first" }),
      ], ${siteLiteral(RACE, "race")});
      await ctx.free("log", ["won", ctx.get(r, "index")]);
    }`;
  const raced = await both("race", RACE, RACE_MODULE);
  const scopeEntry = raced.engine.journal.entries().find((e) => e.kind === "race");
  ok("a settled race records a branchDigest over its unwalked arms", typeof scopeEntry?.branchDigest === "string", scopeEntry?.branchDigest);
  ok(
    "and it is the WALKER'S digest, computed from the site rather than from an AST",
    scopeEntry?.branchDigest === raced.walker.journal.entries().find((e) => e.kind === "race")?.branchDigest,
    { engine: scopeEntry?.branchDigest, walker: raced.walker.journal.entries().find((e) => e.kind === "race")?.branchDigest },
  );

  // THE DIGEST'S ONLY JOB, and it is asserted rather than assumed from the entry's presence: a
  // settled race is delivered from its entry WITHOUT entering a branch, so an edit inside a losing
  // arm reaches nothing that could notice it. The winner needs no digest - its arm is walked entry
  // by entry and an edit there diverges at the step it broke, which is a better error than this one.
  const EDITED = RACE.replace('return "slow";', 'return "slower, by a lot";');
  const editedModule = RACE_MODULE.replace(siteLiteral(RACE, "race"), siteLiteral(EDITED, "race"));
  ok("the edited arm really did change the site", editedModule !== RACE_MODULE);
  const diverged = await caught(() =>
    resumeOnEngine(RACE, editedModule, raced.engine.journal, {
      runId: "scope-1",
      handler: new SimHandler({}),
      evaluate: plainly,
      pins: raced.engine.pins,
    }),
  );
  ok("an edit inside a LOSING arm diverges on resume", diverged instanceof RunDivergence, String(diverged));
  // The control: the same site resumes clean, so the cell above is grading the edit and not the
  // resume itself.
  const clean = await resumeOnEngine(RACE, RACE_MODULE, raced.engine.journal, {
    runId: "scope-1",
    handler: new SimHandler({}),
    evaluate: plainly,
    pins: raced.engine.pins,
  });
  ok("while the unedited race resumes clean", JSON.stringify(clean.journal.entries()) === JSON.stringify(raced.walker.journal.entries()));
  // A RENAMED loser is an edit too: the site no longer carries that name, and the walker digests a
  // name it cannot find as `null`, so the two answers differ.
  const renamedModule = RACE_MODULE.replace(siteLiteral(RACE, "race"), siteLiteral(RACE.replace(/slow:/g, "sluggish:"), "race"));
  const renamed = await caught(() =>
    resumeOnEngine(RACE, renamedModule, raced.engine.journal, {
      runId: "scope-1",
      handler: new SimHandler({}),
      evaluate: plainly,
      pins: raced.engine.pins,
    }),
  );
  ok("a RENAMED losing arm diverges too", renamed instanceof RunDivergence, String(renamed));

  // ---- fanOut ------------------------------------------------------------------------------------
  const FANOUT = `
const xs = [{ id: "a" }, { id: "b" }];
const out = await fanOut(xs, async (item) => { await sleep("1s", { name: "each" }); return item.id; }, { name: "f", key: (i) => i.id });
log("out", out);
`;
  await both(
    "fanOut",
    FANOUT,
    `(ctx) => async () => {
      await ctx.fuel();
      const xs = ctx.born([ctx.born({ id: "a" }), ctx.born({ id: "b" })]);
      const out = await ctx.effect("fanOut", [
        xs,
        // THE BODY, UNEVALUATED. See \`deferredBody\`: the walker evaluates this argument after the
        // scope's entry has begun, so an already-evaluated one journals its effects in the wrong place.
        async () => async (item) => { await ctx.fuel(); await ctx.effect("sleep", ["1s", ctx.born({ name: "each" })]); return ctx.get(item, "id"); },
        ctx.born({ name: "f", key: (i) => ctx.get(i, "id") }),
      ]);
      await ctx.free("log", ["out", out]);
    }`,
  );

  // ---- conclave ----------------------------------------------------------------------------------
  const CONCLAVE = `
const a = await spawn("a", { name: "hire" });
const out = await conclave([a], async (room) => { await sleep("1s", { name: "in" }); return 1; }, { name: "c" });
log("out", out);
`;
  await both(
    "conclave",
    CONCLAVE,
    `(ctx) => async () => {
      await ctx.fuel();
      const a = await ctx.effect("spawn", ["a", ctx.born({ name: "hire" })]);
      const out = await ctx.effect("conclave", [
        ctx.born([a]),
        async () => async (room) => { await ctx.fuel(); await ctx.effect("sleep", ["1s", ctx.born({ name: "in" })]); return 1; },
        ctx.born({ name: "c" }),
      ]);
      await ctx.free("log", ["out", out]);
    }`,
  );
}

// ---- 18) ruling 1b's closure obligation ----------------------------------------------------------
//
// 1b struck the return-path thenable door after this lane refuted it by measurement, and replaced it
// with an OBLIGATION: the gate is born() + set() + await() only as long as no builtin can hand the
// program a record carrying an own callable `then`. That property is held here rather than assumed,
// over the whole builtin table, so a name added to it reds this cell until somebody classifies it.
//
// Nothing below is a copy of the answer. The probe is a matrix of ARGUMENT SHAPES applied to every
// name in `BUILTINS`; which names answer a record is measured, not listed.

{
  const h = harness();
  const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

  await h.inFrame(async () => {
    const rec = h.ctx.born({ a: 1, then: 2 });
    const other = h.ctx.born({ b: 2 });
    const fn = (x: unknown): unknown => x;
    const SHAPES: unknown[][] = [
      [], [rec], [rec, other], [rec, "zz"], [rec, [9, 8]], [rec, 5], [rec, fn],
      ["a"], ["a", "b"], [1], [1, 2], [[1, 2]], [[1, 2], fn], [`{"then":1,"a":2}`], [`{"a":1}`],
    ];

    const answeredRecord = new Set<string>();
    const readRecord = new Set<string>();
    const carriedCallableThen: string[] = [];
    let probes = 0;
    for (const name of BUILTINS) {
      const asValue = h.ctx.free(name);
      if (isRecord(asValue)) readRecord.add(name);
      for (const args of SHAPES) {
        probes += 1;
        let answer: unknown;
        try {
          answer = await (h.ctx.free(name, args) as unknown);
        } catch {
          continue; // A refusal is the common case here and is not the subject.
        }
        if (!isRecord(answer)) continue;
        answeredRecord.add(name);
        if (typeof answer.then === "function") carriedCallableThen.push(`${name}(${JSON.stringify(args.map((a) => (typeof a === "function" ? "fn" : a)))})`);
      }
    }

    const same = (got: ReadonlySet<string>, want: readonly string[]): boolean =>
      got.size === want.length && want.every((n) => got.has(n));

    // The universe, and its own failure mode: a probe that found nothing would pass every set
    // comparison below it.
    ok(`the whole builtin table was probed: ${BUILTINS.length} names x ${SHAPES.length} shapes`, probes === BUILTINS.length * SHAPES.length && BUILTINS.length > 0, { probes, names: BUILTINS.length });
    ok("the ONLY builtin whose call answers a record is `merge`", same(answeredRecord, ["merge"]), [...answeredRecord]);
    ok("and the only one whose READ form is a record is the `json` namespace", same(readRecord, ["json"]), [...readRecord]);
    // THE OBLIGATION ITSELF.
    ok("no answer anywhere in the matrix carried an own CALLABLE `then`", carriedCallableThen.length === 0, carriedCallableThen);

    // AND THE RULING'S STATED REASON, CORRECTED BY MEASUREMENT. 1b says merge's "output keys derive
    // from record arguments that already passed born()". They do not, quite: a non-record argument
    // contributes index keys. The property that actually holds is the one asserted above - a minted
    // key cannot carry a callable - and it is worth having the difference written down, because a
    // reason nobody re-measured is how a struck door gets rebuilt.
    ok(
      "merge mints index keys from a NON-record argument, so the keys are not all born-derived",
      JSON.stringify(await h.ctx.free("merge", [h.ctx.born({ a: 1 }), "zz"])) === '{"0":"z","1":"z","a":1}',
      await h.ctx.free("merge", [h.ctx.born({ a: 1 }), "zz"]),
    );
    ok(
      "and from an array argument too",
      JSON.stringify(await h.ctx.free("merge", [h.ctx.born({ a: 1 }), [9, 8]])) === '{"0":9,"1":8,"a":1}',
      await h.ctx.free("merge", [h.ctx.born({ a: 1 }), [9, 8]]),
    );

    // WHAT KEEPS THE DOOR SHUT, both halves measured. The program cannot build the input:
    ok("born refuses a record with an own callable `then`", codeOf(await caught(() => h.ctx.born({ then: () => 1 }))) === "L4018");
    ok("and set refuses writing one onto a born record", codeOf(await caught(() => h.ctx.set(h.ctx.born({ a: 1 }), "then", () => 1))) === "L4018");
    // And a callable `then` that reaches a builtin from OUTSIDE the seam never comes back as a
    // record at all: library.ts's own `async` wrapper assimilates it one frame before any
    // return-path check could look. Measured - the call answers 7, the resolved value, not the
    // record. That is the refutation 1b was built on, kept as a cell so it stays true.
    const assimilated = await h.ctx.free("merge", [h.ctx.born({ a: 1 }), { then: (r: (v: unknown) => void) => r(7) }]);
    ok("a callable `then` reaching a builtin is ASSIMILATED inside library.ts, not returned", assimilated === 7, assimilated);

    // json.parse mints keys from a STRING - a non-record input - and is safe for a different reason
    // than merge: JSON cannot express a function, so its `then` is never callable.
    const parsed = await h.ctx.call(h.ctx.free("json"), "parse", [`{"then":1,"a":2}`]);
    ok("json.parse mints record keys from text, and its `then` cannot be callable", isRecord(parsed) && parsed.then === 1 && typeof parsed.then !== "function", parsed);
  });
}

// ---- 19) F7: the cell read, and the ReferenceError that is never the program's -------------------
//
// A binding the transform classifies as a CELL is emitted as `born({})` hoisted to the top of its
// block, `set(cell, "v", init)` at the declaration, and every read as `get(cell, "v", "x")`. The
// third argument is the whole host clause (ruled a third argument, not a fifteenth member): an
// absent OWN key means the declaration has not run, which is L2004 for that binding by name.

{
  const h = harness();

  // The oracle's own words, taken from the oracle rather than transcribed: a hoisted function called
  // before the `const` it reads.
  const fromWalker = await caught(() =>
    walkerRun(`const r = f();\nfunction f() { return x; }\nconst x = 1;\nlog("r", r);\n`, { runId: "f7", handler: new SimHandler({}) }),
  );
  ok("the walker refuses a TDZ read at run time with L2004", codeOf(fromWalker) === "L2004", String(fromWalker));

  const cell = await h.inFrame(() => h.ctx.born({}));
  const fromEngine = await caught(() => h.inFrame(() => h.ctx.get(cell, "v", "x")));
  ok("and so does the engine, when the cell has no own key yet", codeOf(fromEngine) === "L2004", String(fromEngine));
  // BYTE-IDENTICAL, and compared rather than eyeballed: the sentence lives inside interpret.ts's
  // `Env.get` and is not exported, so this cell is what keeps the copy from drifting off the source.
  ok(
    "with the WALKER'S message, word for word",
    (fromEngine as Error).message === (fromWalker as Error).message,
    { engine: (fromEngine as Error).message.slice(0, 80), walker: (fromWalker as Error).message.slice(0, 80) },
  );

  // PRESENCE IS `hasOwn`, NOT TRUTHINESS. A binding initialised to `undefined` HAS been initialised,
  // and a truthiness test would refuse it - the one shape where the two rules disagree.
  const initialised = await h.inFrame(() => {
    const c = h.ctx.born({});
    h.ctx.set(c, "v", undefined);
    return c;
  });
  // CAPTURED: a presence test written as truthiness REFUSES both of these, and the throw would leave
  // the block and kill the suite instead of failing the cell that names the rule.
  const readCell = async (c: unknown): Promise<unknown> => {
    try {
      return await h.inFrame(() => h.ctx.get(c, "v", "x"));
    } catch (e) {
      return e;
    }
  };
  ok("a cell holding `undefined` is INITIALISED, and reads as undefined", (await readCell(initialised)) === undefined, String(await readCell(initialised)));
  const zero = await h.inFrame(() => {
    const c = h.ctx.born({});
    h.ctx.set(c, "v", 0);
    return c;
  });
  ok("and so is one holding 0", (await readCell(zero)) === 0, String(await readCell(zero)));

  // Without the argument, `get` is byte-unchanged: an absent field is undefined, as it always was.
  ok("without a binding name, an absent field is still just undefined", (await h.inFrame(() => h.ctx.get(cell, "v"))) === undefined);

  // The CAUGHT form. The walker's answer, measured: ["L2004", "runtime"].
  const wLogs: unknown[][] = [];
  await walkerRun(`function f() { return x; }\ntry { f(); } catch (e) { log("code", e.code); log("kind", e.kind); }\nconst x = 1;\n`, {
    runId: "f7c",
    handler: new SimHandler({}),
    onLog: (l) => wLogs.push([...l.values]),
  });
  ok("the walker's caught TDZ read is L2004/runtime", JSON.stringify(wLogs) === '[["code","L2004"],["kind","runtime"]]', wLogs);
  const asProgramError = h.ctx.caught(fromEngine) as { code?: string; kind?: string };
  ok("and the engine's catch head answers the same record", asProgramError.code === "L2004" && asProgramError.kind === "runtime", asProgramError);

  // THE LOUD CLAUSE. A native ReferenceError is not a program error and is not converted into one.
  let boom: unknown;
  try {
    boom = h.ctx.caught(new ReferenceError("zzz is not defined"));
  } catch (e) {
    boom = e;
  }
  ok("the loud clause: a native ReferenceError is the ONLY thing between an emitter temp bug and a program-visible value, so the catch head rethrows it", boom instanceof Error && (boom as Error).name === "EngineFault", String(boom));
  ok("and it is NOT converted to a program error", (boom as { code?: string }).code === undefined, boom);
  ok("nor message-parsed into L2004", !(boom as Error).message.includes("L2004"), (boom as Error).message.slice(0, 120));
  ok("while it carries what actually happened", (boom as Error).message.includes("zzz is not defined"), (boom as Error).message.slice(0, 160));
  // And a nested catch cannot swallow it either: it is uncatchable by class.
  let again: unknown;
  try {
    again = h.ctx.caught(boom);
  } catch (e) {
    again = e;
  }
  ok("an emitted catch around it rethrows rather than catching", again === boom, String(again));

  // AT THE RUN BOUNDARY, which is the other place it can surface: a program with no `try` has
  // nothing to route the bad read through, so it arrives at the host instead.
  const escaped = await caught(() =>
    runOnEngine(`log("x", 1);`, `(ctx) => async () => { await ctx.fuel(); return zzz; }`, {
      runId: "f7-boundary",
      handler: new SimHandler({}),
      evaluate: plainly,
    }),
  );
  ok("a ReferenceError escaping the whole run is an ENGINE fault too", (escaped as Error).name === "EngineFault", String(escaped));
  ok("and it names why a free identifier cannot be the program's fault", (escaped as Error).message.includes("zero free identifiers"), (escaped as Error).message.slice(0, 200));
}

// ---- 20) the worker entry is an INPUT, and the node floor ----------------------------------------
//
// Lane 1 set the wave's floor at node 24 for AsyncContextFrame ALS. Probed, that reason does not
// reproduce: ALS propagates 9 of 9 shapes on 22.23.2 - plain await, across the setTimeout macrotask
// the fuel yield uses, both arms of a Promise.all, after a custom thenable, across nextTick and
// setImmediate, and a nested run restoring its parent - and the worker from `dist` on 22 answers the
// same value with the same confinement and the same programHash. Nothing in the RUNTIME needs 24, so
// the floor is the measured one, 22, and a floor at 24 would refuse ground this engine works on.
//
// What actually broke on 22 was the DEV PATH: tsx's ESM loader does not reach a worker thread there,
// so a `.ts` entry dies on its own `../journal.js` and a `.js` one is not found at all - with or
// without an explicit `--import tsx` on the Worker, and inherited execArgv already carries one. That
// is not a runtime bound and is not answered with a version number. It is answered by the entry
// being an INPUT: `worker.ts` derives nothing, section 16 hands it the built artifact, and
// `smoke:lang-engine` builds first. These cells hold that, and hold the floor at its measured value.

{
  const entry = fileURLToPath(WORKER_ENTRY);
  ok("the built worker entry section 16 spawned EXISTS on disk", existsSync(entry), entry);
  // MECHANIZED, not narrated: the leg names `dist`. A cell that only said so in prose would keep
  // saying it after someone pointed the leg back at `src` and made it a node-26-only suite again.
  ok("and the worker leg runs it from `dist`, not from the sources beside this file", entry.includes("/dist/") && !entry.includes("/src/"), entry);

  // THE HOST DERIVES NO ENTRY, which is the rule the ruling put in place of a version check. Asked
  // for a run with none, nothing starts: no default, no probe of this module's own extension, and
  // above all no thread spawned at a path nobody chose. CAPTURED rather than awaited into the
  // assertion, because the point of the cell is the throw.
  let noEntry: unknown;
  try {
    noEntry = runInWorker(
      { source: `log("x", 1);`, module: `(ctx) => async () => { await ctx.fuel(); return 1; }`, runId: "no-entry", handler: { module: SIM_HANDLER, config: {} } },
      {} as never,
    );
  } catch (e) {
    noEntry = e;
  }
  ok("a request with NO entry starts no thread at all", noEntry instanceof Error, JSON.stringify(String(noEntry)).slice(0, 140));
  ok("and it is the missing filename it names, not a default it reached for", String((noEntry as Error).message).includes("filename"), String((noEntry as Error).message).slice(0, 140));

  // AND NOTHING IS EXPORTED TO REACH FOR: the module offers no entry constant a caller could pick up
  // instead of deciding. This is the half the cell above cannot see, since a derivation could live
  // outside `runInWorker` and be handed in by a second caller.
  const exported = Object.keys(workerModule);
  ok("the worker module exports no entry for a caller to inherit", exported.every((k) => !/entry/i.test(k)), exported);
}

{
  ok(`the floor is a single named constant, and it is the measured ${NODE_FLOOR}`, NODE_FLOOR === 22, NODE_FLOOR);
  // MECHANIZED, not remembered: the engine refuses below the floor the REPO declares it supports, so
  // the two are compared rather than kept in agreement by hand.
  const declared = JSON.parse(readFileSync(fileURLToPath(new URL("../../../package.json", import.meta.url)), "utf8")) as { engines?: { node?: string } };
  const floorOf = (range: string | undefined): number => Number(String(range).replace(/[^0-9.]/g, "").split(".")[0]);
  ok(`the repo declares node ${declared.engines?.node}, and the engine refuses below the same major`, floorOf(declared.engines?.node) === NODE_FLOOR, { declared: declared.engines?.node, floor: NODE_FLOOR });
  const below = await caught(() => assertNodeFloor("20.19.0"));
  ok("a node below the floor is refused by major version", below instanceof RuntimeFault, String(below));
  ok("and the refusal names both the version it found and the floor", (below as Error).message.includes("20.19.0") && (below as Error).message.includes("node 22"), (below as Error).message.slice(0, 120));
  ok("the floor itself is allowed", (await caught(() => assertNodeFloor("22.23.2"))) === undefined);
  ok("and anything above it", (await caught(() => assertNodeFloor("26.7.0"))) === undefined);
  // A version string it cannot read is NOT refused: refusing on an unparseable version would fail a
  // run for the shape of a string rather than for the runtime under it.
  ok("an unreadable version is not refused on the strength of being unreadable", (await caught(() => assertNodeFloor("not-a-version"))) === undefined);
  // AND THE LIVE ONE, which is the reachability half: every cell above this line has already run a
  // program through `runOnEngine`, so the boundary check is reached on every one of them. The mutant
  // that raises the floor past every version that exists reds the first of them.
  ok(`this run is on node ${process.versions.node}, which the boundary check accepted`, (await caught(() => assertNodeFloor(process.versions.node))) === undefined);
}

console.log(`engine.smoke: ${pass} checks passed`);
