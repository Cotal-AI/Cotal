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
import { KeyScope, digest, requestId, scopePathString, stepKeyString, type ScopeKind } from "./keys.js";
import { Journal, RunClock, type EntryError } from "./journal.js";
import { Prng, assertCrossable, deepFreeze } from "./values.js";
import { parseDuration } from "./duration.js";
import { PRIMITIVES, type EffectKind } from "./primitives.js";
import {
  Cancelled,
  EffectError,
  applyCheckpointPolicy,
  type AgentHandleValue,
  type CancelSignal,
  type ChannelHandleValue,
  type EffectContext,
  type EffectHandler,
  type CheckpointRaw,
  type EventDescriptor,
} from "./effects.js";

type AnyNode = Record<string, unknown> & { type: string };

// ---- environments ------------------------------------------------------------------------------

class Binding {
  constructor(
    public value: unknown,
    readonly mutable: boolean,
  ) {}
}

class Env {
  private readonly names = new Map<string, Binding>();
  constructor(readonly parent: Env | null) {}

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

  get(name: string): unknown {
    const b = this.find(name);
    if (b === undefined) throw new RuntimeFault("L2001", `${name} is not defined`);
    return b.value;
  }

  has(name: string): boolean {
    return this.find(name) !== undefined;
  }

  set(name: string, value: unknown): void {
    const b = this.find(name);
    if (b === undefined) throw new RuntimeFault("L2001", `${name} is not defined`);
    if (!b.mutable) throw new RuntimeFault("L2003", `${name} is declared const`);
    b.value = value;
  }
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
  ) {}

  branch(kind: ScopeKind, name: string | null, occurrence: number, branchKey: string): Frame {
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
  readonly seed?: string;
  readonly file?: string;
  /** Fail loud rather than spinning forever when a loop does not terminate. */
  readonly effectCeiling?: number;
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
  ) {
    this.journal = options.journal ?? new Journal({ run: options.runId });
    this.prng = new Prng(options.seed ?? options.runId);
    this.ceiling = options.effectCeiling ?? 10_000;
    this.stepBudget = options.stepBudget ?? 1_000_000;
    this.yieldEvery = options.yieldEvery ?? 1_024;
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
    perform: (ctx: EffectContext) => Promise<unknown>,
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

    this.effectCount += 1;
    if (this.effectCount > this.ceiling) {
      throw new RuntimeFault(
        "L4009",
        `this run has performed more than ${this.ceiling} effects, which means a loop is not terminating. Add an exit condition or a permit.`,
      );
    }

    const resume = verdict.verdict === "pending" ? verdict.entry.external : undefined;
    const reqId = requestId(this.options.runId, key, inputHash);
    if (verdict.verdict === "miss") {
      this.journal.begin(key, inputHash, this.options.handler.now(), reqId);
    }

    const ctx: EffectContext = {
      key,
      signal: frame.signal,
      // Derived from the run, the step, the inputs and the attempt, and written on the pending
      // entry by `begin` above BEFORE the handler runs. A handler submits under it idempotently,
      // so a resumed run reissues the same id rather than creating a second goal.
      requestId: reqId,
      ...(resume !== undefined ? { resume } : {}),
      bind: async (external) => {
        this.journal.bind(key, external);
      },
    };

    try {
      const result = await perform(ctx);
      assertCrossable(result, `the result of ${stepKeyString(key)}`);
      const endedAt = this.options.handler.now();
      this.journal.settle(key, { status: "ok", result: deepFreeze(result) }, endedAt);
      frame.clock.advance(endedAt);
      return result;
    } catch (e) {
      const endedAt = this.options.handler.now();
      if (e instanceof Cancelled) {
        this.journal.settle(key, { status: "cancelled" }, endedAt);
        throw e;
      }
      // A handler may raise a language code directly, and it survives. The simulator's "unscripted
      // effect" is L6001, and flattening that to a generic handler fault would tell a caller acting
      // on `code` that the handler broke, when what actually happened is that their script is
      // incomplete. Only the L-code shape is honoured: anything else a thrown object happens to
      // call `code` (an errno, an HTTP status) is a handler fault and is recorded as one.
      const raised = (e as { code?: unknown }).code;
      const carried = typeof raised === "string" && /^L\d{4}$/.test(raised) ? raised : null;
      const error: EntryError =
        e instanceof EffectError
          ? { code: e.code, kind: e.kind, message: e.message, ...(e.detail !== undefined ? { detail: e.detail } : {}) }
          : carried !== null
            ? { code: carried, kind: "handler-fault", message: (e as Error).message }
            : { code: "L4000", kind: "handler-fault", message: (e as Error).message };
      this.journal.settle(key, { status: "failed", error }, endedAt);
      frame.clock.advance(endedAt);
      throw e instanceof EffectError ? e : new EffectError(error.code, error.kind, error.message);
    }
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
        env.set(left.name as string, value);
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
      const env = new Env(closure);
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
        return await this.performEffect(
          "turn",
          stepName as string,
          { agent: agent.agent },
          (ctx) => handler.turn({ agent, ...(this.option(bag, "deadline") !== undefined ? { deadline: this.option(bag, "deadline") as string } : {}) }, ctx),
          frame,
        );
      }
      case "ask": {
        const agent = deepFreeze(args[0]) as AgentHandleValue;
        const schema = this.option(bag, "schema");
        return await this.performEffect(
          "ask",
          stepName as string,
          { agent: agent.agent, schema: schema ?? null },
          (ctx) =>
            handler.ask(
              {
                agent,
                schema,
                ...(this.option(bag, "deadline") !== undefined
                  ? { deadline: this.option(bag, "deadline") as string }
                  : {}),
                ...(this.option(bag, "attempts") !== undefined
                  ? { attempts: this.option(bag, "attempts") as number }
                  : {}),
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
        return applyCheckpointPolicy(
          (await this.performEffect(
          "checkpoint",
          stepName as string,
          { prompt, schema: schema ?? null },
          (ctx) =>
            handler.checkpoint(
              {
                prompt,
                ...(schema !== undefined ? { schema } : {}),
                ...(this.option(bag, "timeout") !== undefined ? { timeout: this.option(bag, "timeout") as string } : {}),
                ...(this.option(bag, "onExpiry") !== undefined ? { onExpiry: this.option(bag, "onExpiry") as "fail" | "proceed" | "escalate" } : {}),
                ...(this.option(bag, "to") !== undefined ? { to: this.option(bag, "to") as string } : {}),
              },
              ctx,
            ),
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
        return await this.performEffect(
          "wait",
          stepName ?? "",
          event,
          (ctx) => handler.wait({ event, ...(timeout !== undefined ? { timeout } : {}) }, ctx),
          frame,
        );
      }
      case "notify": {
        const agents = deepFreeze(args[0]) as AgentHandleValue[];
        const fact = deepFreeze(args[1]) as { decision: string; outcome: string };
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

    if (name === "parallel" || name === "race") {
      const entries: [string, (f: Frame, a: unknown[]) => Promise<unknown>][] = Array.isArray(first)
        ? (first as ((f: Frame, a: unknown[]) => Promise<unknown>)[]).map((fn, i) => [String(i), fn])
        : Object.entries(first as Record<string, (f: Frame, a: unknown[]) => Promise<unknown>>);

      const frames = entries.map(([k]) => frame.branch(scopeKind, scopeName, occurrence, k));
      const running = entries.map(([, fn], i) => fn(frames[i] as Frame, []));

      if (name === "parallel") {
        try {
          const results = await Promise.all(running);
          frame.clock.join(frames.map((f) => f.clock));
          return Array.isArray(first)
            ? results
            : Object.fromEntries(entries.map(([k], i) => [k, results[i]]));
        } catch (e) {
          // The first rejection cancels the rest, then rethrows.
          for (const f of frames) f.signal.cancel("a sibling branch failed");
          await Promise.allSettled(running);
          frame.clock.join(frames.map((f) => f.clock));
          throw e;
        }
      }

      // race: first to settle wins, and the losers are cancelled BY SEMANTICS, not by an API the
      // program calls. A cancelled branch performs no new effects; an agent reply already in
      // flight completes and is ignored, which is the documented answer rather than an accident.
      const winner = await Promise.race(
        running.map((p, i) => p.then((value) => ({ index: entries[i]?.[0] as string, value }))),
      );
      for (const f of frames) f.signal.cancel("a sibling branch won the race");
      await Promise.allSettled(running);
      frame.clock.join(frames.map((f) => f.clock));
      return winner;
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
      return results;
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
          // A cancellation is not a program error: it is the scope being unwound, and a catch
          // block must not be able to swallow it and keep working in a branch that lost a race.
          if (e instanceof Cancelled) throw e;
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
  const interp = new Interpreter(ast as AnyNode, options, programHash);

  const frame = new Frame(new KeyScope(), new RunClock(options.handler.now()), new Signal());
  const env = new Env(null);
  installGlobals(env, interp, frame);

  const completion = await interp.executeBlock(ast as AnyNode, env, frame);
  return {
    value: completion.type === "return" ? completion.value : undefined,
    journal: interp.journal,
    programHash,
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
  env.declare("run", fn(() => ({ id: interp.options.runId, programHash: interp.programHash })), false);

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
