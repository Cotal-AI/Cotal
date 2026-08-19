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
import type { AgentHandleValue } from "../effects.js";
import { digest, type ScopeKind } from "../keys.js";
import { currentFrame, withFrame, type EngineFrame } from "./frame.js";
import { dispatchPrimitive, freeConstructors, option, performScope, runScope, type EffectHost, type Frame as ScopeFrame } from "../perform.js";
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
 * The seam. Fourteen members, and the count is the point: a member added here without a joint rule
 * is a widening, and lane T's surface cell reddens on any call to a name not on this interface.
 * Thirteen were ruled in seam ruling 1; `callee` is the fourteenth, granted in 1c.
 */
export interface EngineCtx {
  /** L4013 step budget, plus the yield that keeps the macrotask queue alive and applies the cut. */
  fuel(): void | Promise<void>;
  /**
   * Read a member: L4014 (no prototype reach, curated tables), L4020, L4018 on a computed key.
   *
   * `binding` is F7's cell read, ruled as a third argument rather than a fifteenth member. A binding
   * the transform classified as a CELL is emitted as `get(cell, "v", "x")`, and an absent OWN key
   * means the declaration has not run yet, which is L2004 for that binding by name. PRESENCE is
   * `hasOwn` and not truthiness, because `v: undefined` is a binding that HAS been initialised, to
   * undefined. Without the argument, `get` is byte-unchanged.
   */
  get(o: unknown, k: unknown, binding?: string): unknown;
  /**
   * Write a member: L2031, L2032, L4014, L4017, L4019. Answers `v`, as an assignment does.
   *
   * `binding` is F7's cell WRITE, ruled as a fourth argument for the same reason `get` took a third.
   * It is present ONLY on an ASSIGNMENT to a cell, never on the declaration's own initialising write,
   * and an absent OWN key there means the declaration has not run: L2004 naming the binding, in the
   * walker's assignment words, which are not the read's. The key is LEFT ABSENT by the refusal, so
   * the declaration that has not run yet still initialises the binding when it does.
   */
  set(o: unknown, k: unknown, v: unknown, binding?: string): unknown;
  /**
   * Call a member. The single L4020 exception: a method is resolved AT the call and nowhere else.
   *
   * `optional` is `o.m?.()` (F6, ruled 1d as a flag rather than a fifteenth member). It guards a
   * NULLISH MEMBER and nothing else — measured on the walker, `?.` softens neither L4014 nor L4011 —
   * and a short-circuited call evaluates NO ARGUMENT, which is why the optional form takes a thunk.
   *
   * `chain` is EVERYTHING WRITTEN AFTER the optional call, as a closure. A short-circuit swallows the
   * whole rest of the chain, and only the host knows a short-circuit happened: measured, `o.z?.().x`
   * on an absent member is `undefined` while `o.m?.().x` on a member that RETURNS undefined is L4010,
   * and a guard on the returned value cannot tell those apart, so it would drop a refusal in silence.
   * Handing the continuation here lets the one place that made the decision apply it.
   */
  call(
    o: unknown,
    k: unknown,
    args: unknown[] | (() => unknown[]),
    optional?: boolean,
    chain?: (value: unknown) => unknown,
  ): Promise<unknown>;
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
  /** `-`, `+`, `~` under the same law, and `update` for the operand of `++`/`--`. `!`/`typeof` are native. */
  unary(op: string, v: unknown): unknown;
  /** The iterability law (L4015): arrays and strings, nothing else. */
  iter(v: unknown): unknown[];
  /** The L4011 refusal at a non-function callee. Emitted behind a `typeof`, so only the refusal runs. */
  callee(v: unknown): unknown;
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

  // The two pure primitives and the four event constructors are free VALUES, not journalled effects
  // (design §3A). They come from the SAME table the walker declares them from (perform.ts), wrapped
  // into the internal `(frame, args)` convention here so one `free` serves every name: a second copy
  // of the shapes is a second answer to what a handle or an event descriptor IS on the wire.
  for (const [name, impl] of freeConstructors({ runId: run.runId, programHash: run.programHash, startedAt: run.pins.startedAt })) {
    freeNames.set(name, ((_frame, a) => impl(a)) as Callable);
  }

  // ---- the calling-convention adapter, both directions ----------------------------------------
  //
  // The walker's convention is `(frame, args)`, and library.ts calls every callback that way. The
  // transform emits plain `async (...args)` closures and never a frame parameter (ruled). So the
  // HOST adapts at every crossing, in both directions, and this section is the whole of it.
  //
  // THE INVARIANT (ruling 1c): adaptation may never be observable from inside the program. A value
  // the program hands to a library function and reads back must behave AND compare `===` as the one
  // it handed in. Two things follow, and both were live defects before they were rules:
  //
  //   * ONLY A POSITION THE LIBRARY CALLS IS ADAPTED. Adapting every function in an argument list
  //     rewrote the ones a mutating method STORES: `xs.push(f)` put the walker view in the array,
  //     and the program read back a value that neither called (`args is not iterable`) nor compared
  //     equal to the one it pushed.
  //   * AN ADAPTER IS MINTED ONCE PER VALUE. A fresh closure per read makes `map !== map`, which is
  //     false on the walker, where a builtin is one immutable binding for the whole run.

  /**
   * Where a library function calls one of its arguments, by qualified name.
   *
   * Derived from library.ts's `asCallable` sites: the eleven callback-taking array methods take
   * theirs FIRST, the six higher-order builtins take theirs SECOND (the list is first). It is held
   * to those sites BEHAVIOURALLY rather than by reading them — a cell probes every name in every
   * table with a marker function and compares the set of positions the library actually calls to
   * this one, so a table that grows a callback position reds here instead of drifting.
   */
  const CALLBACK_ARG = new Map<string, number>([
    ...["map", "filter", "find", "findIndex", "findLast", "findLastIndex", "some", "every", "forEach", "reduce", "flatMap"].map(
      (n) => [`array.${n}`, 0] as const,
    ),
    ...["map", "filter", "find", "some", "every", "sort"].map((n) => [`builtin.${n}`, 1] as const),
  ]);

  /** Host value -> the program's view of it, so a value has ONE view for the life of the run. */
  const programView = new WeakMap<object, unknown>();
  /** A program view -> the host callable it wraps, so a round trip through the seam is the identity. */
  const hostOf = new WeakMap<object, Callable>();
  /** Program closure -> the walker's view of it, for the same reason in the other direction. */
  const walkerView = new WeakMap<object, Callable>();

  /** A program closure, as library.ts calls it. The frame travels explicitly, not by ambience. */
  const toWalker = (fn: (...a: unknown[]) => unknown): Callable => {
    const underlying = hostOf.get(fn);
    if (underlying !== undefined) return underlying;
    const had = walkerView.get(fn);
    if (had !== undefined) return had;
    const w: Callable = async (frame, args) => await withFrame(frame as EngineFrame, () => fn(...args));
    walkerView.set(fn, w);
    return w;
  };

  /** Adapt the ONE argument this library function calls, and nothing else in the list. */
  const adaptArgs = (key: string, args: readonly unknown[]): unknown[] => {
    const at = CALLBACK_ARG.get(key);
    if (at === undefined || typeof args[at] !== "function") return args as unknown[];
    const out = args.slice();
    out[at] = toWalker(args[at] as (...x: unknown[]) => unknown);
    return out;
  };

  /**
   * A host value on its way OUT to the program: any `(frame, args)` callable in it becomes a plain
   * closure that adapts its own arguments the same way the call form does. Only `json` needs the
   * record walk, and it is walked rather than special-cased so a builtin that grows members later
   * does not silently hand out the wrong convention.
   */
  const toProgramValue = (name: string, v: unknown): unknown => {
    if (v === null || (typeof v !== "object" && typeof v !== "function")) return v;
    const had = programView.get(v as object);
    if (had !== undefined) return had;
    let out: unknown;
    if (typeof v === "function") {
      const key = `builtin.${name}`;
      const p = async (...args: unknown[]): Promise<unknown> => await (v as Callable)(currentFrame(), adaptArgs(key, args));
      hostOf.set(p, v as Callable);
      out = p;
    } else if (Array.isArray(v)) {
      out = v;
    } else {
      const rec: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) setOwn(rec, k, toProgramValue(`${name}.${k}`, inner));
      out = deepFreeze(rec);
    }
    programView.set(v as object, out);
    return out;
  };

  // ---- the concurrency scopes ------------------------------------------------------------------
  //
  // The SAME two functions the walker calls, with the same arguments in the same order:
  // `performScope` owns the journal entry and the replay, `runScope` owns what a scope means. None
  // of a race's winner rule, a fanOut's key rule or a conclave's close lives on this side, because
  // a second copy of that logic would be a second answer to what a scope IS.
  //
  // What this side owns is the two things the engine has that the walker does not: the CALLING
  // CONVENTION (arms arrive as the program's own closures, and the scope machinery calls them
  // `(frame, args)`) and the MISSING AST (a settled race's `branchDigest` is a function of the
  // source, so it arrives as the call site's static payload instead).

  /** An arm, as the scope machinery calls one. A non-function is passed through so the engine fails where the walker fails. */
  const asArm = (v: unknown): unknown => (typeof v === "function" ? toWalker(v as (...a: unknown[]) => unknown) : v);

  /** `parallel`/`race` take a record or an array OF ARMS; the other two take data in that position. */
  const branchesOf = (name: string, first: unknown): unknown => {
    if (name !== "parallel" && name !== "race") return first;
    if (Array.isArray(first)) return first.map(asArm);
    if (first === null || typeof first !== "object") return first;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(first as Record<string, unknown>)) setOwn(out, k, asArm(v));
    return out;
  };

  /** `fanOut`'s `key` is called by the scope machinery too. The copy never reaches the program. */
  const bagWithKey = (bag: unknown): unknown => {
    const key = option(bag, "key");
    if (typeof key !== "function") return bag;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(bag as Record<string, unknown>)) setOwn(out, k, v);
    setOwn(out, "key", asArm(key));
    return out;
  };

  /**
   * The second argument, DEFERRED - and it must be, measured on the walker rather than argued:
   *
   *   fanOut(xs, await choose(), { name: "f", key })       journal ["fanOut:f", "sleep:warm"]
   *   conclave([a], await choose(), { name: "c" })         journal ["spawn:hire", "conclave:c", "sleep:warm"]
   *   fanOut(xs, fn, { name: "f", key: await choose() })   journal ["sleep:warm", "fanOut:f"]
   *
   * The body is evaluated INSIDE the scope, after its entry has begun; the options bag is evaluated
   * before it. So the emitted call hands the body over as a thunk, for the same reason the optional
   * call hands over its arguments as one: an argument that was already evaluated has already
   * journalled its effects in the wrong place, and a resume would replay a step the walker's run
   * never recorded. `parallel` and `race` have no deferred argument - their second is the bag.
   */
  const deferredBody = (name: string, args: unknown[]): (() => Promise<unknown>) => async () => {
    if (name === "parallel" || name === "race") {
      throw new RuntimeFault("L1000", `\`${name}\` has no deferred argument; asking for one is an engine fault`);
    }
    const thunk = args[1];
    if (typeof thunk !== "function") {
      throw new RuntimeFault(
        "L1000",
        `\`${name}\` takes its body UNEVALUATED, as a thunk: the walker evaluates it AFTER the scope's entry has begun (measured: an effect in that position journals inside the scope, one in the options bag journals before it), so a body handed over already evaluated has journalled its effects in the wrong place.`,
      );
    }
    return asArm(await (thunk as () => unknown)());
  };

  /**
   * The `branchDigest`, rebuilt from the call site's payload with the walker's own `digest`.
   *
   * The walker digests `[...losers].sort().map((n) => [n, bodies.get(n) ?? null])` over the arm
   * bodies with positions stripped, and a name the site does not carry digests as `null` — an arm
   * that was RENAMED is exactly the case this has to notice. Absent `branchDigests` means the arms
   * were not written as an object literal at the call, which is where the walker also answers
   * undefined, so the field's presence is the whole decision.
   */
  const digesterFor = (site: Site | undefined): ((losers: readonly string[]) => string | undefined) | undefined => {
    const bodies = site?.branchDigests;
    if (bodies === undefined) return undefined;
    return (losers) =>
      digest(
        [...losers]
          .sort()
          .map((n) => [n, Object.prototype.hasOwnProperty.call(bodies, n) ? bodies[n] : null]),
      );
  };

  const openScope = async (
    name: string,
    spec: NonNullable<(typeof PRIMITIVES)[string]>,
    args: unknown[],
    site: Site | undefined,
  ): Promise<unknown> => {
    const frame = currentFrame();
    const scopeKind = name as ScopeKind;
    const first = args[0];
    const bag = args[spec.optionsAt];
    const scopeName = (option(bag, "name") as string | undefined) ?? null;
    // Allocated HERE, synchronously, exactly as the walker allocates it: the occurrence is what
    // makes two textually identical scopes different steps, and a counter read after an await is a
    // counter two scopes can race for.
    const occurrence = frame.keys.nextScope(scopeKind, scopeName);
    const scopeKey = frame.keys.scopeKey(scopeKind, scopeName, occurrence);

    // `conclave` is the one scope whose identity includes a SUBJECT: the members are what the
    // sub-team IS, so editing the member list diverges rather than resuming into a different room.
    const subject = spec.hashesSubject
      ? {
          members: (first as AgentHandleValue[]).map((m) => m.agent),
          channel: (option(bag, "channel") as string | undefined) ?? null,
        }
      : undefined;

    return await performScope(
      host,
      scopeKey,
      frame,
      async (ctx, only) =>
        await runScope(
          host,
          name,
          scopeKind,
          scopeName,
          occurrence,
          branchesOf(name, first),
          deferredBody(name, args),
          bagWithKey(bag),
          frame as ScopeFrame,
          ctx,
          only,
        ),
      subject,
      // `race` alone, as on the walker: `parallel` and `fanOut` have no losers, and a `conclave`
      // cannot be walked into at all.
      name === "race" ? digesterFor(site) : undefined,
    );
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
  type Found =
    | { readonly from: "table"; readonly fn: Callable; readonly key: string }
    | { readonly from: "own"; readonly value: unknown };

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

  /** Which curated table a receiver answers from, and the first half of a member's qualified name. */
  const tableKind = (obj: unknown): string | undefined =>
    typeof obj === "string" ? "string" : typeof obj === "number" ? "number" : Array.isArray(obj) ? "array" : undefined;

  /**
   * The same lookup as {@link memberOf}, keeping WHERE the member came from.
   *
   * The two paths are told apart by the NAME, never by what the name answered. Deciding on
   * `typeof v === "function"` reads right and is wrong: an array element can itself be a program
   * closure, so `fs[0]("a")` classified as a curated method and was called `(frame, ["a"])` — the
   * frame handed to the program as its first argument, which is the hazard this whole section
   * exists to close. Measured on `const fs = [(x) => x]` before the fix.
   */
  const lookup = (obj: unknown, prop: string, asCallee: boolean): Found => {
    const kind = tableKind(obj);
    if (kind === undefined) return { from: "own", value: memberOf(obj, prop, asCallee) };
    if (typeof obj === "string" || Array.isArray(obj)) {
      if (prop === "length" || arrayIndex(prop) !== undefined) return { from: "own", value: memberOf(obj, prop, asCallee) };
    }
    return { from: "table", fn: memberOf(obj, prop, asCallee) as Callable, key: `${kind}.${prop}` };
  };

  /**
   * F7'S CELL TEST, in ONE place because both doors ask the same question.
   *
   * A binding the transform turned into a cell exists for its whole block, and the cell record is
   * hoisted to the top of that block so the closures capturing it have something to close over. What
   * decides whether the DECLARATION has run is whether the key is THERE - `hasOwn`, never truthiness,
   * because a binding initialised to `undefined` has run and a truthiness test would refuse it.
   *
   * Written once rather than at each door: a duplicated guard is one whose mutant can be defeated by
   * copying it, and the read and the write differ in their SENTENCE, not in this question.
   */
  const declarationHasRun = (cell: unknown, prop: string): boolean =>
    cell !== null && typeof cell === "object" && Object.prototype.hasOwnProperty.call(cell, prop);

  const ctx: EngineCtx = {
    fuel,

    get(o, k, binding) {
      const prop = keyOf(k);
      // F7'S CELL DOOR. A binding the transform turned into a cell exists for its whole block, and
      // the cell record is hoisted to the top of that block so the closures capturing it have
      // something to close over. What decides whether the DECLARATION has run is whether the key is
      // there - `hasOwn`, never truthiness, because a binding initialised to `undefined` has run.
      // The walker's own words, so a program cannot tell which engine refused it.
      if (binding !== undefined && !declarationHasRun(o, prop)) {
        throw new RuntimeFault(
          "L2004",
          `${binding} is used before its declaration was reached: the binding exists for the whole block, but it holds no value until the \`let\`/\`const\` line runs. Call this function after the declaration, or move the declaration up.`,
        );
      }
      return memberOf(o, prop, false);
    },

    set(o, k, v, binding) {
      const prop = keyOf(k);
      // F7'S OTHER CELL DOOR, and it is a SEPARATE refusal rather than the read's reused: the walker
      // answers a different sentence for a write, and a program that could tell the two engines apart
      // by which sentence it caught would be a divergence dressed as a message. Both are catchable,
      // both leave the binding uninitialised, and the declaration still initialises it when reached.
      // Emitted only on an assignment - the declaration's own `set` passes three arguments - so a
      // cell being written for the first time by its `let` line never comes through here.
      if (binding !== undefined && !declarationHasRun(o, prop)) {
        throw new RuntimeFault(
          "L2004",
          `${binding} is assigned before its declaration was reached: the binding exists for the whole block, but it holds no value until the \`let\`/\`const\` line runs.`,
        );
      }
      if (o === null || o === undefined || typeof o !== "object") {
        throw new RuntimeFault(
          "L4010",
          `cannot write \`${prop}\` of ${o === null ? "null" : typeof o === "undefined" ? "undefined" : `a ${typeof o}`}`,
        );
      }
      assertWritable(o, currentFrame());
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
      // THE SECOND DOOR OF THE THENABLE GATE, and it is LAST on purpose. A record can acquire a
      // callable `then` after birth, and a computed key reaches it past any static spelling
      // (`x["th" + "en"] = f`). But it applies to a RECORD and to nothing else, because the walker's
      // order is: what kind of thing is being written (L4010), is it frozen (L2031), does that kind
      // have this member (L4014/L4017/L4019) - and only then what the value is. MEASURED on the
      // oracle: `keys({a:1}).then = () => 1` is L4014 "`then` is not a member of an array", the same
      // answer as `.foo`, and `"x".then = f` and `(1).then = f` are L4010. Refusing L4018 here first
      // answered the value's rule for a receiver that never had the member, which is a different
      // sentence for the same program. On a record the walker refuses NOTHING and this engine
      // refuses L4018: that is the declared divergence pending the walker's L4021 (#642/#657), and
      // it is the only one this reordering leaves.
      if (prop === "then") refuseThenable({ then: v }, "this field write");
      setOwn(o, prop, v);
      return v;
    },

    async call(o, k, args, optional, chain) {
      // THE LOOKUP HAPPENS FIRST, AND `?.` DOES NOT SOFTEN IT. Measured on the walker: `xs.nope?.()`
      // is L4014 exactly as `xs.nope()` is, and a member that resolves to a non-function is L4011.
      // The only thing an optional call guards is a member that is null or undefined.
      const found = lookup(o, keyOf(k), true);

      // AN OPTIONAL CALL EVALUATES NO ARGUMENT WHEN IT SHORT-CIRCUITS, which is why the optional
      // form takes a thunk: the transform evaluates arguments before it can call anything, so an
      // array here would already have run them. Measured: the walker's short-circuit journalled
      // nothing where the same argument on a present method journalled a `sleep`.
      // A continuation without a short-circuit to guard is an emitter mistake: an ordinary call's
      // chain is written natively, because nothing in it depends on a decision only the host made.
      if (chain !== undefined && optional !== true) {
        throw new RuntimeFault("L1000", "a call continuation belongs to an OPTIONAL call: there is nothing else for it to be skipped by");
      }
      if (optional === true && typeof args !== "function") {
        throw new RuntimeFault(
          "L1000",
          "an optional call must be handed its arguments as a thunk: it may not evaluate them at all, and an array is a list that has already been evaluated",
        );
      }
      // Nothing runs: not the arguments, and not the rest of the chain. Measured on the walker, the
      // short-circuit swallows a deep chain (`o.z?.().x.y`) and a trailing call alike.
      if (found.from === "own" && (found.value === null || found.value === undefined) && optional === true) {
        return undefined;
      }
      // AWAITED, because the thunk is `async`: every argument the transform emits may itself contain
      // an `await`, so a sync arrow could not hold one. Measured without the await: an ordinary
      // `o.m?.(1)` died on `Spread syntax requires ...iterable`, and `xs.map?.(f)` reached the
      // curated method with a Promise where its argument list should be.
      const list = typeof args === "function" ? await args() : args;
      let answer: unknown;
      if (found.from === "table") {
        // A curated method: the walker's convention, and the ONE argument this method calls is
        // adapted into it on the way in. Every other argument crosses untouched — see the invariant.
        answer = await found.fn(currentFrame(), adaptArgs(found.key, list));
      } else if (typeof found.value !== "function") {
        throw new RuntimeFault("L4011", "this value is not a function, so it cannot be called");
      } else {
        // An own field holds a program-convention closure. Adapting here would pass the frame in as
        // the first argument and shift every real one along by a position.
        answer = await (found.value as (...a: unknown[]) => unknown)(...list);
      }
      return chain === undefined ? answer : await chain(answer);
    },

    born(v) {
      refuseThenable(v, "this value");
      return stampBirth(v, currentFrame().depth);
    },

    async effect(name, args, site) {
      const spec = PRIMITIVES[name];
      if (spec === undefined) throw new RuntimeFault("L2001", `${name} is not a primitive`);
      if (spec.opensScope) return await openScope(name, spec, args, site);
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
      if (args === undefined) return toProgramValue(name, v);
      if (typeof v !== "function") {
        throw new RuntimeFault("L4011", `\`${name}\` is not a function, so it cannot be called`);
      }
      return (v as Callable)(currentFrame(), adaptArgs(`builtin.${name}`, args));
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
        case "update":
          // `x++`, `x--` and their compound cousins, on the slow path only: the transform emits a
          // native increment when it can see the operand is a number. A DECLARED DIVERGENCE, ruled
          // (1c): the walker reads the operand through `Number(...)`, so `"5"++` answers 6 and a
          // record settles as NaN, while `o + 1` and `x += 1` refuse on the very same values. That
          // is the silent-coercion class, filed against the walker as issue #646, and it is not
          // being built into the new engine for fidelity's sake.
          if (typeof v !== "number") {
            throw new RuntimeFault(
              "L4018",
              `\`++\` and \`--\` count, and ${v === null ? "null" : Array.isArray(v) ? "an array" : `a ${typeof v}`} is not a number, so there is nothing to count. Nothing is converted for you here: parse it first — \`number(value)\` — or hold the counter in a number.`,
            );
          }
          return v;
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

    callee(v) {
      // Member 14, granted by ruling 1c. The transform emits it behind a `typeof` so a real call
      // stays a native call; this is only the refusal, and it is the walker's own words because the
      // differential suite compares the message, not merely the code.
      if (typeof v !== "function") {
        throw new RuntimeFault("L4011", `this value is not a function, so it cannot be called`);
      }
      return v;
    },

    caught(e) {
      // The run's continuation is forfeit for these, and that includes its cleanup: the world-side
      // recovery belongs to the driver and the journal, not to the program that just lost the right
      // to run. They are recognised by CLASS, which is why the emitted catch has to ask rather than
      // test a shape the program could forge.
      if (isUncatchable(e)) throw e;
      // A NATIVE ReferenceError IS THE ENGINE'S FAULT, NOT THE PROGRAM'S. The emitted module is
      // closed over the seam with ZERO free identifiers, so nothing in it can name a binding that
      // does not exist: a ReferenceError here can only be a TDZ read the transform's classifier
      // missed, or an emitter temporary used before it was bound. Converting it would hand the
      // program a `{code: "L4000"}` for a compiler bug, and MAPPING it to L2004 by reading its
      // message would be worse - it would make the two indistinguishable exactly where they must not
      // be. So it refuses loudly and uncatchably, with the original message carried along.
      if (e instanceof ReferenceError) throw new EngineFault(e);
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
 * The engine broke its own contract, and no program may catch that.
 *
 * The one thing that reaches this today is a native `ReferenceError`. The emitted module is a closed
 * expression with zero free identifiers, so nothing the program wrote can name a binding that is not
 * there; a ReferenceError therefore means a TDZ read the transform's classifier missed or an emitter
 * temporary read before it was bound. It is not the program's error, it is not converted to one, and
 * it is never mapped to L2004 by reading its message - that mapping would make a compiler bug
 * indistinguishable from the language rule it imitates.
 */
export class EngineFault extends Error {
  constructor(readonly cause: unknown) {
    super(
      `the engine broke its own contract: ${(cause as Error)?.message ?? String(cause)}. The emitted module has zero free identifiers, so this can only be a binding the transform did not classify as a cell, or an emitter temporary read before it was bound. It is not the program's error and is not converted into one.`,
    );
    this.name = "EngineFault";
  }
}

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
  "EngineFault",
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
