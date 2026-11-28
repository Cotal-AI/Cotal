import { RuntimeFault } from "./errors.js";
import { KeyScope, type PathKind } from "./keys.js";
import { Journal, RunClock } from "./journal.js";
import { crossedWrite, type WritingFrame } from "./values.js";
import type { EffectCeilings, RunPins } from "./pins.js";
import type { CancelSignal, RootCancellationSource, EffectHandler } from "./effects.js";

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
export const TDZ: unique symbol = Symbol("cotal-lang temporal dead zone");

export class Env {
  private readonly names = new Map<string, Binding>();

  /**
   * How many CONCURRENT scopes deep this environment was created.
   *
   * L2032's runtime half rests on this. The static rule follows named and inline branches, but a
   * branch the validator cannot resolve to a function node — one that arrives through a parameter
   * or a computed record — is not proven, and banning that shape outright would cost more than the
   * hazard. So the depth travels with the binding: a write from inside a concurrent branch to a
   * binding declared OUTSIDE it is refused where it happens. `once` and `conclave` raise it too,
   * though their single body has nothing to race, because a settled one is replayed without
   * entering its body.
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

  set(name: string, value: unknown, frame: WritingFrame): void {
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
    if (owner.depth < frame.depth) throw crossedWrite(frame, name);
    b.value = value;
  }
}

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

export type Completion =
  | { readonly type: "normal" }
  | { readonly type: "return"; readonly value: unknown }
  | { readonly type: "break" }
  | { readonly type: "continue" };

export const NORMAL: Completion = { type: "normal" };

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
export class Signal implements CancelSignal {
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
export class Frame {
  constructor(
    readonly keys: KeyScope,
    readonly clock: RunClock,
    readonly signal: Signal,
  ) {}

  /** How many CONCURRENT scopes deep. See {@link Env.depth}: this is L2032's runtime half. */
  get depth(): number {
    return this.keys.path.length;
  }

  branch(kind: PathKind, name: string | null, occurrence: number, branchKey: string): Frame {
    return new Frame(
      this.keys.branch(kind, name, occurrence, branchKey),
      this.clock.fork(),
      this.signal.child(),
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
  readonly ceilings?: EffectCeilings;
  /**
   * The HOST's stop, asked before every effect that has not already been recorded.
   *
   * Return a reason to stop the run where it stands, or `undefined` to carry on. The interpreter
   * turns the reason into an uncatchable host release.
   *
   * This exists because a driver's reasons to stop are not the program's business and must not be
   * recorded as its outcome: an absolute work horizon reached, a pause requested by an operator.
   * This check runs before the step starts. It does not interrupt a handler in flight.
   */
  readonly shouldStop?: () => string | undefined;
  /** Cooperative root cancellation, distinct from a next-boundary host release. */
  readonly cancellation?: RootCancellationSource;
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
