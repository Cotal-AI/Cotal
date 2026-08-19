/**
 * The interpreter: an AST walk over a validated program.
 *
 * Two properties make this worth reading closely, because everything else in the durability story
 * rests on them:
 *
 * 1. **The interpreter owns the journal; the handler never touches it.** Every effect goes through
 *    {@link Interpreter.performEffect}, which allocates the key, consults the journal, and either
 *    replays a recorded result or performs the effect live and records it. That is why simulation
 *    and production cannot drift apart on durability: neither handler is in a position to.
 * 2. **Resume is re-running from the top.** There is no cursor and no fast-forward. Journalled
 *    effects return their recorded results, so the deterministic prefix reproduces itself and
 *    out-of-order concurrency replays correctly. This is the same thing as an effect handler's
 *    resume(), implemented by re-running the pure prefix, which is why no continuation is ever
 *    serialized.
 */

import { validate } from "./grammar.js";
import {
  LangError,
  LangErrors,
  RunDivergence,
  RuntimeFault,
  ScopeBranchMissing,
  UnwalkableScope,
  messageOf,
} from "./errors.js";
export { RunDivergence, RuntimeFault, ScopeBranchMissing, UnwalkableScope } from "./errors.js";
import { KeyScope, digest, programHashOf, requestId, scopePathString, stepKeyString, type ScopeKind, type StepKey } from "./keys.js";
import { Journal, JournalAppendRejected, RunClock, type EntryError } from "./journal.js";
import { NotCrossable, Prng, assertCrossable, birthDepth, born, deepFreeze, setOwn } from "./values.js";
import { parseDuration } from "./duration.js";
import { PRIMITIVES, VALUE_NAMES, type EffectKind } from "./primitives.js";
import { arrayMethods, builtins, numberMethods, stringMethods, type Callable, type Method } from "./library.js";
import { notifyFactViolation } from "./notify-fact.js";
import { bindPins, resolvePins, WALKER_LANGUAGE_VERSION, type RunPins } from "./pins.js";
import {
  dispatchPrimitive,
  freeConstructors,
  option,
  performEffect,
  performScope,
  runScope,
  type EffectHost,
} from "./perform.js";
import {
  Cancelled,
  RunReleased,
  EffectError,
  applyCheckpointPolicy,
  type AgentHandleValue,
  type CancelSignal,
  type ChannelHandleValue,
  type ConclaveRequest,
  type EffectContext,
  type EffectHandler,
  type CheckpointRaw,
  type EventDescriptor,
} from "./effects.js";

type AnyNode = Record<string, unknown> & { type: string };

/**
 * Every write of a RECORD member goes through here, whatever spelled it: a literal, a spread, a
 * rest pattern, or `o.a = v`. The one member the language refuses is a callable `then`.
 *
 * The host's promise machinery adopts any object that carries one: resolving a promise with such a
 * record calls the record's own `then` with the machinery's continuations instead of delivering the
 * value. Inside this interpreter every function is async, so a program-authored `then` that throws
 * turns that throw into a rejection of a promise nobody owns, which escapes the run as an
 * unhandled rejection and kills the host, while the await that adopted the record never settles
 * and the run hangs behind it (measured: a record returned from a program function did exactly
 * this, host process and all). Refusing the member is refusing the adoption: the language carries
 * no thenable values, the same way it carries no sparse arrays and no `__proto__` fields.
 */
function setRecordMember(target: object, key: string, value: unknown): void {
  if (key === "then" && typeof value === "function") {
    throw new RuntimeFault(
      "L4021",
      "`then` cannot name a function here. To the host's promise machinery any object with a callable `then` is a promise waiting to be adopted, so the record would never arrive as the value this program built: its `then` runs with the machinery's own continuations, a `then` that throws or rejects escapes the run as an unhandled rejection with no owner and kills the host, and the await that adopted it never settles. Name the member something else.",
    );
  }
  setOwn(target, key, value);
}

// ---- environments ------------------------------------------------------------------------------

class Binding {
  constructor(
    public value: unknown,
    readonly mutable: boolean,
  ) {}
}

/**
 * The value a `let`/`const` binding holds between the top of its block and its declaration: the
 * temporal dead zone, materialized. The validator refuses every straight-line reference into it
 * (L2004), so the only way here at run time is a function called before the declaration executed —
 * which JavaScript answers with a ReferenceError, and this language answers with the same code the
 * static refusal carries.
 */
const TDZ: unique symbol = Symbol("cotal-lang temporal dead zone");

class Env {
  private readonly names = new Map<string, Binding>();

  /**
   * How many CONCURRENT scopes deep this environment was created.
   *
   * L2032's runtime half rests on this. The static rule follows named and inline branches, but a
   * branch the validator cannot resolve to a function node — one that arrives through a parameter
   * or a computed record — is not proven, and banning that shape outright would cost more than the
   * hazard. So the depth travels with the binding: a write from inside a concurrent branch to a
   * binding declared OUTSIDE it is refused where it happens. `conclave` does not raise the depth,
   * because its single body has nothing to race.
   */
  constructor(
    readonly parent: Env | null,
    readonly depth: number = parent?.depth ?? 0,
  ) {}

  declare(name: string, value: unknown, mutable: boolean): void {
    this.names.set(name, new Binding(value, mutable));
  }

  /**
   * A fresh environment holding copies of `names` at their current values: JavaScript's
   * per-iteration bindings for a `for (let ...)` loop, so a closure made in one iteration keeps
   * that iteration's value rather than watching the counter move.
   */
  perIteration(names: readonly string[]): Env {
    const next = new Env(this.parent, this.depth);
    for (const n of names) {
      const b = this.names.get(n);
      if (b !== undefined) next.declare(n, b.value, b.mutable);
    }
    return next;
  }

  private find(name: string): Binding | undefined {
    for (let e: Env | null = this; e !== null; e = e.parent) {
      const b = e.names.get(name);
      if (b !== undefined) return b;
    }
    return undefined;
  }

  private owner(name: string): Env | undefined {
    for (let e: Env | null = this; e !== null; e = e.parent) {
      if (e.names.has(name)) return e;
    }
    return undefined;
  }

  get(name: string): unknown {
    const b = this.find(name);
    if (b === undefined) throw new RuntimeFault("L2001", `${name} is not defined`);
    if (b.value === TDZ) {
      throw new RuntimeFault(
        "L2004",
        `${name} is used before its declaration was reached: the binding exists for the whole block, but it holds no value until the \`let\`/\`const\` line runs. Call this function after the declaration, or move the declaration up.`,
      );
    }
    return b.value;
  }

  has(name: string): boolean {
    return this.find(name) !== undefined;
  }

  set(name: string, value: unknown, atDepth: number): void {
    const owner = this.owner(name);
    if (owner === undefined) throw new RuntimeFault("L2001", `${name} is not defined`);
    const b = owner.names.get(name) as Binding;
    if (b.value === TDZ) {
      throw new RuntimeFault(
        "L2004",
        `${name} is assigned before its declaration was reached: the binding exists for the whole block, but it holds no value until the \`let\`/\`const\` line runs.`,
      );
    }
    if (!b.mutable) throw new RuntimeFault("L2003", `${name} is declared const`);
    if (owner.depth < atDepth) {
      throw new RuntimeFault(
        "L2032",
        `${name} is declared outside this concurrent branch and written inside it. Live, the branches write in completion order; on resume the recorded effects return instantly and they write in launch order, so ${name} holds a different value and the run takes a path it never recorded, with no divergence raised. Return the value from the branch and read it out of the combinator's result, or use race, which yields its winner.`,
      );
    }
    b.value = value;
  }
}

/**
 * The message of an arbitrary thrown value.
 *
 * Reading `.message` off `null` throws, and a thrown primitive is legal in a language with `throw`,
 * so every place that has to describe a failure it did not construct goes through here. A recorded
 * entry saying "Cannot read properties of null" describes the recorder, not the run.
 */
/** An AST subtree with its source offsets removed: what the code IS, not where it sits. */
export function stripPositions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripPositions);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "start" || k === "end" || k === "loc" || k === "range") continue;
    out[k] = stripPositions(v);
  }
  return out;
}


/** A fault the interpreter itself raises, as opposed to one an effect handler reported. */
// ---- statement completion ------------------------------------------------------------------------

type Completion =
  | { readonly type: "normal" }
  | { readonly type: "return"; readonly value: unknown }
  | { readonly type: "break" }
  | { readonly type: "continue" };

const NORMAL: Completion = { type: "normal" };

// ---- per-branch execution state ---------------------------------------------------------------------

/**
 * A branch's cancellation, in two degrees.
 *
 * `cancelled` is the cancellation LAW: a cancelled branch performs no new effect, and every effect
 * boundary refuses it. `cutPure` is the stronger cut a scope applies to an arm that CANNOT WIN any
 * more: its pure work is also abandoned, at the next yield. An arm that could still win keeps
 * running its pure work to a settle, because cutting it there would let the scheduler, and through
 * it the `yieldEvery` pin, decide a race the recorded clocks should decide (see `runScope`).
 * Both degrees flow to child signals, and a signal already cancelled softly can be escalated.
 */
class Signal implements CancelSignal {
  cancelled = false;
  cutPure = false;
  reason?: string;
  private readonly listeners: ((reason: string, cutPure: boolean) => void)[] = [];

  onCancel(fn: (reason: string, cutPure: boolean) => void): void {
    this.listeners.push(fn);
  }

  cancel(reason: string, opts?: { readonly cutPure: boolean }): void {
    const cut = opts?.cutPure ?? true;
    const first = !this.cancelled;
    if (first) {
      this.cancelled = true;
      this.reason = reason;
    }
    const escalated = cut && !this.cutPure;
    if (escalated) this.cutPure = true;
    if (first || escalated) for (const l of this.listeners) l(reason, this.cutPure);
  }

  child(): Signal {
    const s = new Signal();
    if (this.cancelled) s.cancel(this.reason ?? "parent cancelled", { cutPure: this.cutPure });
    this.onCancel((r, cut) => s.cancel(r, { cutPure: cut }));
    return s;
  }
}

/**
 * One branch of execution: its own key namespace, its own clock, its own cancellation signal.
 *
 * The key namespace is the reason concurrency is safe here. Two branches calling the same named
 * effect cannot race for an occurrence counter, because they do not share one.
 */
class Frame {
  constructor(
    readonly keys: KeyScope,
    readonly clock: RunClock,
    readonly signal: Signal,
    /** How many CONCURRENT scopes deep. See {@link Env.depth}: this is L2032's runtime half. */
    readonly depth: number = 0,
  ) {}

  branch(kind: ScopeKind, name: string | null, occurrence: number, branchKey: string): Frame {
    return new Frame(
      this.keys.branch(kind, name, occurrence, branchKey),
      this.clock.fork(),
      this.signal.child(),
      // `conclave` opens a scope but not a RACE: one body, nothing running beside it, so a write
      // from inside it is as ordered as a write anywhere else and the depth does not move.
      kind === "conclave" ? this.depth : this.depth + 1,
    );
  }
}

// ---- the run -----------------------------------------------------------------------------------------

export interface RunOptions {
  readonly runId: string;
  readonly handler: EffectHandler;
  /** An existing journal resumes the run; omit it to start fresh. */
  readonly journal?: Journal;
  /**
   * The pins recorded when this run STARTED, read back from the run record.
   *
   * Present on a resume, absent on a fresh run. When present they are authoritative: every loose
   * option below must either agree with them or be absent, and a caller value that differs is
   * refused (L5009) rather than honoured, because a pin selects which effects run and honouring the
   * override would make this a different run against a journal that was not written for it.
   */
  readonly pins?: RunPins;
  readonly seed?: string;
  /**
   * The run's logical epoch. Resolved from the host clock on a fresh run and read from the pins on
   * a resume; `now()` derives from it, so the resuming host's clock never moves a replayed program.
   */
  readonly startedAt?: number;
  readonly file?: string;
  /** Fail loud rather than spinning forever when a loop does not terminate. */
  readonly effectCeiling?: number;
  /**
   * The HOST's stop, asked before every effect that has not already been recorded.
   *
   * Return a reason to stop the run where it stands; return `undefined` to carry on. The interpreter
   * raises {@link RunReleased} itself rather than accepting an error from the caller — a driver that
   * could throw the class could also throw something a workflow's `try` would swallow, and then the
   * guarantee would be the caller's to keep.
   *
   * This exists because a driver's reasons to stop are not the program's business and must not be
   * recorded as its outcome: an absolute work horizon reached, a pause requested by an operator.
   * Asked here, nothing is half-done — no entry begun, no handler dispatched — so the run is exactly
   * where its journal says it is and the next driver resumes from there.
   */
  readonly shouldStop?: () => string | undefined;
  /**
   * This walk is a MIGRATION's dry replay, not a resume.
   *
   * The two differ in exactly one place and it is a concurrency scope. A resume delivers a settled
   * scope from its own entry and accounts for the whole subtree without entering a branch, which is
   * correct: the program hash is unchanged, so nothing beneath it can have been removed and the
   * branches were decided rather than deleted. A migration runs EDITED source against that journal,
   * so the same short-circuit would account for entries the new source no longer reaches — and an
   * orphan that is never reported is an effect nobody is told about, which for a resolved human
   * checkpoint means a decision silently discarded with L5004 never firing.
   *
   * Set here rather than inferred, because "the source changed" is not something the interpreter
   * can see: it is handed a program and a journal and both are what the caller says they are.
   */
  readonly migration?: boolean;
  /**
   * Fail loud on a loop the effect ceiling cannot see, counted in walker dispatches (L4013).
   *
   * `while (true) { n = n + 1 }` performs no effect, so nothing increments the effect count. This
   * one counts the work itself.
   */
  readonly stepBudget?: number;
  /**
   * How many dispatches the walker runs before handing the macrotask queue back to the host.
   *
   * This is the load-bearing half of the ceiling, not the budget. The walker is async all the way
   * down, so a pure loop floods the MICROTASK queue and starves the macrotask queue completely: a
   * host watchdog's setTimeout never fires, and the runaway takes the timer plane, the run lease,
   * and every other run on that host down with it. Yielding turns an outage back into an incident.
   */
  readonly yieldEvery?: number;
  /**
   * Where `log(...)` goes. Not journalled, and it must never influence control flow: it exists so
   * a human reading a trace can follow what the author meant. Each line carries the scope it was
   * written from, which is what makes a log from inside a concurrent branch readable.
   */
  readonly onLog?: (line: { readonly scope: string; readonly values: readonly unknown[] }) => void;
}

export interface RunResult {
  readonly value: unknown;
  readonly journal: Journal;
  readonly programHash: string;
  /**
   * The pins this attempt ran under, resolved. A fresh run's driver writes these onto the run
   * record; a resumed run's are the ones it was handed back, unchanged.
   */
  readonly pins: RunPins;
  /**
   * Walker dispatches charged against the step budget.
   *
   * Reported rather than merely counted, so a host can see how close a program runs to the ceiling
   * before the ceiling is what tells it.
   */
  readonly steps: number;
}


class Interpreter {
  readonly journal: Journal;
  readonly prng: Prng;
  readonly effects: EffectHost;
  private steps = 0;
  private nextYield: number;
  private readonly stepBudget: number;
  private readonly yieldEvery: number;
  /** The curated method tables (library.ts). Built once: they close over this interpreter's write check. */
  private readonly methods: {
    readonly array: Readonly<Record<string, Method>>;
    readonly string: Readonly<Record<string, Method>>;
    readonly number: Readonly<Record<string, Method>>;
  };

  constructor(
    readonly ast: AnyNode,
    readonly options: RunOptions,
    readonly programHash: string,
    readonly pins: RunPins,
  ) {
    // The journal and the run must be the same run. Request ids derive from `options.runId` while
    // recorded results come from the journal, so a mismatch would submit work under one identity and
    // resolve it against another's history.
    if (options.journal !== undefined && options.journal.run !== options.runId)
      throw new RuntimeFault(
        "L5011",
        `this run is ${options.runId} but it was handed the journal of run ${options.journal.run}; a run resumes only from its own journal`,
      );
    this.journal = options.journal ?? new Journal({ run: options.runId });
    // EVERY limit comes from the pins, never from a default applied here. A default resolved a
    // second time is a default resolved by whichever interpreter happens to be resuming, which is
    // exactly what pinning exists to stop.
    // THE CEILING IS A RUN BOUND, SO THE COUNT STARTS WHERE THE RUN LEFT OFF. L4009 is named "Run
    // effect ceiling reached" and the run record pins the ceiling — a pin is only worth
    // refusing a mismatch on (L5009) if the thing it pins is enforced. Starting at 0 gave every
    // activation a full allowance, so a runaway loop of effects that crashed or was released
    // periodically never reached the ceiling however much it performed against the world, and the
    // fault text claimed a run-scoped fact from an activation-scoped counter.
    this.prng = new Prng(pins.seed);
    this.effects = { journal: this.journal, options, ceiling: pins.effectCeiling, effectCount: this.journal.dispatchedEffects() };
    this.stepBudget = pins.stepBudget;
    this.yieldEvery = pins.yieldEvery;
    this.nextYield = this.yieldEvery;
    this.methods = {
      array: arrayMethods(this.libraryContext()),
      string: stringMethods(),
      number: numberMethods(),
    };
  }

  /** What the library sees of this interpreter. */
  libraryContext(): Parameters<typeof builtins>[0] {
    return {
      runId: this.options.runId,
      programHash: this.programHash,
      startedAt: this.pins.startedAt,
      prng: this.prng,
      ...(this.options.onLog !== undefined ? { onLog: this.options.onLog } : {}),
      assertWritable: (target, frame) => this.assertWritable(target, frame),
    };
  }

  // ---- values: reads and writes ---------------------------------------------------------------

  /**
   * May this frame write into this container? Two refusals, and they are the whole of the value
   * half of freeze-on-share (design D4, §3.4 rule 4):
   *
   * - a FROZEN value crossed an effect boundary, and what crossed is what was recorded (L2031);
   * - a value born OUTSIDE this concurrent branch and written inside it is L2032's defect reached
   *   through a value instead of a binding, and just as silent on resume.
   */
  assertWritable(target: object, frame: { readonly depth: number }): void {
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
  }

  /** The property key a member expression names, as JavaScript would spell it. A computed key is
   *  held to the same no-implicit-conversion law as every other coercion site (L4018): `String(k)`
   *  on a record would enter the host's ToPrimitive, which calls the value's own `toString` — a
   *  program closure invoked without a Frame. Measured before the refusal: the closure's rejection
   *  escaped as an unhandled host TypeError AFTER the run returned, and `o[{}] = 1` silently minted
   *  the own field `"[object Object]"`. Primitives keep JavaScript's spelling (`o[1]`, `o[true]`). */
  private async memberKey(node: AnyNode, env: Env, frame: Frame): Promise<string> {
    if (node.computed !== true) return (node.property as AnyNode).name as string;
    const k = await this.evaluate(node.property as AnyNode, env, frame);
    if (typeof k === "string") return k;
    refuseCoercion("[...]", k);
    return String(k);
  }

  /**
   * Read a member. Records answer their own fields and `undefined` for anything else, so a host
   * prototype is never reached (`o.constructor`, `o.toString` are `undefined`); strings, arrays and
   * numbers answer `length`, an index, or an entry of their method table, and refuse anything else
   * (L4014). Functions and booleans have no members.
   */
  memberOf(obj: unknown, prop: string, asCallee = false): unknown {
    switch (typeof obj) {
      case "string": {
        if (prop === "length") return obj.length;
        const i = arrayIndex(prop);
        if (i !== undefined) return obj[i];
        return this.method(this.methods.string, obj, prop, "a string", asCallee);
      }
      case "number":
        return this.method(this.methods.number, obj, prop, "a number", asCallee);
      case "object": {
        if (obj === null) throw new RuntimeFault("L4010", `cannot read \`${prop}\` of null`);
        if (Array.isArray(obj)) {
          if (prop === "length") return obj.length;
          const i = arrayIndex(prop);
          if (i !== undefined) return obj[i];
          return this.method(this.methods.array, obj, prop, "an array", asCallee);
        }
        return Object.prototype.hasOwnProperty.call(obj, prop) ? (obj as Record<string, unknown>)[prop] : undefined;
      }
      case "undefined":
        throw new RuntimeFault("L4010", `cannot read \`${prop}\` of undefined`);
      default:
        throw new RuntimeFault("L4014", `\`${prop}\` is not a member: a ${typeof obj} has no members`);
    }
  }

  private method(
    table: Readonly<Record<string, Method>>,
    receiver: unknown,
    prop: string,
    kind: string,
    asCallee: boolean,
  ): Callable {
    const m = table[prop];
    if (m === undefined) {
      throw new RuntimeFault(
        "L4014",
        `\`${prop}\` is not a member of ${kind}. The members are: length, an index, ${Object.keys(table).join(", ")}.`,
      );
    }
    // A method is looked up at the call and exists nowhere else — a declared difference from
    // JavaScript, where `xs.map` is a value. Handing one out produced everything a bound-function
    // factory produces (measured): `xs.map === xs.map` was false where JavaScript says true, and
    // an extracted `push` wrote to its receiver where strict JavaScript throws. Refusing the read
    // is honest on both counts.
    if (!asCallee) {
      throw new RuntimeFault(
        "L4020",
        `\`${prop}\` is a method of ${kind}, and a method is not a value here: it is looked up at the call, so it cannot be extracted, compared, or passed. Call it — \`.${prop}(...)\` — or wrap it: \`(...args) => value.${prop}(...args)\`.`,
      );
    }
    return async (frame, args) => await m(frame, receiver as never, args);
  }

  /** Write a member: `o.a = v`, `xs[i] = v`. Records take any own field; arrays take an index or `length`. */
  writeMember(obj: unknown, prop: string, value: unknown, frame: Frame): void {
    if (obj === null || obj === undefined || typeof obj !== "object") {
      throw new RuntimeFault("L4010", `cannot write \`${prop}\` of ${obj === null ? "null" : typeof obj === "undefined" ? "undefined" : `a ${typeof obj}`}`);
    }
    this.assertWritable(obj, frame);
    if (Array.isArray(obj)) {
      if (prop === "length") {
        // `xs.length = n` truncates, as in JavaScript. A LONGER length is refused: JavaScript would
        // fill the gap with holes, and a hole is a value class this language does not have (its
        // methods do not skip holes, so a program with holes would read differently here and on a
        // real engine). Push what you need instead. `length` is not an own data property that
        // `setOwn` can define, so the write goes to the array itself.
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > obj.length) {
          throw new RuntimeFault(
            "L4017",
            `\`length\` can only be set to an integer between 0 and the array's current length (${obj.length}), got ${typeof value === "number" ? value : typeof value}: a longer length would create holes, which this language does not have; push the elements instead`,
          );
        }
        obj.length = value;
        return;
      }
      const i = arrayIndex(prop);
      if (i === undefined) {
        throw new RuntimeFault("L4014", `\`${prop}\` is not a member of an array: an array takes an index or \`length\``);
      }
      // Contiguous or refused: JavaScript would fill the gap with holes, and a hole is a value
      // class this language does not have (measured before the refusal: `xs[2] = 1` on an empty
      // array built a sparse array whose holes then crossed an effect boundary as silent nulls).
      // Writing AT the length appends, which is `push` by another spelling and makes no hole.
      if (i > obj.length) {
        throw new RuntimeFault(
          "L4019",
          `index ${i} is past the end of this array (length ${obj.length}), and JavaScript would fill the gap with holes, which this language does not have. Write at an existing index, at the length to append, or use \`push\`.`,
        );
      }
    } else if (prop === "__proto__") {
      throw new RuntimeFault("L4014", "`__proto__` names an object's prototype, and there are no prototypes here");
    }
    setRecordMember(obj, prop, value);
  }

  // ---- the fuel ceiling -----------------------------------------------------------------------

  /**
   * Charge one walker dispatch.
   *
   * Returns null on the common path and a promise only when it is time to breathe, so a dispatch
   * normally costs an increment and a compare rather than an allocated promise. Callers await the
   * result only when it is non-null, which is why this is not simply an async method.
   */
  private tick(frame: Frame): Promise<void> | null {
    this.steps += 1;
    if (this.steps > this.stepBudget) {
      throw new RuntimeFault(
        "L4013",
        `this walk has taken more than ${this.stepBudget} interpreter steps without finishing, which means a loop that performs no effect is not terminating. The effect ceiling cannot see such a loop, because it performs nothing to count. Add an exit condition, or raise stepBudget if the program legitimately does this much work. (stepBudget bounds ONE WALK, not the run: steps are not recorded, so a resume cannot recover a count the way the effect ceiling can.)`,
      );
    }
    if (this.steps < this.nextYield) return null;
    this.nextYield = this.steps + this.yieldEvery;
    return this.breathe(frame);
  }

  get stepCount(): number {
    return this.steps;
  }

  /**
   * Hand the macrotask queue back, then abandon this branch's pure work IF IT CAN NO LONGER MATTER.
   *
   * Cancellation is otherwise observed only at effect boundaries (see {@link Interpreter.performEffect}).
   * This line used to cut every cancelled branch, so a `race` loser in a pure tail was abandoned at
   * its next yield, and whether an arm that had already performed its last effect got to settle
   * depended on how many dispatches its tail took against `yieldEvery`: the winner of a live race
   * was a function of a host tuning knob (design §3.4, measured). The cut is now the scope's call
   * (`Signal.cutPure`): an arm that cannot win any more is abandoned here, and an arm that could
   * still win runs its pure work to a settle, so the winner is the recorded clocks and declaration
   * order and nothing else (see `runScope`). An arm that could still win and spins forever is a
   * pure infinite loop, and it ends the way every pure infinite loop ends: on the step budget
   * (L4013), loudly, which is the run's answer rather than the scheduler's.
   */
  private async breathe(frame: Frame): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    if (frame.signal.cutPure) throw new Cancelled(frame.signal.reason ?? "cancelled");
  }

  // ---- the effect seam ------------------------------------------------------------------------

  /**
   * Perform one effect, or replay it. The machinery is {@link performEffect} in `perform.ts`,
   * shared with the v2 engine host; this method binds it to this run.
   */
  async performEffect(
    kind: EffectKind,
    name: string,
    hashedInput: unknown,
    perform: (ctx: EffectContext, inputHash: string) => Promise<unknown>,
    frame: Frame,
  ): Promise<unknown> {
    return await performEffect(this.effects, kind, name, hashedInput, perform, frame);
  }

  // ---- expressions ------------------------------------------------------------------------------

  async evaluate(node: AnyNode, env: Env, frame: Frame): Promise<unknown> {
    const pause = this.tick(frame);
    if (pause !== null) await pause;
    switch (node.type) {
      case "Literal":
        return node.value;
      case "Identifier":
        return env.get(node.name as string);
      case "TemplateLiteral": {
        const quasis = node.quasis as AnyNode[];
        const exprs = node.expressions as AnyNode[];
        let out = "";
        for (let i = 0; i < quasis.length; i += 1) {
          out += ((quasis[i] as AnyNode).value as { cooked: string }).cooked;
          if (i < exprs.length) {
            // Primitives interpolate as JavaScript interpolates them; a container or a function is
            // refused (L4018). Measured before the refusal: `${o}` on a record with its own
            // `toString` crashed in the host's ToPrimitive, and `${f}` on a function PRINTED THE
            // INTERPRETER'S OWN COMPILED CLOSURE — an implementation detail leaking into a value.
            const v = await this.evaluate(exprs[i] as AnyNode, env, frame);
            refuseCoercion("${...}", v);
            out += String(v);
          }
        }
        return out;
      }
      case "ArrayExpression": {
        const out: unknown[] = [];
        for (const el of (node.elements as AnyNode[]) ?? []) {
          if (el.type === "SpreadElement") out.push(...this.spreadable(await this.evaluate(el.argument as AnyNode, env, frame)));
          else out.push(await this.evaluate(el, env, frame));
        }
        return born(out, frame.depth);
      }
      case "ObjectExpression": {
        const out: Record<string, unknown> = {};
        for (const p of (node.properties as AnyNode[]) ?? []) {
          if (p.type === "SpreadElement") {
            const src = await this.evaluate(p.argument as AnyNode, env, frame);
            if (src !== null && src !== undefined) {
              for (const [k, v] of Object.entries(src as Record<string, unknown>)) setRecordMember(out, k, v);
            }
            continue;
          }
          const key = p.key as AnyNode;
          const name = key.type === "Identifier" ? (key.name as string) : String(key.value);
          setRecordMember(out, name, await this.evaluate(p.value as AnyNode, env, frame));
        }
        return born(out, frame.depth);
      }
      case "MemberExpression": {
        const obj = await this.evaluate(node.object as AnyNode, env, frame);
        if ((obj === null || obj === undefined) && node.optional === true) throw SHORT_CIRCUIT;
        return this.memberOf(obj, await this.memberKey(node, env, frame));
      }
      case "ChainExpression": {
        // `a?.b.c(d)`: a nullish `a` ends the WHOLE chain with `undefined`, and nothing after the
        // `?.` is evaluated. The short-circuit travels as a private sentinel that only this case
        // catches; a program's `try` cannot see it, because a chain is an expression and a `try`
        // wraps statements.
        try {
          return await this.evaluate(node.expression as AnyNode, env, frame);
        } catch (e) {
          if (e === SHORT_CIRCUIT) return undefined;
          throw e;
        }
      }
      case "UnaryExpression": {
        const v = await this.evaluate(node.argument as AnyNode, env, frame);
        switch (node.operator) {
          case "!":
            return !v;
          case "-":
            refuseCoercion("-", v);
            return -(v as number);
          case "+":
            refuseCoercion("+", v);
            return +(v as number);
          case "~":
            refuseCoercion("~", v);
            return ~(v as number);
          case "typeof":
            return typeof v;
          default:
            throw new RuntimeFault("L1000", `unsupported unary operator ${String(node.operator)}`);
        }
      }
      case "UpdateExpression": {
        // `x++`, `--o.count`: JavaScript's meaning, with the write going through the same two doors
        // as an assignment (a binding's depth, a value's writability).
        const delta = node.operator === "++" ? 1 : -1;
        const prefix = node.prefix === true;
        const arg = node.argument as AnyNode;
        if (arg.type === "Identifier") {
          const name = arg.name as string;
          const old = Number(env.get(name));
          const next = old + delta;
          env.set(name, next, frame.depth);
          return prefix ? next : old;
        }
        const obj = await this.evaluate(arg.object as AnyNode, env, frame);
        const key = await this.memberKey(arg, env, frame);
        const old = Number(this.memberOf(obj, key));
        const next = old + delta;
        this.writeMember(obj, key, next, frame);
        return prefix ? next : old;
      }
      case "BinaryExpression": {
        const l = await this.evaluate(node.left as AnyNode, env, frame);
        const r = await this.evaluate(node.right as AnyNode, env, frame);
        return applyBinary(node.operator as string, l, r);
      }
      case "LogicalExpression": {
        const l = await this.evaluate(node.left as AnyNode, env, frame);
        switch (node.operator) {
          case "&&":
            return (l as boolean) ? await this.evaluate(node.right as AnyNode, env, frame) : l;
          case "||":
            return (l as boolean) ? l : await this.evaluate(node.right as AnyNode, env, frame);
          case "??":
            // Orc's `otherwise`, spelled the way JavaScript already spells it: an event that
            // halted without a result resolves null, and this is the recovery path.
            return l === null || l === undefined
              ? await this.evaluate(node.right as AnyNode, env, frame)
              : l;
          default:
            throw new RuntimeFault("L1000", `unsupported logical operator ${String(node.operator)}`);
        }
      }
      case "ConditionalExpression":
        return (await this.evaluate(node.test as AnyNode, env, frame))
          ? await this.evaluate(node.consequent as AnyNode, env, frame)
          : await this.evaluate(node.alternate as AnyNode, env, frame);
      case "AssignmentExpression":
        return await this.assign(node, env, frame);
      case "AwaitExpression":
        return await this.evaluate(node.argument as AnyNode, env, frame);
      case "ArrowFunctionExpression":
      case "FunctionExpression":
        return this.makeFunction(node, env);
      case "CallExpression":
        return await this.call(node, env, frame);
      default:
        throw new RuntimeFault("L1000", `unsupported expression ${node.type}`);
    }
  }

  /**
   * Every assignment operator, on a binding or a member: `x = v`, `x += v`, `o.a ??= v`,
   * `[a, b] = [b, a]`. The operator's meaning is JavaScript's; the write goes through the binding's
   * depth check ({@link Env.set}) or the value's writability check ({@link Interpreter.writeMember}).
   */
  private async assign(node: AnyNode, env: Env, frame: Frame): Promise<unknown> {
    const op = node.operator as string;
    const left = node.left as AnyNode;

    if (left.type === "ObjectPattern" || left.type === "ArrayPattern") {
      const value = await this.evaluate(node.right as AnyNode, env, frame);
      await this.bindPattern(left, value, env, frame, "assign");
      return value;
    }

    const read =
      left.type === "Identifier"
        ? { get: (): unknown => env.get(left.name as string), set: (v: unknown): void => env.set(left.name as string, v, frame.depth) }
        : await (async () => {
            const obj = await this.evaluate(left.object as AnyNode, env, frame);
            const key = await this.memberKey(left, env, frame);
            return { get: (): unknown => this.memberOf(obj, key), set: (v: unknown): void => this.writeMember(obj, key, v, frame) };
          })();

    if (op === "=") {
      const v = await this.evaluate(node.right as AnyNode, env, frame);
      read.set(v);
      return v;
    }
    if (op === "&&=" || op === "||=" || op === "??=") {
      const cur = read.get();
      const proceed = op === "&&=" ? Boolean(cur) : op === "||=" ? !cur : cur === null || cur === undefined;
      if (!proceed) return cur;
      const v = await this.evaluate(node.right as AnyNode, env, frame);
      read.set(v);
      return v;
    }
    const cur = read.get();
    const r = await this.evaluate(node.right as AnyNode, env, frame);
    const v = applyBinary(op.slice(0, -1), cur, r);
    read.set(v);
    return v;
  }

  /** What `...x` and `for (const v of x)` may iterate: an array or a string, and nothing else (L4015). */
  private spreadable(v: unknown): unknown[] {
    if (Array.isArray(v)) return v;
    if (typeof v === "string") return [...v];
    throw new RuntimeFault(
      "L4015",
      `${v === null ? "null" : typeof v === "object" ? "a record" : typeof v} is not iterable: only arrays and strings can be spread or looped over. For a record, iterate \`keys(record)\` or \`entries(record)\`.`,
    );
  }

  makeFunction(node: AnyNode, closure: Env): (frame: Frame, args: unknown[]) => Promise<unknown> {
    const params = (node.params as AnyNode[]) ?? [];
    const body = node.body as AnyNode;
    const isExpressionBody = body.type !== "BlockStatement";
    const self = async (frame: Frame, args: unknown[]): Promise<unknown> => {
      // The calling FRAME decides the depth, not the closure: a helper declared at the top level
      // and called from inside a branch is executing concurrently, whatever scope it was written in.
      const env = new Env(closure, frame.depth);
      // A named function expression sees its own name: `const f = function walk(n) { ... walk() }`.
      if (node.type === "FunctionExpression" && node.id !== null && node.id !== undefined) {
        env.declare((node.id as AnyNode).name as string, self, false);
      }
      for (let i = 0; i < params.length; i += 1) {
        const param = params[i] as AnyNode;
        if (param.type === "RestElement") {
          await this.bindPattern(param.argument as AnyNode, born(args.slice(i), frame.depth), env, frame, "let");
          break;
        }
        await this.bindPattern(param, args[i], env, frame, "let");
      }
      if (isExpressionBody) return await this.evaluate(body, env, frame);
      const c = await this.executeBlock(body, env, frame);
      return c.type === "return" ? c.value : undefined;
    };
    return self;
  }

  /**
   * Bind a pattern: declare its names (`const`/`let`, including parameters, which are `let`) or
   * assign to bindings that already exist (`assign`, for `[a, b] = [b, a]`).
   */
  async bindPattern(
    pattern: AnyNode,
    value: unknown,
    env: Env,
    frame: Frame,
    mode: "const" | "let" | "assign",
  ): Promise<void> {
    switch (pattern.type) {
      case "Identifier":
        if (mode === "assign") env.set(pattern.name as string, value, frame.depth);
        else env.declare(pattern.name as string, value, mode === "let");
        return;
      case "MemberExpression": {
        // Only reachable in `assign` mode: `[o.a, o.b] = pair`.
        const obj = await this.evaluate(pattern.object as AnyNode, env, frame);
        this.writeMember(obj, await this.memberKey(pattern, env, frame), value, frame);
        return;
      }
      case "AssignmentPattern":
        await this.bindPattern(
          pattern.left as AnyNode,
          value === undefined ? await this.evaluate(pattern.right as AnyNode, env, frame) : value,
          env,
          frame,
          mode,
        );
        return;
      case "ObjectPattern": {
        if (value === null || value === undefined) {
          throw new RuntimeFault("L4010", `cannot destructure ${String(value)}: there are no fields to take`);
        }
        const src = value as Record<string, unknown>;
        const taken: string[] = [];
        for (const p of pattern.properties as AnyNode[]) {
          if (p.type === "RestElement") {
            const rest: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(src)) if (!taken.includes(k)) setRecordMember(rest, k, v);
            await this.bindPattern(p.argument as AnyNode, born(rest, frame.depth), env, frame, mode);
            continue;
          }
          const key = p.key as AnyNode;
          const name = key.type === "Identifier" ? (key.name as string) : String(key.value);
          taken.push(name);
          await this.bindPattern(p.value as AnyNode, this.memberOf(src, name), env, frame, mode);
        }
        return;
      }
      case "ArrayPattern": {
        if (value === null || value === undefined) {
          throw new RuntimeFault("L4010", `cannot destructure ${String(value)}: there are no elements to take`);
        }
        const src = this.spreadable(value);
        const els = pattern.elements as (AnyNode | null)[];
        for (let i = 0; i < els.length; i += 1) {
          const el = els[i];
          if (el === null || el === undefined) continue;
          if (el.type === "RestElement") {
            await this.bindPattern(el.argument as AnyNode, born(src.slice(i), frame.depth), env, frame, mode);
            break;
          }
          await this.bindPattern(el, src[i], env, frame, mode);
        }
        return;
      }
      default:
        throw new RuntimeFault("L1000", `unsupported binding pattern ${pattern.type}`);
    }
  }

  // ---- calls ----------------------------------------------------------------------------------

  async call(node: AnyNode, env: Env, frame: Frame): Promise<unknown> {
    const callee = node.callee as AnyNode;
    const argNodes = (node.arguments as AnyNode[]) ?? [];

    // A primitive is dispatched by NAME, not by value. The validator forbids shadowing one, so a
    // call spelled `turn` is always the effect, which is what keeps the flowchart projection and
    // the linter sound.
    if (callee.type === "Identifier" && PRIMITIVES[callee.name as string] !== undefined && !env.has(callee.name as string)) {
      return await this.callPrimitive(callee.name as string, argNodes, env, frame);
    }

    let fn: unknown;
    if (callee.type === "MemberExpression") {
      // The one place a method NAME may appear: as the callee. Resolving it here, with the flag,
      // is what lets `memberOf` refuse the same name everywhere else (L4020).
      const obj = await this.evaluate(callee.object as AnyNode, env, frame);
      if ((obj === null || obj === undefined) && callee.optional === true) throw SHORT_CIRCUIT;
      fn = this.memberOf(obj, await this.memberKey(callee, env, frame), true);
    } else {
      fn = await this.evaluate(callee, env, frame);
    }
    if ((fn === null || fn === undefined) && node.optional === true) throw SHORT_CIRCUIT;
    const args: unknown[] = [];
    for (const a of argNodes) {
      if (a.type === "SpreadElement") args.push(...this.spreadable(await this.evaluate(a.argument as AnyNode, env, frame)));
      else args.push(await this.evaluate(a, env, frame));
    }
    if (typeof fn !== "function") {
      throw new RuntimeFault("L4011", `this value is not a function, so it cannot be called`);
    }
    return await (fn as (frame: Frame, args: unknown[]) => Promise<unknown>)(frame, args);
  }

  async callPrimitive(name: string, argNodes: AnyNode[], env: Env, frame: Frame): Promise<unknown> {
    const spec = PRIMITIVES[name];
    if (spec === undefined) throw new RuntimeFault("L2001", `${name} is not a primitive`);

    // Concurrency combinators take their branches unevaluated: the thunks must run inside their
    // own frames, so evaluating them here would defeat the whole point.
    if (spec.opensScope) return await this.callScope(name, argNodes, env, frame);

    const args: unknown[] = [];
    for (const a of argNodes) args.push(await this.evaluate(a, env, frame));
    return await dispatchPrimitive(this.effects, name, args, frame);
  }

  /**
   * The `branchDigest`, over the arms a settled `race` will never be walked into.
   *
   * STRUCTURE, NOT TEXT AND NOT POSITION. Acorn nodes carry `start`/`end`, and an edit anywhere
   * earlier in the file moves every offset after it — a digest over those would diverge on a run
   * whose race nobody touched, which is the false positive that teaches people to bypass a check.
   * Digesting the source SLICE instead would diverge on reindentation for the same reason. What is
   * hashed is the branch body's shape with positions stripped, so a reformat is silent and an edit
   * is not.
   *
   * Only the LOSERS, because only they are unwalked. The winner's arm is walked entry by entry and
   * an edit inside it already diverges on the ordinary hash check with the step it broke named —
   * a strictly better error than "some branch changed". Digesting the winner too would replace that
   * error with this one, so it does not.
   */
  private branchDigester(branchesNode: AnyNode | undefined): ((losers: readonly string[]) => string | undefined) | undefined {
    if (branchesNode?.type !== "ObjectExpression") return undefined;
    const bodies = new Map<string, unknown>();
    for (const p of (branchesNode.properties as AnyNode[] | undefined) ?? []) {
      const key = p.key as AnyNode | undefined;
      const named = (key?.name as string | undefined) ?? (key?.value as string | undefined);
      if (named !== undefined) bodies.set(named, stripPositions(p.value));
    }
    return (losers) =>
      digest(
        [...losers]
          .sort()
          .map((n) => [n, bodies.has(n) ? bodies.get(n) : null]),
      );
  }

  /**
   * The concurrency combinators.
   *
   * Each pushes a scope frame whose occurrence is allocated HERE, synchronously, in code that is
   * already deterministic. Each branch then gets its own key namespace, so two branches running
   * the same named effect cannot race for a counter, and replay reproduces both regardless of
   * which one finished first.
   */
  /** An options-bag field, read the way the shared scope machinery reads one. */
  private option(bag: unknown, key: string): unknown {
    return option(bag, key);
  }

  async callScope(name: string, argNodes: AnyNode[], env: Env, frame: Frame): Promise<unknown> {
    const spec = PRIMITIVES[name];
    if (spec === undefined) throw new RuntimeFault("L2001", `${name} is not a primitive`);
    const scopeKind = name as ScopeKind;

    const first = await this.evaluate(argNodes[0] as AnyNode, env, frame);
    const bagNode = argNodes[spec.optionsAt];
    const bag = bagNode === undefined ? undefined : await this.evaluate(bagNode, env, frame);
    const scopeName = (this.option(bag, "name") as string | undefined) ?? null;
    const occurrence = frame.keys.nextScope(scopeKind, scopeName);
    const scopeKey = frame.keys.scopeKey(scopeKind, scopeName, occurrence);

    // `conclave` is the one scope whose identity includes a SUBJECT (`hashesSubject`): the
    // members are what the sub-team IS, so editing the member list has to diverge rather than
    // resume into a different room. The other three are identified by kind, name and occurrence.
    const subject = spec.hashesSubject
      ? {
          members: (first as AgentHandleValue[]).map((m) => m.agent),
          channel: (this.option(bag, "channel") as string | undefined) ?? null,
        }
      : undefined;

    return await performScope(
      this.effects,
      scopeKey,
      frame,
      async (ctx, only) =>
        await runScope(
          this.effects,
          name,
          scopeKind,
          scopeName,
          occurrence,
          first,
          // Deferred, so the body is evaluated where it was evaluated before: after the scope's
          // entry has begun, not at this call. `parallel` and `race` never ask for it.
          async () => await this.evaluate(argNodes[1] as AnyNode, env, frame),
          bag,
          frame,
          ctx,
          only,
        ),
      subject,
      // `race` alone. `parallel` and `fanOut` have no losers — every branch is a winner and the
      // walk enters all of them — and a `conclave` cannot be walked into at all, so a digest there
      // would bind arms nothing was ever going to miss.
      name === "race" ? this.branchDigester(argNodes[0]) : undefined,
    );
  }

    // ---- statements --------------------------------------------------------------------------------

  async executeBlock(block: AnyNode, env: Env, frame: Frame): Promise<Completion> {
    const inner = new Env(env);
    const body = (block.body as AnyNode[]) ?? [];
    for (const s of body) {
      if (s.type === "FunctionDeclaration") {
        inner.declare(((s.id as AnyNode).name as string), this.makeFunction(s, inner), false);
      }
    }
    // `let`/`const` bind the whole block, holding the dead-zone marker until their line runs, so a
    // closure called early finds "declared, not yet initialized" (L2004) rather than an outer
    // binding of the same name — which is what JavaScript does, minus the host error class.
    for (const s of body) {
      if (s.type !== "VariableDeclaration") continue;
      for (const d of (s.declarations as AnyNode[]) ?? []) {
        for (const n of declaredNames(d.id as AnyNode)) inner.declare(n, TDZ, s.kind === "let");
      }
    }
    for (const s of body) {
      const c = await this.execute(s, inner, frame);
      if (c.type !== "normal") return c;
    }
    return NORMAL;
  }

  async execute(node: AnyNode, env: Env, frame: Frame): Promise<Completion> {
    const pause = this.tick(frame);
    if (pause !== null) await pause;
    switch (node.type) {
      case "ExpressionStatement":
        await this.evaluate(node.expression as AnyNode, env, frame);
        return NORMAL;
      case "VariableDeclaration": {
        const mode = node.kind === "let" ? "let" : "const";
        for (const d of node.declarations as AnyNode[]) {
          const init = d.init === null || d.init === undefined ? undefined : await this.evaluate(d.init as AnyNode, env, frame);
          await this.bindPattern(d.id as AnyNode, init, env, frame, mode);
        }
        return NORMAL;
      }
      case "FunctionDeclaration":
        return NORMAL; // hoisted by executeBlock
      case "BlockStatement":
        return await this.executeBlock(node, env, frame);
      case "IfStatement":
        if (await this.evaluate(node.test as AnyNode, env, frame)) {
          return await this.execute(node.consequent as AnyNode, env, frame);
        }
        return node.alternate === null || node.alternate === undefined
          ? NORMAL
          : await this.execute(node.alternate as AnyNode, env, frame);
      case "WhileStatement":
        for (;;) {
          if (!(await this.evaluate(node.test as AnyNode, env, frame))) return NORMAL;
          const c = await this.execute(node.body as AnyNode, env, frame);
          if (c.type === "break") return NORMAL;
          if (c.type === "return") return c;
        }
      case "ForStatement": {
        let loopEnv = new Env(env);
        const init = node.init as AnyNode | null | undefined;
        if (init !== null && init !== undefined) {
          if (init.type === "VariableDeclaration") await this.execute(init, loopEnv, frame);
          else await this.evaluate(init, loopEnv, frame);
        }
        // `for (let i ...)` gives EACH ITERATION its own `i`, as JavaScript does: a closure made in
        // one iteration keeps that iteration's value. The copy happens after the body and before the
        // update, which is where the specification puts it.
        const perIteration: string[] = [];
        if (init?.type === "VariableDeclaration" && init.kind === "let") {
          for (const d of init.declarations as AnyNode[]) collectNames(d.id as AnyNode, perIteration);
        }
        for (;;) {
          if (node.test !== null && node.test !== undefined && !(await this.evaluate(node.test as AnyNode, loopEnv, frame))) {
            return NORMAL;
          }
          const c = await this.execute(node.body as AnyNode, loopEnv, frame);
          if (c.type === "break") return NORMAL;
          if (c.type === "return") return c;
          if (perIteration.length > 0) loopEnv = loopEnv.perIteration(perIteration);
          if (node.update !== null && node.update !== undefined) await this.evaluate(node.update as AnyNode, loopEnv, frame);
        }
      }
      case "ForOfStatement": {
        const iterable = this.spreadable(await this.evaluate(node.right as AnyNode, env, frame));
        const decl = node.left as AnyNode;
        for (const item of iterable) {
          const loopEnv = new Env(env);
          if (decl.type === "VariableDeclaration") {
            const target = ((decl.declarations as AnyNode[])[0] as AnyNode).id as AnyNode;
            await this.bindPattern(target, item, loopEnv, frame, decl.kind === "let" ? "let" : "const");
          } else {
            await this.bindPattern(decl, item, loopEnv, frame, "assign");
          }
          const c = await this.execute(node.body as AnyNode, loopEnv, frame);
          if (c.type === "break") return NORMAL;
          if (c.type === "return") return c;
        }
        return NORMAL;
      }
      case "ReturnStatement":
        return {
          type: "return",
          value: node.argument === null || node.argument === undefined ? undefined : await this.evaluate(node.argument as AnyNode, env, frame),
        };
      case "BreakStatement":
        return { type: "break" };
      case "ContinueStatement":
        return { type: "continue" };
      case "ThrowStatement":
        throw await this.evaluate(node.argument as AnyNode, env, frame);
      case "TryStatement": {
        // What a `catch` may not have: none of these is a program error, and none is this
        // program's to handle. Three kinds, six classes.
        //
        // A cancellation is the scope being unwound, and swallowing it would keep a branch
        // working after it lost a race.
        //
        // A durability failure is the JOURNAL refusing to record: the run losing its ability to
        // have a result at all. A program that catches one goes on performing effects against the
        // world with nothing recorded from the refusal onward, so those effects exist only in the
        // world and a resume performs them again. An unrecordable run must stop, and no `catch`
        // may decide otherwise.
        //
        // And a DIVERGENCE, or a migration walk's refusal to enter a scope, is the journal saying
        // this program is not the one that wrote it. Measured before this line existed: a resume
        // whose edited `sleep` diverged inside a `try` caught `{ code: "L4000", kind: "host" }`,
        // logged past it, and performed a NEW effect against the journal it had just diverged
        // from; a migration's dry walk would have reported the same program clean.
        //
        // AND `finally` IS BOUND BY THE SAME LAW. A finalizer runs on the way out, so an
        // unconditional one handed the program a landing past every class above: measured, a
        // `finally` performed a NEW effect after a RunReleased and after a store rejection, and a
        // `finally { throw ... }` REPLACED a divergence, which an outer catch then swallowed as an
        // ordinary error. An uncatchable fault now unwinds past the finalizer too: the run's
        // continuation is forfeit, and that includes its cleanup — the world-side recovery belongs
        // to the driver and the journal, not to the program that just lost the right to run.
        const uncatchable = (e: unknown): boolean =>
          e instanceof Cancelled ||
          e instanceof JournalAppendRejected ||
          e instanceof RunReleased ||
          e instanceof RunDivergence ||
          e instanceof ScopeBranchMissing ||
          e instanceof UnwalkableScope;
        // JavaScript's completion semantics, which the one-`try` shape this replaced could not
        // express (measured: `try { return 1; } finally { return 2; }` returned 1): the finalizer
        // always runs for ordinary completions, and an ABRUPT finalizer completion — a return, a
        // break, a throw — replaces whatever the try or catch had decided.
        let completion: Completion = NORMAL;
        let pendingThrow: unknown;
        let hasThrow = false;
        try {
          completion = await this.execute(node.block as AnyNode, env, frame);
        } catch (e) {
          if (uncatchable(e)) throw e;
          const handlerNode = node.handler as AnyNode | null;
          if (handlerNode === null || handlerNode === undefined) {
            hasThrow = true;
            pendingThrow = e;
          } else {
            try {
              const catchEnv = new Env(env);
              if (handlerNode.param !== null && handlerNode.param !== undefined) {
                await this.bindPattern(handlerNode.param as AnyNode, toProgramError(e), catchEnv, frame, "const");
              }
              completion = await this.executeBlock(handlerNode.body as AnyNode, catchEnv, frame);
            } catch (ce) {
              if (uncatchable(ce)) throw ce;
              hasThrow = true;
              pendingThrow = ce;
            }
          }
        }
        if (node.finalizer !== null && node.finalizer !== undefined) {
          // A throw inside the finalizer — its own, or an uncatchable — propagates from here,
          // replacing any pending completion, exactly as JavaScript replaces it.
          const f = await this.execute(node.finalizer as AnyNode, env, frame);
          if (f.type !== "normal") return f;
        }
        if (hasThrow) throw pendingThrow;
        return completion;
      }
      case "SwitchStatement": {
        // JavaScript's selection: the case tests are tried in source order, the `default` clause's
        // position is skipped during matching, and `default` is entered only when NO case matched.
        // The one-pass walk this replaced treated `default` as an immediate match, so a `default`
        // written above a matching case shadowed it (measured: `default` ran, `case 2` did not).
        // Execution then falls through from the selected clause in source order, `default`
        // included, exactly as JavaScript falls.
        const disc = await this.evaluate(node.discriminant as AnyNode, env, frame);
        const cases = node.cases as AnyNode[];
        const switchEnv = new Env(env);
        let start = -1;
        for (let i = 0; i < cases.length; i += 1) {
          const c = cases[i] as AnyNode;
          if (c.test === null || c.test === undefined) continue;
          if ((await this.evaluate(c.test as AnyNode, switchEnv, frame)) === disc) {
            start = i;
            break;
          }
        }
        if (start === -1) start = cases.findIndex((c) => (c as AnyNode).test === null || (c as AnyNode).test === undefined);
        if (start === -1) return NORMAL;
        for (let i = start; i < cases.length; i += 1) {
          for (const s of ((cases[i] as AnyNode).consequent as AnyNode[]) ?? []) {
            const comp = await this.execute(s, switchEnv, frame);
            if (comp.type === "break") return NORMAL;
            if (comp.type !== "normal") return comp;
          }
        }
        return NORMAL;
      }
      case "EmptyStatement":
        return NORMAL;
      default:
        throw new RuntimeFault("L1000", `unsupported statement ${node.type}`);
    }
  }
}

// ---- helpers -------------------------------------------------------------------------------------

/** The names a declaration's pattern introduces, for the dead-zone pre-pass. */
function declaredNames(pattern: AnyNode): string[] {
  const out: string[] = [];
  const walk = (n: AnyNode | null | undefined): void => {
    if (n === null || n === undefined) return;
    switch (n.type) {
      case "Identifier":
        out.push(n.name as string);
        return;
      case "ObjectPattern":
        for (const p of (n.properties as AnyNode[]) ?? []) walk((p.type === "RestElement" ? p.argument : p.value) as AnyNode);
        return;
      case "ArrayPattern":
        for (const el of (n.elements as (AnyNode | null)[]) ?? []) walk(el);
        return;
      case "AssignmentPattern":
        walk(n.left as AnyNode);
        return;
      case "RestElement":
        walk(n.argument as AnyNode);
        return;
      default:
        return;
    }
  };
  walk(pattern);
  return out;
}

/**
 * The binary operators, with JavaScript's meaning ON PRIMITIVES. `"a" + 1`, `true + 1` and
 * `null + 1` mean here exactly what they mean in JavaScript — primitive coercion is pure and
 * deterministic. A record, an array or a function operand is refused (L4018), a declared
 * difference: JavaScript would reach for the host's ToPrimitive machinery, which reads `valueOf`/
 * `toString` off the value — own fields a program can set to its OWN closures. Measured before the
 * refusal: `o + 1` invoked such a closure without an interpreter frame and crashed with a raw host
 * TypeError, and without one it silently produced `"[object Object]1"`. `==` and `!=` never reach
 * this function: the validator refuses them (L1025). `===`/`!==` compare identity and take any
 * operands.
 */
/** Refuse a container or function where a primitive is needed: there is no implicit conversion. */
function refuseCoercion(where: string, v: unknown): void {
  if (v !== null && (typeof v === "object" || typeof v === "function")) {
    const kind = typeof v === "function" ? "a function" : Array.isArray(v) ? "an array" : "a record";
    throw new RuntimeFault(
      "L4018",
      `\`${where}\` cannot take ${kind}: there is no implicit conversion here, because converting would read \`valueOf\`/\`toString\` off the value — host machinery this language does not have. Convert explicitly: \`json.stringify(value)\` for text, or read the field you mean.`,
    );
  }
}

function applyBinary(op: string, l: unknown, r: unknown): unknown {
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
}

/** A canonical array index (`"0"`, `"12"`), as a number, or nothing. */
function arrayIndex(prop: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(prop)) return undefined;
  const n = Number(prop);
  return n <= 4294967294 ? n : undefined;
}

/** The names a binding pattern introduces. */
function collectNames(pattern: AnyNode, out: string[]): void {
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name as string);
      return;
    case "AssignmentPattern":
      collectNames(pattern.left as AnyNode, out);
      return;
    case "RestElement":
      collectNames(pattern.argument as AnyNode, out);
      return;
    case "ObjectPattern":
      for (const p of pattern.properties as AnyNode[]) collectNames((p.type === "RestElement" ? p.argument : p.value) as AnyNode, out);
      return;
    case "ArrayPattern":
      for (const el of pattern.elements as (AnyNode | null)[]) if (el !== null && el !== undefined) collectNames(el, out);
      return;
    default:
      return;
  }
}

/** The optional-chain short-circuit. Private to `evaluate`; see the `ChainExpression` case. */
const SHORT_CIRCUIT: unique symbol = Symbol("cotal-lang short circuit");

/**
 * What a `catch` block sees. A failure the RUNTIME raised (an effect's error, an interpreter fault)
 * arrives as a plain record carrying its code, because programs branch on data, not on classes; a
 * value the PROGRAM threw arrives as itself, whatever it is, exactly as JavaScript delivers it. A
 * program cannot construct an `Error`, so anything that is one came from the runtime or the host.
 */
function toProgramError(e: unknown): unknown {
  if (e instanceof EffectError) {
    return deepFreeze({ code: e.code, kind: e.kind, message: e.message, ...(e.detail !== undefined ? { detail: e.detail } : {}) });
  }
  if (e instanceof RuntimeFault) return deepFreeze({ code: e.code, kind: "runtime", message: e.message });
  if (e instanceof Error) return deepFreeze({ code: "L4000", kind: "host", message: e.message });
  return e;
}

// ---- the public entry point -------------------------------------------------------------------------

/**
 * Run a program.
 *
 * A run pins to the content hash of its SOURCE, which is why prompts, schemas, and model config
 * are covered: they are in the source. Passing an existing journal resumes rather than starts.
 */
export async function run(source: string, options: RunOptions): Promise<RunResult> {
  const { ast } = validate(source, options.file);
  const programHash = programHashOf(source);
  // A resume is handed the pins the run STARTED under and binds to them; a fresh run resolves them
  // once, here, and hands them back for the run record.
  //
  // AND A RESUME MAY NOT DECLINE TO SAY WHICH RUN IT IS RESUMING. Re-resolving the pins for a run
  // handed history but none is not a smaller version of the right behaviour: it is a different run
  // wearing the same journal. The clock moves to the RESUMING host and the seed falls back to the
  // runId default, so both the logical epoch and every pure draw change, and nothing refuses,
  // because nothing can. Pure draws are not journalled and the epoch is not a recorded fact, so
  // there is no divergence for the replay to catch.
  //
  // A journal with NO entries is a different thing and stays allowed: that is a FRESH run being
  // handed a journal for its store, not a resume.
  if (options.pins === undefined && options.journal !== undefined && options.journal.entries().length > 0) {
    throw new RuntimeFault(
      "L5021",
      `run ${options.runId} was handed a journal with ${options.journal.entries().length} recorded step(s) but no pins. The pins are what decide `
        + `the run's logical epoch and its seed, so resolving them again here would make this a different run against a journal that was not `
        + `written for it — silently, because neither the clock nor a pure draw is a recorded fact the replay could diverge on.\n\n`
        + `Options\n  pass the pins from the run record\n  start a fresh run instead of resuming this journal`,
    );
  }
  const pins =
    options.pins !== undefined
      ? bindPins(options.pins, options, WALKER_LANGUAGE_VERSION)
      : resolvePins(options, options.handler.now(), WALKER_LANGUAGE_VERSION);
  const interp = new Interpreter(ast as AnyNode, options, programHash, pins);

  // The run clock starts at the run's LOGICAL epoch, not at this host's clock: a run resumed on
  // another machine hours later must see the same `now()` before its first effect as the run that
  // wrote the journal, or the branch it takes is a property of when it was resumed.
  const frame = new Frame(new KeyScope(), new RunClock(pins.startedAt), new Signal());
  const env = new Env(null);
  installGlobals(env, interp);

  const completion = await interp.executeBlock(ast as AnyNode, env, frame);
  return {
    value: completion.type === "return" ? completion.value : undefined,
    journal: interp.journal,
    programHash,
    pins,
    steps: interp.stepCount,
  };
}

/** Re-run a program against an existing journal. Journalled effects return recorded results. */
export async function resume(
  source: string,
  journal: Journal,
  options: Omit<RunOptions, "journal">,
): Promise<RunResult> {
  journal.resetConsumed();
  return await run(source, { ...options, journal });
}

function installGlobals(env: Env, interp: Interpreter): void {
  const fn =
    (impl: (frame: Frame, args: unknown[]) => unknown) =>
    async (frame: Frame, args: unknown[]): Promise<unknown> =>
      impl(frame, args);

  // The value names. `undefined` is a value the runtime produces, so a program can name it.
  for (const name of VALUE_NAMES) env.declare(name, undefined, false);

  // Pure primitives and event constructors: ONE shared table (perform.ts), wrapped into the
  // walker's calling convention here. Handles are opaque frozen records the runtime mints
  // (design §4); event constructors are pure descriptors, and awaiting one is `wait`.
  for (const [name, impl] of freeConstructors({ runId: interp.options.runId, programHash: interp.programHash, startedAt: interp.pins.startedAt }))
    env.declare(name, fn((_f, a) => impl(a)), false);

  // The builtin library (design §4), one table in library.ts.
  for (const [name, value] of builtins(interp.libraryContext())) env.declare(name, value, false);
}

export { LangError, LangErrors };
