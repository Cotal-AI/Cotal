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
import { LangError, LangErrors } from "./errors.js";
import { KeyScope, digest, requestId, scopePathString, stepKeyString, type ScopeKind, type StepKey } from "./keys.js";
import { Journal, JournalAppendRejected, RunClock, type EntryError } from "./journal.js";
import { Prng, assertCrossable, deepFreeze } from "./values.js";
import { parseDuration } from "./duration.js";
import { PRIMITIVES, type EffectKind } from "./primitives.js";
import { notifyFactViolation } from "./notify-fact.js";
import { bindPins, resolvePins, type RunPins } from "./pins.js";
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
 * What a concurrency scope produces, before it is journalled.
 *
 * `branches` is what the scope launched, `value` is what the program sees, and `cancel` is the
 * intent a cancelling scope owes its losers — durable WITH the outcome, because a process dies
 * between instructions and two appends are two network operations however few keywords separate
 * them.
 */
interface ScopeOutcome {
  readonly branches: readonly string[];
  readonly value: unknown;
  readonly cancel?: { readonly losers: readonly string[]; readonly issued: boolean };
  /** A `conclave`'s membership disposition. See {@link JournalEntry.closed}. */
  readonly closed?: boolean;
}

/**
 * A `conclave` whose close did not acknowledge.
 *
 * It exists so the scope is NOT settled: the pending entry is the durable record that a close is
 * still owed, and re-entry retries it. Settling on a close rejection would have the journal state a
 * disposition the world never confirmed, which is the one thing this entry is for.
 */
class CloseOwed extends Error {
  constructor(readonly reason: unknown) {
    super(`conclave close did not acknowledge: ${(reason as Error)?.message ?? String(reason)}`);
    this.name = "CloseOwed";
  }
}

// ---- environments ------------------------------------------------------------------------------

class Binding {
  constructor(
    public value: unknown,
    readonly mutable: boolean,
  ) {}
}

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
    return b.value;
  }

  has(name: string): boolean {
    return this.find(name) !== undefined;
  }

  set(name: string, value: unknown, atDepth: number): void {
    const owner = this.owner(name);
    if (owner === undefined) throw new RuntimeFault("L2001", `${name} is not defined`);
    const b = owner.names.get(name) as Binding;
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

/** What the interpreter knows about a failing scope, beside whatever the program threw. */
interface ScopeFacts {
  readonly cancel?: { readonly losers: readonly string[]; readonly issued: boolean };
  readonly closed?: boolean;
}

/**
 * A scope's failure, carrying the interpreter's OWN facts about it.
 *
 * These facts used to be attached to the thrown value with `Object.assign`, which works exactly as
 * long as every program throws an object. `throw null` is valid (§3.2), and `Object.assign(null, …)`
 * is a TypeError — so a conclave whose body threw a primitive lost its closure fact AND handed the
 * caller a manufactured type error in place of the body's failure, while the entry recorded
 * `closed: undefined` for a room the handler had in fact closed. The facts belong to the
 * interpreter, so they travel in the interpreter's own envelope and the program's value rides
 * untouched inside it. Nothing outside `performScope` ever sees this class: it unwraps before it
 * rethrows.
 */
class ScopeFailed extends Error {
  constructor(
    readonly reason: unknown,
    readonly facts: ScopeFacts,
  ) {
    super(`scope failed: ${messageOf(reason)}`);
    this.name = "ScopeFailed";
  }
}

function unwrapScope(e: unknown): { reason: unknown; facts: ScopeFacts } {
  return e instanceof ScopeFailed ? { reason: e.reason, facts: e.facts } : { reason: e, facts: {} };
}

/**
 * The message of an arbitrary thrown value.
 *
 * Reading `.message` off `null` throws, and a thrown primitive is legal in a language with `throw`,
 * so every place that has to describe a failure it did not construct goes through here. A recorded
 * entry saying "Cannot read properties of null" describes the recorder, not the run.
 */
function messageOf(v: unknown): string {
  if (v instanceof Error) return v.message;
  const m = (v as { message?: unknown } | null | undefined)?.message;
  return typeof m === "string" ? m : String(v);
}

/** A fault the interpreter itself raises, as opposed to one an effect handler reported. */
export class RuntimeFault extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code} ${message}`);
    this.name = "RuntimeFault";
  }
}

// ---- statement completion ------------------------------------------------------------------------

type Completion =
  | { readonly type: "normal" }
  | { readonly type: "return"; readonly value: unknown }
  | { readonly type: "break" }
  | { readonly type: "continue" };

const NORMAL: Completion = { type: "normal" };

// ---- per-branch execution state ---------------------------------------------------------------------

class Signal implements CancelSignal {
  cancelled = false;
  reason?: string;
  private readonly listeners: ((reason: string) => void)[] = [];

  onCancel(fn: (reason: string) => void): void {
    this.listeners.push(fn);
  }

  cancel(reason: string): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.reason = reason;
    for (const l of this.listeners) l(reason);
  }

  child(): Signal {
    const s = new Signal();
    if (this.cancelled) s.cancel(this.reason ?? "parent cancelled");
    else this.onCancel((r) => s.cancel(r));
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

/** A recorded step's inputs changed, so its recorded result may no longer be the truth. */
export class RunDivergence extends Error {
  constructor(
    readonly stepKey: string,
    readonly recordedHash: string,
    readonly programHash: string,
  ) {
    super(
      `L5001 Run divergence\n\n  step  ${stepKey}   INPUT CHANGED\n        recorded  ${recordedHash}\n        program   ${programHash}\n\nThe recorded result was produced from different inputs, so replaying it would hand the program an answer to a question it is no longer asking.\n\nOptions\n  fork(run, "${stepKey}")   re-run from this step, keeping everything before it\n  revert the inputs         keep the recorded result`,
    );
    this.name = "RunDivergence";
  }
}

class Interpreter {
  readonly journal: Journal;
  readonly prng: Prng;
  private effectCount = 0;
  private readonly ceiling: number;
  private steps = 0;
  private nextYield: number;
  private readonly stepBudget: number;
  private readonly yieldEvery: number;

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
    this.prng = new Prng(pins.seed);
    this.ceiling = pins.effectCeiling;
    this.stepBudget = pins.stepBudget;
    this.yieldEvery = pins.yieldEvery;
    this.nextYield = this.yieldEvery;
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
        `this run has taken more than ${this.stepBudget} interpreter steps without finishing, which means a loop that performs no effect is not terminating. The effect ceiling cannot see such a loop, because it performs nothing to count. Add an exit condition, or raise stepBudget if the program legitimately does this much work.`,
      );
    }
    if (this.steps < this.nextYield) return null;
    this.nextYield = this.steps + this.yieldEvery;
    return this.breathe(frame);
  }

  /**
   * Hand the macrotask queue back, then notice if this branch was cancelled while we were away.
   *
   * The cancellation check is deliberately HERE and not on every dispatch. Cancellation is
   * otherwise observed only at effect boundaries (see {@link Interpreter.performEffect}), so a race
   * loser that spins without performing an effect never learns it lost and spins forever. Checking
   * at the yield boundary reaches exactly that case and no other: a branch that runs fewer than
   * `yieldEvery` dispatches between two effects never crosses this line, so the cancellation law
   * for ordinary programs is unchanged.
   */
  get stepCount(): number {
    return this.steps;
  }

  private async breathe(frame: Frame): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    if (frame.signal.cancelled) throw new Cancelled(frame.signal.reason ?? "cancelled");
  }

  // ---- the effect seam ------------------------------------------------------------------------

  /**
   * Perform one effect, or replay it.
   *
   * Everything durable happens here. A handler is called only in the `miss` and `pending` cases,
   * and in `pending` it is told to re-bind rather than re-issue.
   */
  async performEffect(
    kind: EffectKind,
    name: string,
    hashedInput: unknown,
    perform: (ctx: EffectContext, inputHash: string) => Promise<unknown>,
    frame: Frame,
  ): Promise<unknown> {
    const key = frame.keys.nextEffect(kind, name);
    const inputHash = digest(hashedInput ?? null);
    const verdict = this.journal.lookup(key, inputHash);

    switch (verdict.verdict) {
      case "replay":
        if (verdict.entry.endedAt !== undefined) frame.clock.advance(verdict.entry.endedAt);
        return verdict.entry.result;
      case "replay-failed": {
        if (verdict.entry.endedAt !== undefined) frame.clock.advance(verdict.entry.endedAt);
        const e = verdict.entry.error as EntryError;
        throw new EffectError(e.code, e.kind, e.message, e.detail);
      }
      case "replay-cancelled":
        throw new Cancelled("this branch was cancelled on the recorded run");
      case "diverged":
        throw new RunDivergence(stepKeyString(key), verdict.recordedHash, verdict.programHash);
      case "pending":
      case "miss":
        break;
    }

    // A cancelled branch performs no NEW effects. That is the whole of the cancellation law on
    // this side: work already in flight is another matter, and the handler owns it.
    if (frame.signal.cancelled) {
      throw new Cancelled(frame.signal.reason ?? "cancelled");
    }

    // THE HOST'S STOP, asked before anything is begun and after every replay has been served. A
    // driver holds its run under an absolute work horizon and may be asked to hand it back, and
    // neither is a fact about the program — so the place to stop is here, where no entry has been
    // written and no handler dispatched. One step later would mean a pending entry for work nobody
    // performed; inside the handler would mean settling a failure for work that really happened.
    // Replays above are deliberately unaffected: replaying a recorded prefix performs nothing, and
    // a run that stopped mid-journal has to be able to walk back to where it stopped.
    const stop = this.options.shouldStop?.();
    if (stop !== undefined) {
      throw new RunReleased(stop);
    }

    this.effectCount += 1;
    if (this.effectCount > this.ceiling) {
      throw new RuntimeFault(
        "L4009",
        `this run has performed more than ${this.ceiling} effects, which means a loop is not terminating. Add an exit condition or a permit.`,
      );
    }

    const resume = verdict.verdict === "pending" ? verdict.entry.external : undefined;
    // RECOVERY SUBMITS UNDER THE RECORDED IDENTITY. Re-deriving happens to agree whenever nothing
    // moved, which is exactly why it read as correct: the whole point of writing the id down is
    // the case where it does NOT agree, and a resumed run that re-derives is reissuing under an
    // identity the far side may never have seen. An entry with no recorded id predates this rule.
    const recorded = verdict.verdict === "pending" && verdict.entry.requestId !== undefined ? verdict.entry : undefined;
    const reqId = recorded?.requestId ?? requestId(this.options.runId, key, inputHash);
    // WHICH attempt is open, not merely which id. An id alone cannot say how much of an escalation
    // chain is already spent, and a recovery that cannot tell replays the hop: it mints again under
    // the id the far side already holds and reads that mint's cached expiry back as a fresh
    // observation. An entry written before the index existed reads as attempt 0, which is what it
    // is for every effect that never hops.
    const attempt = recorded?.attempt ?? 0;
    if (verdict.verdict === "miss") {
      // AWAITED, and the await is the point: the request id the handler is about to submit under
      // has to be durable BEFORE the work is issued, or a crash in the gap leaves real work that
      // nothing in the journal names.
      await this.journal.begin(key, inputHash, this.options.handler.now(), reqId);
    }

    const ctx: EffectContext = {
      key,
      signal: frame.signal,
      // Derived from the run, the step, the inputs and the attempt, and written on the pending
      // entry by `begin` above BEFORE the handler runs. A handler submits under it idempotently,
      // so a resumed run reissues the same id rather than creating a second goal.
      requestId: reqId,
      attempt,
      ...(resume !== undefined ? { resume } : {}),
      bind: async (external) => {
        await this.journal.bind(key, external);
      },
    };

    // TWO FAILURE DOMAINS, AND THE TERMINAL APPEND IS NOT IN THE HANDLER'S.
    //
    // This was one `try` around both the dispatch and the settle, and the bug it produced is the
    // worst kind a journal can have: the handler completed, the store refused the settling append,
    // the catch below recorded that refusal as a handler fault, and the durable sequence became
    // `[pending, settled:failed]` for work the world had actually done. Every later replay then
    // reported failure for a real success. So the handler's outcome is decided first, alone, and
    // the append that records it happens outside — where a rejection is a durability failure that
    // travels as itself and settles nothing.
    let result: unknown;
    try {
      result = await perform(ctx, inputHash);
      assertCrossable(result, `the result of ${stepKeyString(key)}`);
    } catch (e) {
      const endedAt = this.options.handler.now();
      // A journal that just refused an append cannot be asked to record why. It leaves by its own
      // door, unwrapped, before anything tries to settle on top of it.
      if (e instanceof JournalAppendRejected) throw e;
      if (e instanceof Cancelled) {
        await this.journal.settle(key, { status: "cancelled" }, endedAt);
        throw e;
      }
      // A handler may raise a language code directly, and it survives. The simulator's "unscripted
      // effect" is L6001, and flattening that to a generic handler fault would tell a caller acting
      // on `code` that the handler broke, when what actually happened is that their script is
      // incomplete. Only the L-code shape is honoured: anything else a thrown object happens to
      // call `code` (an errno, an HTTP status) is a handler fault and is recorded as one.
      // Read defensively: a handler is other people's code and may throw a primitive, and reading
      // `.code` or `.message` off `null` would replace its failure with the recorder's own.
      const raised = (e as { code?: unknown } | null | undefined)?.code;
      const carried = typeof raised === "string" && /^L\d{4}$/.test(raised) ? raised : null;
      const error: EntryError =
        e instanceof EffectError
          ? { code: e.code, kind: e.kind, message: e.message, ...(e.detail !== undefined ? { detail: e.detail } : {}) }
          : { code: carried ?? "L4000", kind: "handler-fault", message: messageOf(e) };
      await this.journal.settle(key, { status: "failed", error }, endedAt);
      frame.clock.advance(endedAt);
      throw e instanceof EffectError ? e : new EffectError(error.code, error.kind, error.message);
    }

    const endedAt = this.options.handler.now();
    await this.journal.settle(key, { status: "ok", result: deepFreeze(result) }, endedAt);
    frame.clock.advance(endedAt);
    return result;
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
          if (i < exprs.length) out += String(await this.evaluate(exprs[i] as AnyNode, env, frame));
        }
        return out;
      }
      case "ArrayExpression": {
        const out: unknown[] = [];
        for (const el of (node.elements as AnyNode[]) ?? []) {
          if (el.type === "SpreadElement") {
            const spread = await this.evaluate(el.argument as AnyNode, env, frame);
            out.push(...(spread as unknown[]));
          } else {
            out.push(await this.evaluate(el, env, frame));
          }
        }
        return out;
      }
      case "ObjectExpression": {
        const out: Record<string, unknown> = {};
        for (const p of (node.properties as AnyNode[]) ?? []) {
          if (p.type === "SpreadElement") {
            Object.assign(out, await this.evaluate(p.argument as AnyNode, env, frame));
            continue;
          }
          const key = p.key as AnyNode;
          const name = key.type === "Identifier" ? (key.name as string) : String(key.value);
          out[name] = await this.evaluate(p.value as AnyNode, env, frame);
        }
        return out;
      }
      case "MemberExpression": {
        const obj = await this.evaluate(node.object as AnyNode, env, frame);
        if (obj === null || obj === undefined) {
          if (node.optional === true) return undefined;
          throw new RuntimeFault("L4010", `cannot read a field of ${String(obj)}`);
        }
        const prop = node.computed === true
          ? String(await this.evaluate(node.property as AnyNode, env, frame))
          : ((node.property as AnyNode).name as string);
        return (obj as Record<string, unknown>)[prop];
      }
      case "UnaryExpression": {
        const v = await this.evaluate(node.argument as AnyNode, env, frame);
        switch (node.operator) {
          case "!":
            return !v;
          case "-":
            return -(v as number);
          case "+":
            return +(v as number);
          case "typeof":
            return typeof v;
          default:
            throw new RuntimeFault("L1000", `unsupported unary operator ${String(node.operator)}`);
        }
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
      case "AssignmentExpression": {
        const value = await this.evaluate(node.right as AnyNode, env, frame);
        const left = node.left as AnyNode;
        if (left.type !== "Identifier") {
          throw new RuntimeFault("L2031", "only a plain binding can be assigned to");
        }
        env.set(left.name as string, value, frame.depth);
        return value;
      }
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

  makeFunction(node: AnyNode, closure: Env): (frame: Frame, args: unknown[]) => Promise<unknown> {
    const params = (node.params as AnyNode[]) ?? [];
    const body = node.body as AnyNode;
    const isExpressionBody = body.type !== "BlockStatement";
    return async (frame: Frame, args: unknown[]): Promise<unknown> => {
      // The calling FRAME decides the depth, not the closure: a helper declared at the top level
      // and called from inside a branch is executing concurrently, whatever scope it was written in.
      const env = new Env(closure, frame.depth);
      for (let i = 0; i < params.length; i += 1) {
        await this.bindPattern(params[i] as AnyNode, args[i], env, frame, true);
      }
      if (isExpressionBody) return await this.evaluate(body, env, frame);
      const c = await this.executeBlock(body, env, frame);
      return c.type === "return" ? c.value : undefined;
    };
  }

  async bindPattern(
    pattern: AnyNode,
    value: unknown,
    env: Env,
    frame: Frame,
    mutable: boolean,
  ): Promise<void> {
    switch (pattern.type) {
      case "Identifier":
        env.declare(pattern.name as string, value, mutable);
        return;
      case "AssignmentPattern":
        await this.bindPattern(
          pattern.left as AnyNode,
          value === undefined ? await this.evaluate(pattern.right as AnyNode, env, frame) : value,
          env,
          frame,
          mutable,
        );
        return;
      case "ObjectPattern": {
        const src = (value ?? {}) as Record<string, unknown>;
        const taken: string[] = [];
        for (const p of pattern.properties as AnyNode[]) {
          if (p.type === "RestElement") {
            const rest: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(src)) if (!taken.includes(k)) rest[k] = v;
            await this.bindPattern(p.argument as AnyNode, rest, env, frame, mutable);
            continue;
          }
          const key = p.key as AnyNode;
          const name = key.type === "Identifier" ? (key.name as string) : String(key.value);
          taken.push(name);
          await this.bindPattern(p.value as AnyNode, src[name], env, frame, mutable);
        }
        return;
      }
      case "ArrayPattern": {
        const src = (value ?? []) as unknown[];
        const els = pattern.elements as (AnyNode | null)[];
        for (let i = 0; i < els.length; i += 1) {
          const el = els[i];
          if (el === null || el === undefined) continue;
          if (el.type === "RestElement") {
            await this.bindPattern(el.argument as AnyNode, src.slice(i), env, frame, mutable);
            break;
          }
          await this.bindPattern(el, src[i], env, frame, mutable);
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

    const fn = await this.evaluate(callee, env, frame);
    const args: unknown[] = [];
    for (const a of argNodes) {
      if (a.type === "SpreadElement") args.push(...((await this.evaluate(a.argument as AnyNode, env, frame)) as unknown[]));
      else args.push(await this.evaluate(a, env, frame));
    }
    if (typeof fn !== "function") {
      throw new RuntimeFault("L4011", `this value is not a function, so it cannot be called`);
    }
    return await (fn as (frame: Frame, args: unknown[]) => Promise<unknown>)(frame, args);
  }

  private option(bag: unknown, key: string): unknown {
    return bag === null || typeof bag !== "object" ? undefined : (bag as Record<string, unknown>)[key];
  }

  async callPrimitive(name: string, argNodes: AnyNode[], env: Env, frame: Frame): Promise<unknown> {
    const spec = PRIMITIVES[name];
    if (spec === undefined) throw new RuntimeFault("L2001", `${name} is not a primitive`);

    // Concurrency combinators take their branches unevaluated: the thunks must run inside their
    // own frames, so evaluating them here would defeat the whole point.
    if (spec.opensScope) return await this.callScope(name, argNodes, env, frame);

    const args: unknown[] = [];
    for (const a of argNodes) args.push(await this.evaluate(a, env, frame));
    const bag = args[spec.optionsAt];
    const stepName = (name === "checkpoint" ? args[0] : this.option(bag, "name")) as string | undefined;
    const handler = this.options.handler;

    switch (name) {
      case "spawn": {
        // The first argument is a persona name, or a record carrying the persona WITH its model
        // and variant. Only the persona was ever read, so the object form silently dropped model
        // and variant from both the request and the hash: editing a model did not diverge, and the
        // handler was never told which model to run. This was missed by an audit that exercised
        // only the string form, which is the same defect one level up.
        const spawnSubject = args[0];
        const persona =
          typeof spawnSubject === "string" ? spawnSubject : String(this.option(spawnSubject, "persona"));
        const model = typeof spawnSubject === "string" ? undefined : (this.option(spawnSubject, "model") as string | undefined);
        const variant = typeof spawnSubject === "string" ? undefined : (this.option(spawnSubject, "variant") as string | undefined);
        // Every accepted option is forwarded, including the three that are policy rather than
        // identity. Dropping them here would be silent: the validator accepts `permits`, so an
        // author who writes a budget gets no error and no budget. They are deliberately absent
        // from `hashedOptions` (§5.12) because they decide the INTERPRETATION of a result, not the
        // recorded fact, so they are reapplied from current source on resume rather than hashed.
        const req = {
          persona,
          ...(model !== undefined ? { model } : {}),
          ...(variant !== undefined ? { variant } : {}),
          ...(this.option(bag, "worktree") !== undefined ? { worktree: this.option(bag, "worktree") as string } : {}),
          ...(this.option(bag, "role") !== undefined ? { role: this.option(bag, "role") as string } : {}),
          ...(this.option(bag, "join") !== undefined ? { join: this.option(bag, "join") as ChannelHandleValue[] } : {}),
          ...(this.option(bag, "permits") !== undefined
            ? { permits: this.option(bag, "permits") as Record<string, unknown> }
            : {}),
          ...(this.option(bag, "supervise") !== undefined
            ? { supervise: this.option(bag, "supervise") as Record<string, unknown> }
            : {}),
          ...(this.option(bag, "onFork") !== undefined ? { onFork: this.option(bag, "onFork") as "respawn" | "adopt" } : {}),
        };
        return await this.performEffect(
          "spawn",
          stepName ?? persona,
          // Model and variant are part of the IDENTITY being spawned, so they are hashed with the
          // persona (design 5.12). A run that swapped the model under a recorded agent would be
          // replaying a fact about a different agent.
          {
            persona,
            model: model ?? null,
            variant: variant ?? null,
            worktree: req.worktree ?? null,
            role: req.role ?? null,
            join: (req.join ?? []).map((c) => c.channel),
          },
          (ctx) => handler.spawn(req, ctx),
          frame,
        );
      }
      case "turn": {
        const agent = deepFreeze(args[0]) as AgentHandleValue;
        // The deadline STOPS OBSERVATION (design 5.12), so it belongs in the projection: a turn
        // recorded under a 1m deadline cannot answer what a 10m turn would have produced, and a
        // resumed run under the edited deadline replaying the old result is the silent-wrong-path
        // class. Closing that for `checkpoint` and leaving it open on the siblings closed nothing.
        const deadline = this.option(bag, "deadline") as string | undefined;
        return await this.performEffect(
          "turn",
          stepName as string,
          { agent: agent.agent, deadline: deadline ?? null },
          (ctx) => handler.turn({ agent, ...(deadline !== undefined ? { deadline } : {}) }, ctx),
          frame,
        );
      }
      case "ask": {
        const agent = deepFreeze(args[0]) as AgentHandleValue;
        const schema = this.option(bag, "schema");
        // Both of these END THE ASKING: `deadline` is the cutoff and `attempts` is how many
        // schema-failed replies are tolerated before it gives up. A record made under one attempt
        // is not an answer to what five attempts would have produced.
        const deadline = this.option(bag, "deadline") as string | undefined;
        const attempts = this.option(bag, "attempts") as number | undefined;
        return await this.performEffect(
          "ask",
          stepName as string,
          { agent: agent.agent, schema: schema ?? null, deadline: deadline ?? null, attempts: attempts ?? null },
          (ctx) =>
            handler.ask(
              {
                agent,
                schema,
                ...(deadline !== undefined ? { deadline } : {}),
                ...(attempts !== undefined ? { attempts } : {}),
              },
              ctx,
            ),
          frame,
        );
      }
      case "checkpoint": {
        const prompt = args[1] as string;
        // The disposition is computed from TODAY's source, after the journal is consulted, on the
        // live path and the replay path alike. performEffect returns the RAW outcome, which is
        // what the journal holds; the policy sandwich closes here so a resumed run under an edited
        // onExpiry throws even though nothing about the recorded expiry changed.
        const onExpiry = this.option(bag, "onExpiry") as "fail" | "proceed" | "escalate" | undefined;
        const schema = this.option(bag, "schema");
        // The SAME projection the entry is keyed by, so an attempt's identity is a function of the
        // step it belongs to rather than of anything the escalation invents.
        // Design 5.12, and every field here earns its place. `timeout` STOPS OBSERVATION, so a
        // record made under 1m cannot answer what a 3m wait would have seen. `escalate` and its
        // `to` CREATE AN EFFECT rather than choosing a disposition, so editing them must diverge
        // rather than be reapplied. `fail` versus `proceed` is the one genuine reapply and stays
        // out. Hashing only prompt and schema left a timeout edit replaying clean, which is the
        // silent-wrong-path class this projection exists to close.
        const cpTimeout = this.option(bag, "timeout") as string | undefined;
        const cpTo = this.option(bag, "to") as string | undefined;
        const cpInput = {
          prompt,
          schema: schema ?? null,
          timeout: cpTimeout ?? null,
          ...(onExpiry === "escalate" ? { onExpiry, to: cpTo ?? null } : {}),
        };
        return applyCheckpointPolicy(
          (await this.performEffect(
          "checkpoint",
          stepName as string,
          cpInput,
          async (ctx, inputHash) => {
            // ONE hash value, threaded from what the entry is actually keyed by rather than
            // re-digested from the projection here. The two agreed, which is exactly the problem:
            // a second derivation that happens to match is a coincidence maintained by hand, and
            // the first edit to the projection would desync attempt 1's identity from its own
            // step with no type error and no failing test.
            const attemptId = (n: number) => requestId(this.options.runId, ctx.key, inputHash, n);
            const req = {
              prompt,
              ...(schema !== undefined ? { schema } : {}),
              ...(cpTimeout !== undefined ? { timeout: cpTimeout } : {}),
              ...(onExpiry !== undefined ? { onExpiry } : {}),
              ...(cpTo !== undefined ? { to: cpTo } : {}),
            };
            // THE FINAL MINT DOES NOT ASK FOR AN ESCALATION. The interpreter owns the one-hop stop
            // rule, and it can only own it if the far side is not simultaneously told to hop: a
            // handler that honours `onExpiry` on the wire would mint a third attempt under an
            // identity this journal never allocated, and nothing here would ever learn of it.
            const finalReq = onExpiry === "escalate" ? { ...req, onExpiry: "proceed" as const } : req;

            // RECOVERY COMPLETES THE OPEN ATTEMPT. IT DOES NOT REPLAY THE CHAIN.
            //
            // Arriving here with a non-zero attempt means the hop was issued before the crash, so
            // the far side is already holding work under this very id. Re-running the live body
            // from the top would call the handler again under it and take that call's cached
            // expiry for a second observation: the stop rule would be satisfied on paper while the
            // run had in fact observed one attempt twice. The chain's shape is recoverable without
            // re-running it, because attempt 0's identity is derivable and its outcome is implied:
            // the only path that opens attempt 1 is attempt 0 expiring.
            if (ctx.attempt > 0) {
              const raw = await handler.checkpoint(finalReq, ctx);
              return {
                ...raw,
                attempts: [
                  { attempt: 0, requestId: attemptId(0), settled: "expired" },
                  { attempt: ctx.attempt, requestId: ctx.requestId, to: cpTo ?? null, settled: raw.outcome },
                ],
              };
            }

            const first = await handler.checkpoint(req, ctx);
            if (first.outcome !== "expired" || onExpiry !== "escalate") {
              // `ctx.attempt`, not a literal 0. Writing the literal made every recovery relabel the
              // open attempt as the first one, which erased the hop from the journal and left the
              // record claiming the escalated mint was the original.
              return { ...first, attempts: [{ attempt: ctx.attempt, requestId: ctx.requestId, settled: first.outcome }] };
            }
            // ESCALATION STAYS INSIDE THIS ENTRY. The program made one call, and the interpreter
            // owns key allocation, so a second mint must not become a second occurrence. What it
            // does need is a second IDENTITY, derived from attempt 1 before the mint happens, or a
            // crash between minting and recording leaves live work nothing in the journal names.
            //
            // Name the open attempt on the pending row BEFORE issuing it, index and all.
            const nextId = attemptId(1);
            await this.journal.reissueAs(ctx.key, nextId, 1);
            const second = await handler.checkpoint(finalReq, { ...ctx, requestId: nextId, attempt: 1 });
            // ONE HOP. An escalation that can escalate again never terminates, so a second expiry
            // settles as expired and the program decides, exactly as `proceed` would.
            return {
              ...second,
              attempts: [
                { attempt: 0, requestId: ctx.requestId, settled: "expired" },
                { attempt: 1, requestId: nextId, to: cpTo ?? null, settled: second.outcome },
              ],
            };
          },
          frame,
          )) as CheckpointRaw,
          onExpiry,
        );
      }
      case "sleep": {
        const duration = args[0] as string;
        parseDuration(duration); // fail at the call, not inside the handler
        // The duration IS hashed (design 5.12). It determines the recorded fact: a resumed run
        // reads the elapsed time back through the run clock, so editing 1h to 1m must diverge
        // rather than silently keep the path the old duration chose. This hashed `null` until
        // critic2 executed it, and the rule it violates is one this lane wrote and then only
        // ever applied to the document.
        return await this.performEffect(
          "sleep",
          stepName ?? "",
          { duration },
          (ctx) => handler.sleep({ duration }, ctx),
          frame,
        );
      }
      case "wait": {
        const event = deepFreeze(args[0]) as EventDescriptor;
        const timeout = this.option(bag, "timeout") as string | undefined;
        // A `wait` that resolved null did not observe "the event never happens": it observed "the
        // event did not happen WITHIN THIS TIMEOUT". Editing the timeout therefore asks a different
        // question, and replaying the recorded null answers the old one. This is the same hole the
        // checkpoint projection closed, and leaving it open here left `?? recovery` steering off a
        // stale cutoff.
        return await this.performEffect(
          "wait",
          stepName ?? "",
          { event, timeout: timeout ?? null },
          (ctx) => handler.wait({ event, ...(timeout !== undefined ? { timeout } : {}) }, ctx),
          frame,
        );
      }
      case "notify": {
        const agents = deepFreeze(args[0]) as AgentHandleValue[];
        const fact = deepFreeze(args[1]) as { decision: string; outcome: string };
        // THE BOUND, WHERE THE VALUE EXISTS. The validator checks a literal fact exactly and says
        // so about the computed one; this is the computed one. It is checked BEFORE the entry is
        // written, so a fact that breaks the bound never reaches a journal, a record, or a
        // handler — an out-of-bound notice recorded as performed would be laundered bytes with a
        // durable receipt. An error, never a truncation: a shortened notice still delivers.
        const violation = notifyFactViolation(fact);
        if (violation !== null) throw new RuntimeFault("L3043", violation);
        return await this.performEffect(
          "notify",
          stepName ?? "",
          { agents: agents.map((a) => a.agent), fact },
          (ctx) => handler.notify({ agents, fact }, ctx),
          frame,
        );
      }
      case "monitor": {
        const agent = deepFreeze(args[0]) as AgentHandleValue;
        return await this.performEffect(
          "monitor",
          stepName ?? "",
          { agent: agent.agent },
          (ctx) => handler.monitor({ agent }, ctx),
          frame,
        );
      }
      default:
        throw new RuntimeFault("L1000", `${name} is not implemented in this interpreter`);
    }
  }

  /**
   * The concurrency combinators.
   *
   * Each pushes a scope frame whose occurrence is allocated HERE, synchronously, in code that is
   * already deterministic. Each branch then gets its own key namespace, so two branches running
   * the same named effect cannot race for a counter, and replay reproduces both regardless of
   * which one finished first.
   */
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

    // `conclave` is the one scope whose identity includes a SUBJECT (`hashesSubject`, §5.8): the
    // members are what the sub-team IS, so editing the member list has to diverge rather than
    // resume into a different room. The other three are identified by kind, name and occurrence.
    const subject = spec.hashesSubject
      ? {
          members: (first as AgentHandleValue[]).map((m) => m.agent),
          channel: (this.option(bag, "channel") as string | undefined) ?? null,
        }
      : undefined;

    return await this.performScope(scopeKey, frame, async (ctx) => await this.runScope(
      name, scopeKind, scopeName, occurrence, first, argNodes, bag, env, frame, ctx,
    ), subject);
  }

  /**
   * A concurrency scope's own journal entry, and what replay does with it.
   *
   * The scope is journalled as ONE durable record carrying its outcome, and for a cancelling scope
   * the intent to cancel its siblings. Without it a replayed `race` re-races: both branches may have
   * settled before the cancellation reached the loser, so the journal holds two successful branches
   * and nothing saying which one won, and a replayed run can take the other path and reach a step
   * that was never recorded.
   *
   * A settled scope therefore ENTERS NO BRANCH, and the order below is normative rather than
   * convenient: account for the subtree first, then discharge the cancellation, and only then
   * deliver the outcome. Leading with the delivery is the defect — the next program step can share
   * a worktree with a loser that is still writing.
   */
  private async performScope(
    scopeKey: StepKey,
    frame: Frame,
    body: (ctx: EffectContext) => Promise<ScopeOutcome>,
    subject?: unknown,
  ): Promise<unknown> {
    const inputHash = digest(
      subject === undefined
        ? { kind: scopeKey.kind, name: scopeKey.name }
        : { kind: scopeKey.kind, name: scopeKey.name, subject },
    );
    const verdict = this.journal.lookup(scopeKey, inputHash);

    if (verdict.verdict === "diverged") {
      throw new RunDivergence(stepKeyString(scopeKey), verdict.recordedHash, verdict.programHash);
    }
    if (verdict.verdict === "replay" || verdict.verdict === "replay-failed") {
      const entry = verdict.entry;
      // (1) account for the subtree, settling any loser still pending as cancelled;
      await this.journal.consumeScope(stepKeyString(scopeKey), entry.endedAt ?? this.options.handler.now());
      // (2) the cancellation intent is the driver's to discharge against the world; a journal write
      //     cancels nothing by itself, so an undischarged intent stays visible rather than silently
      //     reading as done.
      // (3) only now, the outcome.
      if (entry.endedAt !== undefined) frame.clock.advance(entry.endedAt);
      if (verdict.verdict === "replay-failed") {
        const e = entry.error as EntryError;
        throw new EffectError(e.code, e.kind, e.message, e.detail);
      }
      return (entry.result as { value: unknown }).value;
    }
    if (verdict.verdict === "replay-cancelled") {
      throw new Cancelled("this scope was cancelled on the recorded run");
    }

    // `miss` and `pending` alike RE-ENTER the scope: there is no recorded outcome to return, and a
    // pending scope's losers were never durably cancelled. Settling is idempotent, so the arm that
    // finishes first wins again — except where the journal already knows better, which is what
    // `runScope`'s replayed-branch tie-break is for.
    // A scope that CALLS THE HANDLER owes a durable request id exactly as an effect does, and for
    // the same reason: a crash between issuing the work and recording who issued it leaves real
    // work — for `conclave`, a live channel with members joined — that nothing in the journal
    // names. `subject` marks that scope, because `conclave` is the only one that dispatches from
    // this path; the other three launch thunks and touch no handler of their own.
    const dispatches = subject !== undefined;
    const resume = verdict.verdict === "pending" ? verdict.entry.external : undefined;
    const recorded = verdict.verdict === "pending" && verdict.entry.requestId !== undefined ? verdict.entry : undefined;
    const reqId = recorded?.requestId ?? requestId(this.options.runId, scopeKey, inputHash);
    if (verdict.verdict === "miss") {
      await this.journal.begin(scopeKey, inputHash, this.options.handler.now(), dispatches ? reqId : undefined);
    }
    const ctx: EffectContext = {
      key: scopeKey,
      signal: frame.signal,
      requestId: reqId,
      attempt: recorded?.attempt ?? 0,
      ...(resume !== undefined ? { resume } : {}),
      bind: async (external) => {
        await this.journal.bind(scopeKey, external);
      },
    };
    // The same two domains as {@link Interpreter.performEffect}, for the same reason: a scope whose
    // branches all succeeded and whose settling append was refused must not be recorded as failed.
    let outcome: ScopeOutcome;
    try {
      outcome = await body(ctx);
    } catch (raw) {
      // The interpreter's facts come out of the envelope; the program's thrown value comes out
      // whole, and is what the caller sees. A value the program threw is never written on.
      const { reason, facts } = unwrapScope(raw);
      const endedAt = this.options.handler.now();
      if (reason instanceof JournalAppendRejected) throw reason;
      // A close that did not acknowledge settles NOTHING. The entry stays pending, which is exactly
      // what "a close is still owed" looks like in a journal, and the underlying handler error is
      // what the caller sees.
      if (reason instanceof CloseOwed) throw reason.reason;
      if (reason instanceof Cancelled) {
        await this.journal.settle(scopeKey, { status: "cancelled" }, endedAt, facts);
        throw reason;
      }
      const err: EntryError =
        reason instanceof EffectError
          ? {
              code: reason.code,
              kind: reason.kind,
              message: reason.message,
              ...(reason.detail !== undefined ? { detail: reason.detail } : {}),
            }
          : { code: "L4000", kind: "scope-fault", message: messageOf(reason) };
      // A rejecting branch cancels its siblings and can crash before they hear it, so a FAILED scope
      // carries the intent too — and a conclave that closed says so even when its body failed.
      await this.journal.settle(scopeKey, { status: "failed", error: err }, endedAt, facts);
      throw reason;
    }

    await this.journal.settle(
      scopeKey,
      { status: "ok", result: { branches: outcome.branches, value: deepFreeze(outcome.value) } },
      this.options.handler.now(),
      {
        ...(outcome.cancel !== undefined ? { cancel: outcome.cancel } : {}),
        ...(outcome.closed !== undefined ? { closed: outcome.closed } : {}),
      },
    );
    return outcome.value;
  }

  private async runScope(
    name: string,
    scopeKind: ScopeKind,
    scopeName: string | null,
    occurrence: number,
    first: unknown,
    argNodes: AnyNode[],
    bag: unknown,
    env: Env,
    frame: Frame,
    ctx: EffectContext,
  ): Promise<ScopeOutcome> {
    if (name === "parallel" || name === "race") {
      const entries: [string, (f: Frame, a: unknown[]) => Promise<unknown>][] = Array.isArray(first)
        ? (first as ((f: Frame, a: unknown[]) => Promise<unknown>)[]).map((fn, i) => [String(i), fn])
        : Object.entries(first as Record<string, (f: Frame, a: unknown[]) => Promise<unknown>>);

      const frames = entries.map(([k]) => frame.branch(scopeKind, scopeName, occurrence, k));
      const running = entries.map(([, fn], i) => fn(frames[i] as Frame, []));

      const branches = entries.map(([k]) => k);

      if (name === "parallel") {
        let failed: string | null = null;
        const tracked = running.map((p, i) =>
          p.catch((e: unknown) => {
            if (failed === null) failed = entries[i]?.[0] as string;
            throw e;
          }),
        );
        try {
          const results = await Promise.all(tracked);
          frame.clock.join(frames.map((f) => f.clock));
          return {
            branches,
            value: Array.isArray(first) ? results : Object.fromEntries(entries.map(([k], i) => [k, results[i]])),
          };
        } catch (e) {
          // The first rejection cancels the rest, then rethrows. The intent travels WITH the
          // failure, because a rejecting branch cancels its siblings and can crash before they
          // hear it, so a failed scope owes its losers exactly as a winning one does.
          for (const f of frames) f.signal.cancel("a sibling branch failed");
          await Promise.allSettled(running);
          frame.clock.join(frames.map((f) => f.clock));
          const losers = branches.filter((k) => k !== failed);
          throw new ScopeFailed(e, { cancel: { losers, issued: false } });
        }
      }

      // race: first to settle wins, and the losers are cancelled BY SEMANTICS, not by an API the
      // program calls. A cancelled branch performs no new effects; an agent reply already in
      // flight completes and is ignored, which is the documented answer rather than an accident.
      // BOTH HANDLERS, and the rejection handler is the whole point. `p.then(() => undefined)`
      // propagates a rejection, so the first arm to FAIL threw straight out of this await: past the
      // cancellation below, past `allSettled`, and into a scope entry recorded as failed with no
      // losers on it. The run terminated while a sibling was still performing effects, which is the
      // exact defect §3.4 says the scope entry exists to prevent. A rejection is a settle.
      await Promise.race(running.map((p) => p.then(() => undefined, () => undefined)));
      for (const f of frames) f.signal.cancel("a sibling branch won the race");
      const settled = await Promise.allSettled(running);
      frame.clock.join(frames.map((f) => f.clock));

      // THE WINNER IS THE EARLIEST BRANCH, NOT THE FIRST ONE SCHEDULING HAPPENED TO WAKE.
      //
      // On a live run those are the same thing and this reads as ceremony. On a RE-ENTERED scope
      // they are not: a crash can leave two branches already settled in the journal, both replay
      // instantly, and whichever the event loop resumes first would otherwise win — so the same
      // journal could resolve a different arm on every attempt. The branch clock is the max endedAt
      // of the effects that branch awaited, which is recorded, so this tie-break is a function of
      // the journal. Equal clocks fall back to declaration order, which is also recorded.
      // A FAILURE IS A SETTLE, so a rejecting arm is a candidate to win — it just wins by failing
      // the scope. What is NOT a candidate is a branch that rejected with `Cancelled`, because that
      // is not an outcome the branch reached, it is what losing did to it. Counting those would let
      // a loser cut short at an early step outrank the winner that ran longer.
      let winnerAt = -1;
      let winnerIndex = -1;
      for (let i = 0; i < settled.length; i += 1) {
        const r = settled[i] as PromiseSettledResult<unknown>;
        if (r.status === "rejected" && r.reason instanceof Cancelled) continue;
        const at = (frames[i] as Frame).clock.now();
        if (winnerIndex === -1 || at < winnerAt) {
          winnerAt = at;
          winnerIndex = i;
        }
      }
      if (winnerIndex === -1) {
        // Every arm was cancelled, so the race itself was: nothing here decided anything.
        const first = settled.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
        throw first === undefined ? new Cancelled("every branch was cancelled") : (first.reason as Error);
      }
      const index = entries[winnerIndex]?.[0] as string;
      const won = settled[winnerIndex] as PromiseSettledResult<unknown>;
      if (won.status === "rejected") {
        // The earliest branch to settle FAILED. The scope fails with it, carrying the siblings it
        // cancelled — a losing arm can crash before the cancellation reaches it, so the intent has
        // to travel with the outcome exactly as it does for a winning race.
        throw new ScopeFailed(won.reason, {
          cancel: { losers: branches.filter((k) => k !== index), issued: false },
        });
      }
      return {
        branches,
        // BOTH the index and the value. The index alone is not enough: an edit to an arm's returned
        // expression would resume as the new value with no divergence raised.
        value: { index, value: (settled[winnerIndex] as PromiseFulfilledResult<unknown>).value },
        cancel: { losers: branches.filter((k) => k !== index), issued: false },
      };
    }

    if (name === "fanOut") {
      const items = first as unknown[];
      const fn = (await this.evaluate(argNodes[1] as AnyNode, env, frame)) as (
        f: Frame,
        a: unknown[],
      ) => Promise<unknown>;
      const keyFn = this.option(bag, "key") as ((f: Frame, a: unknown[]) => Promise<unknown>) | undefined;

      const branchKeys: string[] = [];
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        let k: unknown;
        if (keyFn !== undefined) k = await keyFn(frame, [item]);
        else if (item !== null && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
          k = (item as { id: string }).id;
        } else {
          throw new RuntimeFault(
            "L3021",
            `fanOut needs a stable key: without one, a reordered or filtered list silently reshuffles every journal key underneath it. Pass { key: (item) => ... }, or give items a string id.`,
          );
        }
        branchKeys.push(String(k));
      }
      if (new Set(branchKeys).size !== branchKeys.length) {
        throw new RuntimeFault(
          "L3024",
          `fanOut produced duplicate branch keys (${branchKeys.join(", ")}), so two branches would share one journal namespace and allocate the same step key with different inputs. Nothing has run yet: the keys are all evaluated before any branch launches, because rejecting after launch would be too late by exactly the side effects the check exists to prevent.`,
        );
      }

      const frames = branchKeys.map((k) => frame.branch(scopeKind, scopeName, occurrence, k));
      const results = await Promise.all(items.map((item, i) => fn(frames[i] as Frame, [item, i])));
      frame.clock.join(frames.map((f) => f.clock));
      return { branches: branchKeys, value: results };
    }

    if (name === "conclave") {
      // A conclave is a scope AND an effect, and it gets ONE entry, of kind `conclave`, carrying the
      // durable answer to "is this sub-team still live". That answer is the explicit `closed` FACT,
      // not the entry's state: a body that failed after a clean close settles `failed` exactly like
      // one whose close never acknowledged, and only the fact separates them. Pending means a close
      // is still owed. §17's migrate table reads that fact — an orphaned conclave is rejected unless
      // the scope closed — so a second entry for the close would be a second thing to keep in
      // agreement with the first, and nothing needs it.
      const members = deepFreeze(first) as AgentHandleValue[];
      const fn = (await this.evaluate(argNodes[1] as AnyNode, env, frame)) as (
        f: Frame,
        a: unknown[],
      ) => Promise<unknown>;
      const channel = this.option(bag, "channel") as string | undefined;
      const req: ConclaveRequest = { members, ...(channel !== undefined ? { channel } : {}) };
      const handler = this.options.handler;
      const handle = deepFreeze(await handler.openConclave(req, ctx)) as ChannelHandleValue;

      // One body, one branch, and the branch key is the fixed literal `in` rather than the channel
      // name. The channel is HANDLER-DERIVED — the simulator and the mesh mint different ones — so
      // keying the journal namespace by it would make a journal replayable only under the handler
      // that wrote it, which is the one thing the effect seam exists to prevent.
      // ONE constant, used for both the namespace and the recorded branch list, so the entry cannot
      // claim a key the body's steps were not actually filed under.
      const branchKey = "in";
      const branch = frame.branch(scopeKind, scopeName, occurrence, branchKey);

      // The body's outcome is decided FIRST, alone. The close is a separate act with a separate
      // failure mode, and folding it into this try is what made a close rejection retry itself and
      // then settle as an ordinary body failure — a `failed` entry indistinguishable from "the body
      // failed and the room closed cleanly", which an orphan walk reads as closed while the members
      // are still joined.
      // `threw` is a separate flag rather than `bodyError !== undefined`, because `throw undefined`
      // is a thing a program may do and "the body failed" must not depend on what it failed WITH.
      let bodyError: unknown;
      let threw = false;
      let value: unknown;
      try {
        value = await fn(branch, [handle]);
      } catch (e) {
        bodyError = e;
        threw = true;
      }
      frame.clock.join([branch.clock]);

      // A CANCELLED branch performs no new effects (§5.8), so a cancelled conclave does not close
      // itself: releasing the membership travels the same recovery path as every other branch-local
      // resource a race loser took (§3.4). A conclave whose body merely FAILED is not cancelled —
      // this process is live and the world is reachable — and walking away from live membership on
      // an ordinary error would be the `spawn` leak in another shape.
      if (bodyError instanceof Cancelled) throw new ScopeFailed(bodyError, { closed: false });

      try {
        await handler.closeConclave(req, ctx);
      } catch (e) {
        // THE CLOSE DID NOT ACKNOWLEDGE, so the scope does not settle at all. A pending entry IS
        // the durable "a close is still owed" — re-entry retries it — and settling anything here
        // would be the journal claiming a disposition the world never confirmed. The body's own
        // error, if there was one, is subordinate: it did not leave members joined; this did.
        throw new CloseOwed(e);
      }

      if (threw) throw new ScopeFailed(bodyError, { closed: true });
      return { branches: [branchKey], value, closed: true };
    }

    throw new RuntimeFault("L1000", `${name} is not implemented in this interpreter`);
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
        const mutable = node.kind === "let";
        for (const d of node.declarations as AnyNode[]) {
          const init = d.init === null || d.init === undefined ? undefined : await this.evaluate(d.init as AnyNode, env, frame);
          await this.bindPattern(d.id as AnyNode, init, env, frame, mutable);
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
        const loopEnv = new Env(env);
        if (node.init !== null && node.init !== undefined) await this.execute(node.init as AnyNode, loopEnv, frame);
        for (;;) {
          if (node.test !== null && node.test !== undefined && !(await this.evaluate(node.test as AnyNode, loopEnv, frame))) {
            return NORMAL;
          }
          const c = await this.execute(node.body as AnyNode, loopEnv, frame);
          if (c.type === "break") return NORMAL;
          if (c.type === "return") return c;
          if (node.update !== null && node.update !== undefined) await this.evaluate(node.update as AnyNode, loopEnv, frame);
        }
      }
      case "ForOfStatement": {
        const iterable = (await this.evaluate(node.right as AnyNode, env, frame)) as unknown[];
        for (const item of iterable) {
          const loopEnv = new Env(env);
          const decl = node.left as AnyNode;
          const target = decl.type === "VariableDeclaration" ? ((decl.declarations as AnyNode[])[0] as AnyNode).id as AnyNode : decl;
          await this.bindPattern(target, item, loopEnv, frame, decl.kind === "let");
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
        try {
          const c = await this.execute(node.block as AnyNode, env, frame);
          if (c.type !== "normal") return c;
        } catch (e) {
          // Two things a `catch` may not have, because neither is a program error and neither is
          // this program's to handle.
          //
          // A cancellation is the scope being unwound, and swallowing it would keep a branch
          // working after it lost a race.
          //
          // A durability failure is the JOURNAL refusing to record — the run losing its ability to
          // have a result at all. Measured before this line existed: a program whose store refused
          // an append caught the failure, performed two more effects against the world, and
          // returned normally. Nothing about that run was recorded from the refusal onward, so the
          // effects it went on to perform exist only in the world, and a resume would perform them
          // again. An unrecordable run must stop, and no `catch` may decide otherwise.
          if (e instanceof Cancelled || e instanceof JournalAppendRejected || e instanceof RunReleased) throw e;
          const handlerNode = node.handler as AnyNode | null;
          if (handlerNode === null || handlerNode === undefined) throw e;
          const catchEnv = new Env(env);
          if (handlerNode.param !== null && handlerNode.param !== undefined) {
            await this.bindPattern(handlerNode.param as AnyNode, toProgramError(e), catchEnv, frame, false);
          }
          const c = await this.executeBlock(handlerNode.body as AnyNode, catchEnv, frame);
          if (c.type !== "normal") return c;
        } finally {
          if (node.finalizer !== null && node.finalizer !== undefined) {
            await this.execute(node.finalizer as AnyNode, env, frame);
          }
        }
        return NORMAL;
      }
      case "SwitchStatement": {
        const disc = await this.evaluate(node.discriminant as AnyNode, env, frame);
        const cases = node.cases as AnyNode[];
        const switchEnv = new Env(env);
        let matched = false;
        for (const c of cases) {
          if (!matched) {
            if (c.test === null || c.test === undefined) matched = true;
            else if (Object.is(await this.evaluate(c.test as AnyNode, switchEnv, frame), disc)) matched = true;
          }
          if (!matched) continue;
          for (const s of (c.consequent as AnyNode[]) ?? []) {
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

function applyBinary(op: string, l: unknown, r: unknown): unknown {
  switch (op) {
    case "===":
      return Object.is(l, r) || l === r;
    case "!==":
      return !(l === r);
    case "<":
      return (l as number) < (r as number);
    case "<=":
      return (l as number) <= (r as number);
    case ">":
      return (l as number) > (r as number);
    case ">=":
      return (l as number) >= (r as number);
    case "+":
      return typeof l === "string" || typeof r === "string"
        ? String(l) + String(r)
        : (l as number) + (r as number);
    case "-":
      return (l as number) - (r as number);
    case "*":
      return (l as number) * (r as number);
    case "/":
      return (l as number) / (r as number);
    case "%":
      return (l as number) % (r as number);
    default:
      throw new RuntimeFault("L1000", `unsupported operator ${op}`);
  }
}

/** What a `catch` block sees: a plain record, because programs branch on data, not on classes. */
function toProgramError(e: unknown): Record<string, unknown> {
  if (e instanceof EffectError) {
    return deepFreeze({ code: e.code, kind: e.kind, message: e.message, ...(e.detail !== undefined ? { detail: e.detail } : {}) });
  }
  if (e instanceof RuntimeFault) return deepFreeze({ code: e.code, kind: "runtime", message: e.message });
  if (e !== null && typeof e === "object") return e as Record<string, unknown>;
  return deepFreeze({ code: "L4000", kind: "thrown", message: String(e) });
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
  const programHash = digest({ source });
  // A resume is handed the pins the run STARTED under and binds to them; a fresh run resolves them
  // once, here, and hands them back for the run record.
  const pins =
    options.pins !== undefined ? bindPins(options.pins, options) : resolvePins(options, options.handler.now());
  const interp = new Interpreter(ast as AnyNode, options, programHash, pins);

  // The run clock starts at the run's LOGICAL epoch, not at this host's clock: a run resumed on
  // another machine hours later must see the same `now()` before its first effect as the run that
  // wrote the journal, or the branch it takes is a property of when it was resumed.
  const frame = new Frame(new KeyScope(), new RunClock(pins.startedAt), new Signal());
  const env = new Env(null);
  installGlobals(env, interp, frame);

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

function installGlobals(env: Env, interp: Interpreter, rootFrame: Frame): void {
  const fn =
    (impl: (frame: Frame, args: unknown[]) => unknown) =>
    async (frame: Frame, args: unknown[]): Promise<unknown> =>
      impl(frame, args);

  // Pure primitives: a channel name is a name, so naming one costs nothing and journals nothing.
  env.declare("channel", fn((_f, a) => ({ channel: a[0] as string })), false);
  env.declare(
    "run",
    fn(() => ({ id: interp.options.runId, programHash: interp.programHash, startedAt: interp.pins.startedAt })),
    false,
  );

  // Event constructors are pure descriptors; awaiting them is `wait`.
  env.declare("replied", fn((_f, a) => ({ event: "replied", agent: (a[0] as AgentHandleValue).agent })), false);
  env.declare(
    "message",
    fn((_f, a) => {
      const ch = (a[0] as ChannelHandleValue).channel;
      const opts = (a[1] ?? {}) as Record<string, unknown>;
      return {
        event: "message",
        channel: ch,
        ...(opts.from !== undefined ? { from: (opts.from as AgentHandleValue).agent } : {}),
        ...(opts.matches !== undefined ? { matches: opts.matches as string } : {}),
      };
    }),
    false,
  );
  env.declare("idle", fn((_f, a) => ({ event: "idle", channel: (a[0] as ChannelHandleValue).channel, duration: a[1] as string })), false);
  env.declare("down", fn((_f, a) => ({ event: "down", agent: (a[0] as AgentHandleValue).agent })), false);

  // Time and randomness, tamed. `now()` reads the branch's own run clock, which is the maximum
  // endedAt over the effects this point actually awaited: time advances at effect boundaries as a
  // property of the design rather than a rule anyone has to follow.
  env.declare("now", fn((frame) => frame.clock.now()), false);
  env.declare("random", fn((frame) => interp.prng.next(frame.keys.path)), false);
  env.declare("randomInt", fn((frame, a) => Math.floor(interp.prng.next(frame.keys.path) * (a[0] as number))), false);
  env.declare(
    "pick",
    fn((frame, a) => {
      const list = a[0] as unknown[];
      return list[Math.floor(interp.prng.next(frame.keys.path) * list.length)];
    }),
    false,
  );
  env.declare("duration", fn((_f, a) => parseDuration(a[0] as string)), false);

  // Records and arrays. Iteration order is insertion order, which is deterministic; sorting for
  // a hash is a separate concern and happens in canonicalization, not here.
  env.declare("keys", fn((_f, a) => Object.keys(a[0] as object)), false);
  env.declare("values", fn((_f, a) => Object.values(a[0] as object)), false);
  env.declare("entries", fn((_f, a) => Object.entries(a[0] as object)), false);
  env.declare("has", fn((_f, a) => Object.prototype.hasOwnProperty.call(a[0] as object, a[1] as string)), false);
  env.declare("merge", fn((_f, a) => ({ ...(a[0] as object), ...(a[1] as object) })), false);
  env.declare("len", fn((_f, a) => (a[0] as { length: number }).length), false);
  env.declare("range", fn((_f, a) => Array.from({ length: a[0] as number }, (_, i) => i)), false);
  env.declare("sum", fn((_f, a) => (a[0] as number[]).reduce((x, y) => x + y, 0)), false);
  env.declare("concat", fn((_f, a) => (a[0] as unknown[]).concat(a[1] as unknown[])), false);
  env.declare("slice", fn((_f, a) => (a[0] as unknown[]).slice(a[1] as number, a[2] as number | undefined)), false);
  env.declare("reverse", fn((_f, a) => [...(a[0] as unknown[])].reverse()), false);
  env.declare("unique", fn((_f, a) => [...new Set(a[0] as unknown[])]), false);
  env.declare("join", fn((_f, a) => (a[0] as unknown[]).join(a[1] as string)), false);

  // Higher-order builtins take an interpreter function, so they have to await it.
  const higher =
    (impl: (frame: Frame, list: unknown[], f: (frame: Frame, args: unknown[]) => Promise<unknown>) => Promise<unknown>) =>
    async (frame: Frame, args: unknown[]): Promise<unknown> =>
      await impl(frame, args[0] as unknown[], args[1] as (frame: Frame, args: unknown[]) => Promise<unknown>);

  env.declare(
    "map",
    higher(async (frame, list, f) => {
      const out: unknown[] = [];
      for (let i = 0; i < list.length; i += 1) out.push(await f(frame, [list[i], i]));
      return out;
    }),
    false,
  );
  env.declare(
    "filter",
    higher(async (frame, list, f) => {
      const out: unknown[] = [];
      for (let i = 0; i < list.length; i += 1) if (await f(frame, [list[i], i])) out.push(list[i]);
      return out;
    }),
    false,
  );
  env.declare(
    "find",
    higher(async (frame, list, f) => {
      for (let i = 0; i < list.length; i += 1) if (await f(frame, [list[i], i])) return list[i];
      return null;
    }),
    false,
  );
  env.declare(
    "some",
    higher(async (frame, list, f) => {
      for (let i = 0; i < list.length; i += 1) if (await f(frame, [list[i], i])) return true;
      return false;
    }),
    false,
  );
  env.declare(
    "every",
    higher(async (frame, list, f) => {
      for (let i = 0; i < list.length; i += 1) if (!(await f(frame, [list[i], i]))) return false;
      return true;
    }),
    false,
  );

  // Strings and numbers.
  env.declare("split", fn((_f, a) => (a[0] as string).split(a[1] as string)), false);
  env.declare("trim", fn((_f, a) => (a[0] as string).trim()), false);
  env.declare("lower", fn((_f, a) => (a[0] as string).toLowerCase()), false);
  env.declare("upper", fn((_f, a) => (a[0] as string).toUpperCase()), false);
  env.declare("startsWith", fn((_f, a) => (a[0] as string).startsWith(a[1] as string)), false);
  env.declare("endsWith", fn((_f, a) => (a[0] as string).endsWith(a[1] as string)), false);
  env.declare("contains", fn((_f, a) => (a[0] as string).includes(a[1] as string)), false);
  env.declare("replace", fn((_f, a) => (a[0] as string).split(a[1] as string).join(a[2] as string)), false);
  env.declare("min", fn((_f, a) => Math.min(...(a as number[]))), false);
  env.declare("max", fn((_f, a) => Math.max(...(a as number[]))), false);
  env.declare("abs", fn((_f, a) => Math.abs(a[0] as number)), false);
  env.declare("floor", fn((_f, a) => Math.floor(a[0] as number)), false);
  env.declare("ceil", fn((_f, a) => Math.ceil(a[0] as number)), false);
  env.declare("round", fn((_f, a) => Math.round(a[0] as number)), false);
  env.declare("parseNumber", fn((_f, a) => Number(a[0] as string)), false);

  env.declare(
    "assert",
    fn((_f, a) => {
      if (!a[0]) throw new RuntimeFault("L4012", String(a[1] ?? "assertion failed"));
      return null;
    }),
    false,
  );
  env.declare(
    "log",
    fn((frame, a) => {
      interp.options.onLog?.({ scope: scopePathString(frame.keys.path), values: a });
      return null;
    }),
    false,
  );

  void rootFrame;
}

export { LangError, LangErrors };
