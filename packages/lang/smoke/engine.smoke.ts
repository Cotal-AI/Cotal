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
import { RuntimeFault } from "../src/errors.js";
import { Cancelled } from "../src/effects.js";
import { SimHandler } from "../src/sim.js";
import { createCtx, createEngine, type EngineCtx, type EngineRun } from "../src/engine/ctx.js";
import { runOnEngine } from "../src/engine/host.js";
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
    return undefined;
  });
  ok("a record operand is L4018, on either side", codeOf(await caught(() => h.inFrame(() => h.ctx.binary("+", {}, 1)))) === "L4018");
  ok("including the right-hand side", codeOf(await caught(() => h.inFrame(() => h.ctx.binary("+", 1, {})))) === "L4018");
  ok("a record interpolated into a template is L4018", codeOf(await caught(() => h.inFrame(() => h.ctx.template(["", ""], [{}])))) === "L4018");
  ok("a function interpolated is L4018 too", codeOf(await caught(() => h.inFrame(() => h.ctx.template(["", ""], [(): number => 1])))) === "L4018");
  ok("a record is not iterable (L4015)", codeOf(await caught(() => h.inFrame(() => h.ctx.iter({})))) === "L4015");
  ok("and neither is null", codeOf(await caught(() => h.inFrame(() => h.ctx.iter(null)))) === "L4015");
  ok("an unsupported unary operator is L1000, not a silent answer", codeOf(await caught(() => h.inFrame(() => h.ctx.unary("void", 1)))) === "L1000");
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

// ---- 10) the scope-openers refuse loudly until they are landed -----------------------------------

{
  const h = harness();
  const e = await caught(() => h.inFrame(() => h.ctx.effect("parallel", [{}])));
  ok(
    "a concurrency combinator refuses rather than silently running sequentially",
    codeOf(e) === "L1000" && (e as Error).message.includes("not landed yet"),
    String(e),
  );
  ok("and no journal entry was written for it", h.run.journal.entries().length === 0, h.run.journal.entries().length);
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

/** A plain evaluator. The confined path is the worker; this is a test process comparing two engines. */
const plainly = (module: string): ((ctx: EngineCtx) => () => Promise<unknown>) =>
  // eslint-disable-next-line no-eval
  (0, eval)(module) as (ctx: EngineCtx) => () => Promise<unknown>;

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
  const engine = await runOnEngine(SOURCE, MODULE, {
    runId: "host-1",
    handler: new SimHandler(SCRIPT),
    evaluate: plainly,
    onLog: (l) => logs.push([...l.values]),
  });

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
  let refused: unknown;
  try {
    await runOnEngine("const x = new Date();", MODULE, {
      runId: "host-bad",
      handler: new SimHandler({}),
      evaluate: plainly,
    });
  } catch (e) {
    refused = e;
  }
  ok("invalid source is refused before the module is ever evaluated", refused !== undefined, String(refused));

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

console.log(`engine.smoke: ${pass} checks passed`);
