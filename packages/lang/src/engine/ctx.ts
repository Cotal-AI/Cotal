/**
 * `__ctx`: the WHOLE seam between the transformed program and the host.
 *
 * The transform (lane T) emits a CLOSED function expression with zero free identifiers; the host
 * evaluates it in a Compartment with ZERO endowments and passes this object as the call argument
 * (seam ruling 1). So this file is the complete list of what a program can reach. Anything not
 * here is not reachable, which is why the member list is a surface both lanes hold each other to.
 *
 * Every law lives here, and every table it needs is IMPORTED. `library.ts` owns the curated method
 * tables and the free builtins; `values.ts` owns freezing, birth-depth stamping and the crossing
 * check; `keys.ts` owns key allocation; `journal.ts` owns the entries. Nothing in this file is a
 * second copy of any of them — a copied table is a table that disagrees with the walker on its
 * first edit, and the walker is the differential oracle.
 *
 * WHAT THIS FILE IS NOT: it is not the walker rewritten. The walker enforces these laws inline
 * while it walks; here they are the host side of a native program's calls. The behaviours must be
 * identical and the differential suite is what says so — same programs, walker and engine,
 * identical journals (entry sequences and step keys, not merely output).
 */

import { RuntimeFault } from "../errors.js";
import { Cancelled, EffectError, type EffectHandler } from "../effects.js";
import { arrayMethods, builtins, numberMethods, stringMethods, type Callable, type Method } from "../library.js";
import type { Journal } from "../journal.js";
import type { RunPins } from "../pins.js";
import { Prng, birthDepth, born as stampBirth, deepFreeze, setOwn } from "../values.js";
import { currentFrame, withFrame, type EngineFrame } from "./frame.js";
import { dispatchPrimitive, type EffectHost } from "../perform.js";
import { PRIMITIVES } from "../primitives.js";
import type { RunOptions } from "../interpret.js";

/**
 * A static per-call-site payload the transform computes from the input AST.
 *
 * It exists because the engine has NO AST at run time and one journal field is a function of one:
 * a settled `race` records a `branchDigest` over its unwalked arms. Without this the engine could
 * not produce a byte-identical entry for any race that settled, and the differential gate would
 * fail on shape rather than on behaviour.
 */
export interface Site {
  /** Branch key -> `digest(stripPositions(armBody))`, computed with the walker's own functions. */
  readonly branchDigests?: Readonly<Record<string, unknown>>;
}

/**
 * The seam. Thirteen members, and the count is the point: a member added here without a joint rule
 * is a widening, and lane T's surface cell reddens on any call to a name not on this interface.
 */
export interface EngineCtx {
  /** L4013 step budget, plus the yield that keeps the macrotask queue alive and applies the cut. */
  fuel(): void | Promise<void>;
  /** Read a member: L4014 (no prototype reach, curated tables), L4020, L4018 on a computed key. */
  get(o: unknown, k: unknown): unknown;
  /** Write a member: L2031, L2032, L4014, L4017, L4019. Answers `v`, as an assignment does. */
  set(o: unknown, k: unknown, v: unknown): unknown;
  /** Call a member. The single L4020 exception: a method is resolved AT the call and nowhere else. */
  call(o: unknown, k: unknown, args: unknown[]): Promise<unknown>;
  /** Stamp a freshly built container with this frame's depth (L2032's runtime half). */
  born<T>(v: T): T;
  /** A journalled primitive. */
  effect(name: string, args: unknown[], site?: Site): Promise<unknown>;
  /** A free builtin: called with `args`, or READ as a value when `args` is omitted. */
  free(name: string, args?: unknown[]): unknown;
  /** The thenable gate, before the host's await machinery can run a program closure. */
  await(v: unknown): Promise<unknown>;
  /** Template interpolation: L4018, no implicit conversion. */
  template(parts: readonly string[], values: readonly unknown[]): string;
  /** The binary operators' coercion law (L4018) and JavaScript's meaning. `===`/`!==` stay native. */
  binary(op: string, l: unknown, r: unknown): unknown;
  /** `-`, `+`, `~` under the same law. `!` and `typeof` stay native. */
  unary(op: string, v: unknown): unknown;
  /** The iterability law (L4015): arrays and strings, nothing else. */
  iter(v: unknown): unknown[];
  /** At the head of every emitted catch: rethrow the uncatchable, else the program-visible error. */
  caught(e: unknown): unknown;
}

/** What a run hands the seam. */
export interface EngineRun {
  readonly runId: string;
  readonly programHash: string;
  readonly journal: Journal;
  readonly handler: EffectHandler;
  readonly pins: RunPins;
  readonly onLog?: (line: { scope: string; values: readonly unknown[] }) => void;
  readonly shouldStop?: () => string | undefined;
}

// ---- the coercion law, shared by every site that can reach host ToPrimitive --------------------

/**
 * L4018, the one refusal that has to be spelled identically everywhere it applies.
 *
 * Converting reads `valueOf`/`toString` off the value, and a program closure stored there would run
 * from host machinery with no frame. The walker measured every one of these holes before closing
 * them; the engine inherits the closed shape rather than rediscovering it.
 */
function refuseCoercion(where: string, v: unknown): void {
  if (v !== null && (typeof v === "object" || typeof v === "function")) {
    const kind = typeof v === "function" ? "a function" : Array.isArray(v) ? "an array" : "a record";
    throw new RuntimeFault(
      "L4018",
      `\`${where}\` cannot take ${kind}: there is no implicit conversion here, because converting would read \`valueOf\`/\`toString\` off the value — host machinery this language does not have. Convert explicitly: \`json.stringify(value)\` for text, or read the field you mean.`,
    );
  }
}

/** A canonical array index (`"0"`, `"12"`), as a number, or nothing. */
function arrayIndex(prop: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(prop)) return undefined;
  const n = Number(prop);
  return n <= 4294967294 ? n : undefined;
}

// ---- the thenable gate -------------------------------------------------------------------------

/**
 * An own CALLABLE `then` on a program value, refused where it is minted.
 *
 * Measured at 9dc154f8 (node v26.7.0, ses@2.3.0), inside the compartment, one shot per site:
 * constructing such a record is harmless, but RETURNING it out of any async function assimilates
 * it — `then(resolve, reject)` runs, with the host's settlement functions as its arguments — and so
 * does awaiting it, and so does a function carrying an own `then`. Every transformed function body
 * is async, so the hazard sits at every return of a program value, not merely at `await`.
 *
 * The refusal is scoped to a CALLABLE `then` because a non-callable one is legal and settles clean
 * on the walker (`{ then: 1 }` runs to completion); refusing every own `then` would refuse a program
 * the oracle accepts.
 *
 * Two doors close the whole value graph, by induction: a callable `then` can only enter through a
 * literal (`born`) or a field write (`set`) — `json.parse` cannot spell a function, and spread,
 * `merge` and the array methods only copy fields out of records that already passed a door. `await`
 * is gated too, because a value can also arrive from the host side of the seam.
 *
 * THERE IS DELIBERATELY NO CHECK ON THE HOST'S RETURN PATH, and the reason is measured rather than
 * argued. Seam ruling 1a asked for one at `free`/`call`, on the strength of `merge({}, { then: f })`
 * minting the shape on the WALKER. It cannot exist: every builtin and curated method in library.ts
 * returns through its own `async` wrapper, so the assimilation happens INSIDE library.ts, one frame
 * before any host code could inspect the result. Measured directly against `merge`: with a `then`
 * that never resolves, the builtin's promise never settles at all (the program closure had already
 * run); with a `then` that resolves, the record is silently REPLACED by whatever it resolves with.
 * In both cases the value a return-path gate would examine is either never delivered or already
 * substituted, so such a gate is unreachable code that no mutant can kill. The walker shape it was
 * meant to cover is a walker defect (there is no birth gate there at all) and belongs to the filed
 * issue; in the engine the literal never reaches `merge`, because `born` refuses it first — which is
 * a cell, not an assertion.
 */
function hasCallableThen(v: unknown): boolean {
  if (v === null || (typeof v !== "object" && typeof v !== "function")) return false;
  if (!Object.prototype.hasOwnProperty.call(v, "then")) return false;
  return typeof (v as { then?: unknown }).then === "function";
}

function refuseThenable(v: unknown, where: string): void {
  if (!hasCallableThen(v)) return;
  throw new RuntimeFault(
    "L4018",
    `${where} carries an own callable \`then\`, which this language does not have a meaning for: there are no promises here, and a value with a callable \`then\` is assimilated by the host's await machinery, which would run that function outside the run's frame with the host's own settlement functions as its arguments. Rename the field.`,
  );
}

// ---- the seam ----------------------------------------------------------------------------------

/**
 * The seam, plus the one thing the HOST needs from it that the program must never see.
 *
 * `steps()` is the count charged against the step budget, which a `RunResult` reports so a host can
 * see how close a program runs to the ceiling before the ceiling is what tells it. It is deliberately
 * NOT a member of {@link EngineCtx}: everything on that interface is reachable from inside the
 * compartment, and a program that can read its own fuel gauge can shape its behaviour around one.
 */
export function createEngine(run: EngineRun): { readonly ctx: EngineCtx; steps(): number } {
  const ctx = buildCtx(run);
  return { ctx, steps: () => ctx[STEPS]() };
}

/** The seam alone. */
export function createCtx(run: EngineRun): EngineCtx {
  return buildCtx(run);
}

/** Where the step count hides: a symbol the language cannot name, on the object the program holds. */
const STEPS: unique symbol = Symbol("cotal-lang engine steps");

type CtxWithSteps = EngineCtx & { readonly [STEPS]: () => number };

function buildCtx(run: EngineRun): CtxWithSteps {
  const prng = new Prng(run.pins.seed);

  // The effect seam is ONE function over ONE table, shared with the walker (src/perform.ts). The
  // engine holds no copy of it: a second set of hashed projections is a set that disagrees with the
  // oracle on its first edit, and the journal is the contract the differential suite compares.
  //
  // THE CEILING IS A RUN BOUND, so the count starts where the run left off. Starting at 0 gives
  // every activation a full allowance, and a runaway loop that crashed periodically never reaches
  // the ceiling however much it performed against the world.
  const host: EffectHost = {
    journal: run.journal,
    options: {
      runId: run.runId,
      handler: run.handler,
      journal: run.journal,
      pins: run.pins,
      ...(run.onLog !== undefined ? { onLog: run.onLog } : {}),
      ...(run.shouldStop !== undefined ? { shouldStop: run.shouldStop } : {}),
    } as RunOptions,
    ceiling: run.pins.effectCeiling,
    effectCount: run.journal.dispatchedEffects(),
  };

  /** May this frame write into this container? The value half of freeze-on-share, whole. */
  const assertWritable = (target: object, frame: { readonly depth: number }): void => {
    if (Object.isFrozen(target)) {
      throw new RuntimeFault(
        "L2031",
        "this value crossed an effect boundary and is frozen: what crossed is what the journal recorded, so it cannot change afterwards. Build a new value instead: `{ ...record, field: value }` or `[...list, item]`.",
      );
    }
    if (birthDepth(target) < frame.depth) {
      throw new RuntimeFault(
        "L2032",
        "this value was built outside this concurrent branch and is written inside it. Two branches writing one value is nondeterministic, and it is silent: live they write in completion order, on resume the recorded effects return instantly and they write in launch order, so the value differs and the run takes a path it never recorded. Build the value inside the branch and return it, and read it out of the combinator's result.",
      );
    }
  };

  const libraryContext = {
    runId: run.runId,
    programHash: run.programHash,
    startedAt: run.pins.startedAt,
    prng,
    ...(run.onLog !== undefined ? { onLog: run.onLog } : {}),
    assertWritable,
  };

  const methods = {
    array: arrayMethods(libraryContext),
    string: stringMethods(),
    number: numberMethods(),
  };
  const freeNames = new Map<string, unknown>(builtins(libraryContext).map(([n, v]) => [n, v]));

  // ---- the calling-convention adapter, both directions ----------------------------------------
  //
  // The walker's convention is `(frame, args)`, and library.ts calls every callback that way. The
  // transform emits plain `async (...args)` closures and never a frame parameter (ruled). So the
  // HOST adapts at every crossing, in both directions, and this pair is the whole of it.

  /** A program closure, as library.ts calls it. The frame travels explicitly, not by ambience. */
  const toWalker = (fn: (...a: unknown[]) => unknown): Callable =>
    async (frame, args) => await withFrame(frame as EngineFrame, () => fn(...args));

  /** A `(frame, args)` callable, as the program calls it. The frame comes from the ambient one. */
  const toProgram = (fn: Callable): ((...a: unknown[]) => Promise<unknown>) =>
    async (...args) => await fn(currentFrame(), args);

  /** Adapt every function IN an argument list, leaving everything else alone. */
  const adaptArgs = (args: readonly unknown[]): unknown[] =>
    args.map((a) => (typeof a === "function" ? toWalker(a as (...x: unknown[]) => unknown) : a));

  /**
   * A host value on its way OUT to the program: any `(frame, args)` callable in it becomes a plain
   * closure. Only `json` needs the record walk, and it is walked rather than special-cased so a
   * builtin that grows members later does not silently hand out the wrong convention.
   */
  const toProgramValue = (v: unknown): unknown => {
    if (typeof v === "function") return toProgram(v as Callable);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const out: Record<string, unknown> = {};
    for (const [k, inner] of Object.entries(v as Record<string, unknown>)) setOwn(out, k, toProgramValue(inner));
    return deepFreeze(out);
  };

  // ---- fuel ------------------------------------------------------------------------------------
  //
  // The unit CHANGES from the walker's: the walker charges one dispatch per node it walks, the
  // engine charges one transformed-site hit. That is languageVersion 2's pin-unit change, and it is
  // why L4013 is a FIRST-PARTY cell rather than a differential one — journals are unaffected,
  // because steps are never recorded, but the budget fires at different points on the two engines.

  let steps = 0;
  let nextYield = run.pins.yieldEvery;

  const breathe = async (frame: EngineFrame): Promise<void> => {
    // The MACROTASK queue, not a microtask. A program that only ever yields microtasks starves the
    // host completely: a watchdog's setTimeout never fires, and the run takes down the timer plane
    // and every other run on the host with it.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    // The cut, and only the cut: an arm that can no longer win is abandoned here. An arm that could
    // still win keeps running its pure work, so a live race is decided by the recorded clocks and
    // declaration order rather than by how many steps a tail happens to take against `yieldEvery`.
    if (frame.signal.cutPure) throw new Cancelled(frame.signal.reason ?? "cancelled");
  };

  const fuel = (): void | Promise<void> => {
    steps += 1;
    if (steps > run.pins.stepBudget) {
      throw new RuntimeFault(
        "L4013",
        `this walk has taken more than ${run.pins.stepBudget} interpreter steps without finishing, which means a loop that performs no effect is not terminating. The effect ceiling cannot see such a loop, because it performs nothing to count. Add an exit condition, or raise stepBudget if the program legitimately does this much work. (stepBudget bounds ONE WALK, not the run: steps are not recorded, so a resume cannot recover a count the way the effect ceiling can.)`,
      );
    }
    // Returns nothing on the common path, so the emitted `await __ctx.fuel()` costs a bare microtask
    // rather than an allocated promise.
    if (steps < nextYield) return;
    nextYield = steps + run.pins.yieldEvery;
    return breathe(currentFrame());
  };

  // ---- members ---------------------------------------------------------------------------------

  /** The property key a member expression names, as JavaScript would spell it. */
  const keyOf = (k: unknown): string => {
    if (typeof k === "string") return k;
    refuseCoercion("[...]", k);
    return String(k);
  };

  const methodOf = (table: Readonly<Record<string, Method>>, receiver: unknown, prop: string, kind: string, asCallee: boolean): Callable => {
    const m = table[prop];
    if (m === undefined) {
      throw new RuntimeFault(
        "L4014",
        `\`${prop}\` is not a member of ${kind}. The members are: length, an index, ${Object.keys(table).join(", ")}.`,
      );
    }
    // A method is looked up AT THE CALL and exists nowhere else — a declared difference from
    // JavaScript, where `xs.map` is a value. Handing one out gives `xs.map !== xs.map` and an
    // extracted `push` that writes to a receiver strict JavaScript would refuse.
    if (!asCallee) {
      throw new RuntimeFault(
        "L4020",
        `\`${prop}\` is a method of ${kind}, and a method is not a value here: it is looked up at the call, so it cannot be extracted, compared, or passed. Call it — \`.${prop}(...)\` — or wrap it: \`(...args) => value.${prop}(...args)\`.`,
      );
    }
    return async (frame, args) => await m(frame, receiver as never, args);
  };

  /**
   * What a member lookup FOUND, not merely what it produced.
   *
   * The distinction is load-bearing in the engine and does not exist in the walker. A curated-table
   * method speaks the walker's `(frame, args)` convention; an own field of a record holds a value the
   * PROGRAM made (or one the host already adapted on its way out), and that speaks the program's
   * plain `(...args)` convention. Collapsing the two adapted twice and handed the frame in as the
   * first argument — measured: `json.stringify([1,2])` refused its own array as an illegal second
   * argument, which is the convention mismatch wearing a coercion error's name.
   */
  type Found = { readonly from: "table"; readonly fn: Callable } | { readonly from: "own"; readonly value: unknown };

  const memberOf = (obj: unknown, prop: string, asCallee: boolean): unknown => {
    switch (typeof obj) {
      case "string": {
        if (prop === "length") return obj.length;
        const i = arrayIndex(prop);
        if (i !== undefined) return obj[i];
        return methodOf(methods.string, obj, prop, "a string", asCallee);
      }
      case "number":
        return methodOf(methods.number, obj, prop, "a number", asCallee);
      case "object": {
        if (obj === null) throw new RuntimeFault("L4010", `cannot read \`${prop}\` of null`);
        if (Array.isArray(obj)) {
          if (prop === "length") return obj.length;
          const i = arrayIndex(prop);
          if (i !== undefined) return obj[i];
          return methodOf(methods.array, obj, prop, "an array", asCallee);
        }
        // A record answers its OWN fields and `undefined` for anything else, so no host prototype is
        // ever reached: `o.constructor`, `o.toString` and `o.hasOwnProperty` are all `undefined`.
        return Object.prototype.hasOwnProperty.call(obj, prop) ? (obj as Record<string, unknown>)[prop] : undefined;
      }
      case "undefined":
        throw new RuntimeFault("L4010", `cannot read \`${prop}\` of undefined`);
      default:
        throw new RuntimeFault("L4014", `\`${prop}\` is not a member: a ${typeof obj} has no members`);
    }
  };

  /** The same lookup as {@link memberOf}, keeping WHERE the member came from. */
  const lookup = (obj: unknown, prop: string, asCallee: boolean): Found => {
    const isRecord = typeof obj === "object" && obj !== null && !Array.isArray(obj);
    if (isRecord) return { from: "own", value: memberOf(obj, prop, asCallee) };
    const v = memberOf(obj, prop, asCallee);
    // Only a receiver with a curated table can answer a callable here; `length` and an index are
    // ordinary values and take the own path.
    return typeof v === "function" ? { from: "table", fn: v as Callable } : { from: "own", value: v };
  };

  const ctx: EngineCtx = {
    fuel,

    get(o, k) {
      return memberOf(o, keyOf(k), false);
    },

    set(o, k, v) {
      const prop = keyOf(k);
      if (o === null || o === undefined || typeof o !== "object") {
        throw new RuntimeFault(
          "L4010",
          `cannot write \`${prop}\` of ${o === null ? "null" : typeof o === "undefined" ? "undefined" : `a ${typeof o}`}`,
        );
      }
      assertWritable(o, currentFrame());
      // The second door of the thenable gate: a record can acquire a callable `then` after birth,
      // and a computed key reaches it past any static spelling (`x["th" + "en"] = f`).
      if (prop === "then") refuseThenable({ then: v }, "this field write");
      if (Array.isArray(o)) {
        if (prop === "length") {
          // `xs.length = n` truncates, as in JavaScript. A LONGER length is refused: JavaScript
          // would fill the gap with holes, and a hole is a value class this language does not have.
          if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > o.length) {
            throw new RuntimeFault(
              "L4017",
              `\`length\` can only be set to an integer between 0 and the array's current length (${o.length}), got ${typeof v === "number" ? v : typeof v}: a longer length would create holes, which this language does not have; push the elements instead`,
            );
          }
          o.length = v;
          return v;
        }
        const i = arrayIndex(prop);
        if (i === undefined) {
          throw new RuntimeFault("L4014", `\`${prop}\` is not a member of an array: an array takes an index or \`length\``);
        }
        if (i > o.length) {
          throw new RuntimeFault(
            "L4019",
            `index ${i} is past the end of this array (length ${o.length}), and JavaScript would fill the gap with holes, which this language does not have. Write at an existing index, at the length to append, or use \`push\`.`,
          );
        }
      } else if (prop === "__proto__") {
        throw new RuntimeFault("L4014", "`__proto__` names an object's prototype, and there are no prototypes here");
      }
      setOwn(o, prop, v);
      return v;
    },

    async call(o, k, args) {
      const found = lookup(o, keyOf(k), true);
      if (found.from === "table") {
        // A curated method: the walker's convention, and every program closure among the arguments
        // is adapted into it on the way in.
        return await found.fn(currentFrame(), adaptArgs(args));
      }
      if (typeof found.value !== "function") {
        throw new RuntimeFault("L4011", "this value is not a function, so it cannot be called");
      }
      // An own field holds a program-convention closure. Adapting here would pass the frame in as
      // the first argument and shift every real one along by a position.
      return await (found.value as (...a: unknown[]) => unknown)(...args);
    },

    born(v) {
      refuseThenable(v, "this value");
      return stampBirth(v, currentFrame().depth);
    },

    async effect(name, args, _site) {
      const spec = PRIMITIVES[name];
      if (spec === undefined) throw new RuntimeFault("L2001", `${name} is not a primitive`);
      if (spec.opensScope) {
        // Loud, not a fallback. A silent sequential `parallel` would journal a scope nobody opened
        // and pass a differential comparator on every program that does not race.
        throw new RuntimeFault(
          "L1000",
          `\`${name}\` opens a concurrency scope, and the engine's scope machinery is not landed yet. Run this program on the walker.`,
        );
      }
      return await dispatchPrimitive(host, name, args, currentFrame());
    },

    free(name, args) {
      const v = freeNames.get(name);
      if (v === undefined && !freeNames.has(name)) {
        throw new RuntimeFault("L2001", `${name} is not a builtin`);
      }
      // Read as a VALUE when no arguments are given: a builtin is a binding in this language, so
      // `map(xs, upper)` and `const f = trim` both need one, and what leaves has to speak the
      // program's convention or a native call would pass `(x)` where the library expects
      // `(frame, [x])`.
      if (args === undefined) return toProgramValue(v);
      if (typeof v !== "function") {
        throw new RuntimeFault("L4011", `\`${name}\` is not a function, so it cannot be called`);
      }
      return (v as Callable)(currentFrame(), adaptArgs(args));
    },

    async await(v) {
      // BEFORE the await, which is the whole point: once `await` has the value, the host has
      // already called its `then`.
      refuseThenable(v, "this awaited value");
      return await v;
    },

    template(parts, values) {
      let out = "";
      for (let i = 0; i < parts.length; i += 1) {
        out += parts[i] ?? "";
        if (i < values.length) {
          const v = values[i];
          refuseCoercion("${...}", v);
          out += String(v);
        }
      }
      return out;
    },

    binary(op, l, r) {
      const a = l as number;
      const b = r as number;
      switch (op) {
        case "===":
          return l === r;
        case "!==":
          return l !== r;
        default:
          break;
      }
      refuseCoercion(op, l);
      refuseCoercion(op, r);
      switch (op) {
        case "<":
          return a < b;
        case "<=":
          return a <= b;
        case ">":
          return a > b;
        case ">=":
          return a >= b;
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          return a / b;
        case "%":
          return a % b;
        case "**":
          return a ** b;
        case "&":
          return a & b;
        case "|":
          return a | b;
        case "^":
          return a ^ b;
        case "<<":
          return a << b;
        case ">>":
          return a >> b;
        case ">>>":
          return a >>> b;
        default:
          throw new RuntimeFault("L1000", `unsupported operator ${op}`);
      }
    },

    unary(op, v) {
      switch (op) {
        case "!":
          return !v;
        case "typeof":
          return typeof v;
        case "-":
          refuseCoercion("-", v);
          return -(v as number);
        case "+":
          refuseCoercion("+", v);
          return +(v as number);
        case "~":
          refuseCoercion("~", v);
          return ~(v as number);
        default:
          throw new RuntimeFault("L1000", `unsupported unary operator ${String(op)}`);
      }
    },

    iter(v) {
      if (Array.isArray(v)) return v;
      if (typeof v === "string") return [...v];
      throw new RuntimeFault(
        "L4015",
        `${v === null ? "null" : typeof v === "object" ? "a record" : typeof v} is not iterable: only arrays and strings can be spread or looped over. For a record, iterate \`keys(record)\` or \`entries(record)\`.`,
      );
    },

    caught(e) {
      // The run's continuation is forfeit for these, and that includes its cleanup: the world-side
      // recovery belongs to the driver and the journal, not to the program that just lost the right
      // to run. They are recognised by CLASS, which is why the emitted catch has to ask rather than
      // test a shape the program could forge.
      if (isUncatchable(e)) throw e;
      return toProgramError(e);
    },
  };

  return Object.defineProperty(ctx, STEPS, {
    value: () => steps,
    enumerable: false,
    writable: false,
    configurable: false,
  }) as CtxWithSteps;
}

// ---- the classes a program may not catch, and the value one that it may -------------------------

/**
 * Recognised by class rather than by shape.
 *
 * `Cancelled` and `RunReleased` come from effects.ts, `JournalAppendRejected` from journal.ts. The
 * three the walker adds — `RunDivergence`, `ScopeBranchMissing`, `UnwalkableScope` — are exported by
 * interpret.ts, and importing them here would pull the whole walker into the engine's module graph
 * for three constructors. They are matched by `name` instead, which is a deliberate, narrow
 * exception to "recognise by class": the names are the classes' own, they are set in the
 * constructors, and a program cannot mint an Error subclass to forge one (there is no `Error` in the
 * language). The differential suite carries a cell per class.
 */
const UNCATCHABLE_NAMES: ReadonlySet<string> = new Set([
  "Cancelled",
  "JournalAppendRejected",
  "RunReleased",
  "RunDivergence",
  "ScopeBranchMissing",
  "UnwalkableScope",
]);

function isUncatchable(e: unknown): boolean {
  return e instanceof Error && UNCATCHABLE_NAMES.has(e.name);
}

/** What the catch parameter binds to: a frozen record with a code, never the host's own object. */
function toProgramError(e: unknown): unknown {
  if (e instanceof EffectError) {
    return deepFreeze({ code: e.code, kind: e.kind, message: e.message, ...(e.detail !== undefined ? { detail: e.detail } : {}) });
  }
  if (e instanceof RuntimeFault) return deepFreeze({ code: e.code, kind: "runtime", message: e.message });
  if (e instanceof Error) return deepFreeze({ code: "L4000", kind: "host", message: e.message });
  return e;
}
