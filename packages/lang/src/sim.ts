/**
 * The simulation handler: the same interpreter, a different handler.
 *
 * That is the whole design, and it is why simulation is v1 scope rather than a later nicety. It
 * costs one implementation of an interface the runtime needed anyway, and it is the test harness
 * for everything else: scripted turns, instant sleeps, injected checkpoint answers, and injected
 * faults, with no broker, no agents, and no wall-clock waiting.
 *
 * The rule that makes it worth trusting: **an unscripted effect is an error, never a default**. A
 * simulator that invents a plausible turn result is a simulator that green-lights broken programs,
 * which is worse than having no simulator at all.
 */

import type {
  AgentHandleValue,
  AskRequest,
  ChannelHandleValue,
  CheckpointRequest,
  CheckpointRaw,
  CheckpointResultValue,
  ConclaveRequest,
  EffectContext,
  EffectHandler,
  MonitorRequest,
  NotifyRequest,
  SleepRequest,
  SpawnRequest,
  TurnRequest,
  TurnResultValue,
  WaitRequest,
} from "./effects.js";
import { Cancelled, EffectError, askSchemaShape, conformsToAskSchema } from "./effects.js";
import { parseDuration } from "./duration.js";
import { stepKeyString } from "./keys.js";

/** A scripted outcome: one value used for every occurrence, or one per occurrence in order. */
export type Scripted<T> = T | readonly T[];

export interface SimFault {
  /** The step key, either in full (`/parallel:x#0/b:a/turn:build#1`) or short (`turn:build#1`). */
  readonly at: string;
  readonly kind: string;
  readonly code?: string;
  readonly message?: string;
}

export interface SimScript {
  readonly turns?: Readonly<Record<string, Scripted<TurnResultValue>>>;
  readonly asks?: Readonly<Record<string, Scripted<unknown>>>;
  /**
   * ⚠️ `at` IS NOT SCRIPTABLE. Both of `checkpoint()`'s return paths stamp it from virtual time
   * and neither one reads a scripted value, so anything written here was required by the type and
   * then silently discarded. Demanding a field the implementation overwrites makes every fixture
   * carry a number that means nothing, and reads to the next author as though it were honoured.
   *
   * The refusal is a rule, not a list: it fires exactly where `SimScript` is already the expected
   * type of the literal being written, and nowhere else. So a literal at a call taking a
   * `SimScript`, under an annotation on a `const` or a later-assigned `let`, in a parameter declared
   * `SimScript`, or under `satisfies SimScript` is now an error. A literal typed before it meets this
   * type, or never measured against it, escapes: inferred then passed by name, put through an `as`
   * cast, or handed to a parameter declared `unknown`. Those still compile with `at` present and
   * still have it discarded. This closes the idioms a new author reaches for; not the loophole.
   */
  readonly checkpoints?: Readonly<Record<string, Scripted<Omit<CheckpointResultValue, "at">>>>;
  /** Keyed by the `wait` step's name. A scripted `null` is a timeout, which is a choice. */
  readonly events?: Readonly<Record<string, Scripted<unknown>>>;
  readonly clock?: {
    readonly start?: number;
    /** Virtual time each turn consumes. Default "5m". */
    readonly turn?: string;
    readonly ask?: string;
    readonly checkpoint?: string;
    readonly wait?: string;
  };
  readonly faults?: readonly SimFault[];
}

export class SimUnscriptedError extends Error {
  constructor(
    readonly code: string,
    readonly stepKey: string,
    message: string,
  ) {
    super(message);
    this.name = "SimUnscriptedError";
  }
}

interface Consumption {
  readonly table: string;
  readonly name: string;
  readonly occurrence: number;
}

/**
 * The simulation handler.
 *
 * Every effect resolves from the script or fails loudly. Sleeps are instant and advance the
 * virtual clock by the duration the program asked for, so a program that waits four hours is
 * tested in microseconds without pretending the wait did not happen.
 *
 * ONE clock, advanced event by event. Time is discrete-event simulated: every timed effect
 * (sleep, turn, ask, checkpoint, wait) computes its wake from the clock at dispatch, parks in a
 * queue, and a self-scheduled pump delivers parked events in wake order, one per macrotask,
 * moving the clock to each wake as it delivers. Concurrent branches therefore accumulate their
 * own durations: two racing sleeps park at open+1m and open+5m, the 1m arm is delivered first,
 * and its settle stamps the earlier clock, so a simulated race is decided by the durations the
 * arms wrote, under the same rule (least recorded clock, ties by declaration order) a live
 * handler produces. `scopes.smoke` section 1 pins the agreement.
 *
 * The invariant the pump keeps: the clock a parking branch reads IS that branch's own time. A
 * delivery drains the delivered branch's microtasks before the next pop, and a scope join hands
 * the parent its winner's clock, so at every park the shared clock equals the parking branch's
 * time. A wrapper that defers the park across a macrotask (a handler awaiting a timeout before
 * delegating) is choosing a different schedule, as any custom handler may.
 *
 * A parked event whose branch is cancelled is removed and rejected with `Cancelled`: the entry
 * settles `cancelled` and the clock never advances to a wake nobody reached. §7.6 leaves
 * in-flight work to the handler, and this is this handler's choice; it matches a driver
 * abandoning a durable timer.
 */
interface ParkedEvent {
  readonly wake: number;
  readonly seq: number;
  done: boolean;
  readonly deliver: () => void;
  readonly cancel: (reason: Cancelled) => void;
}

export class SimHandler implements EffectHandler {
  private virtualNow: number;
  private readonly occurrences = new Map<string, number>();
  private readonly consumed: Consumption[] = [];
  private readonly agents = new Map<string, AgentHandleValue>();
  private readonly parked: ParkedEvent[] = [];
  private parkSeq = 0;
  private pumpScheduled = false;

  constructor(readonly script: SimScript = {}) {
    this.virtualNow = script.clock?.start ?? 0;
  }

  now(): number {
    return this.virtualNow;
  }

  /** Advance virtual time immediately. The timed effects go through the event queue instead. */
  advance(ms: number): void {
    this.virtualNow += ms;
  }

  /**
   * Park a timed effect until the queue delivers its wake. The wake is computed from the clock
   * at dispatch, which by the pump's invariant is the dispatching branch's own time.
   */
  private timed(ms: number, ctx: EffectContext): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (ctx.signal.cancelled) {
        reject(new Cancelled(ctx.signal.reason ?? "cancelled"));
        return;
      }
      const event: ParkedEvent = {
        wake: this.virtualNow + ms,
        seq: this.parkSeq++,
        done: false,
        deliver: () => {
          if (event.done) return;
          event.done = true;
          this.virtualNow = Math.max(this.virtualNow, event.wake);
          resolve();
        },
        cancel: (reason) => {
          if (event.done) return;
          event.done = true;
          reject(reason);
        },
      };
      ctx.signal.onCancel((reason) => event.cancel(new Cancelled(reason)));
      this.parked.push(event);
      this.schedulePump();
    });
  }

  /**
   * One delivery per macrotask, with the microtask queue drained between: the delivered branch
   * runs to its next park (or its settle) before the next pop, which is what keeps the clock a
   * parking branch reads equal to that branch's own time.
   */
  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    setImmediate(() => {
      this.pumpScheduled = false;
      let next: ParkedEvent | undefined;
      for (const e of this.parked) {
        if (e.done) continue;
        if (next === undefined || e.wake < next.wake || (e.wake === next.wake && e.seq < next.seq)) next = e;
      }
      next?.deliver();
      for (let i = this.parked.length - 1; i >= 0; i--) {
        if (this.parked[i]!.done) this.parked.splice(i, 1);
      }
      if (this.parked.length > 0) this.schedulePump();
    });
  }

  private timedBy(spec: string | undefined, fallback: string, ctx: EffectContext): Promise<void> {
    return this.timed(parseDuration(spec ?? fallback), ctx);
  }

  /** Which occurrence of this (table, name) we are on, counted per simulated run. */
  private nextOccurrence(table: string, name: string): number {
    const tag = `${table}:${name}`;
    const n = this.occurrences.get(tag) ?? 0;
    this.occurrences.set(tag, n + 1);
    return n;
  }

  private checkFault(ctx: EffectContext): void {
    const full = stepKeyString(ctx.key);
    const short = full.slice(full.lastIndexOf("/") + 1);
    const fault = this.script.faults?.find((f) => f.at === full || f.at === short);
    if (fault === undefined) return;
    throw new EffectError(
      fault.code ?? "L4002",
      fault.kind,
      fault.message ?? `simulated ${fault.kind} at ${full}`,
    );
  }

  /**
   * Resolve one scripted outcome, or fail. `name` falls back to the effect kind for unnamed
   * steps, which is the same fallback the journal key uses, so a script and a real trace read
   * against each other without translation.
   */
  private resolve<T>(
    table: string,
    scripted: Readonly<Record<string, Scripted<T>>> | undefined,
    ctx: EffectContext,
  ): T {
    this.checkFault(ctx);
    const name = ctx.key.name === "" ? ctx.key.kind : ctx.key.name;
    const entry = scripted?.[name];
    const stepKey = stepKeyString(ctx.key);
    if (entry === undefined) {
      throw new SimUnscriptedError(
        "L6001",
        stepKey,
        `L6001 Unscripted effect in simulation\n\nThe script has no ${table} entry for "${name}" (step ${stepKey}).\n\nFix: add one, for example { ${table}: { "${name}": <result> } }. The simulator never invents a result, because a simulator that guesses is a simulator that green-lights broken programs.`,
      );
    }
    const occurrence = this.nextOccurrence(table, name);
    this.consumed.push({ table, name, occurrence });
    if (!Array.isArray(entry)) return entry as T;
    const list = entry as readonly T[];
    const value = list[occurrence];
    if (value === undefined) {
      throw new SimUnscriptedError(
        "L6001",
        stepKey,
        `L6001 Unscripted effect in simulation\n\nThe script gives ${list.length} ${table} result${list.length === 1 ? "" : "s"} for "${name}", and this is occurrence ${occurrence} (step ${stepKey}).\n\nFix: add another entry to the list, or use a single value to script every occurrence the same way.`,
      );
    }
    return value;
  }

  // ---- the handler ----------------------------------------------------------------------------

  async spawn(req: SpawnRequest, ctx: EffectContext): Promise<AgentHandleValue> {
    this.checkFault(ctx);
    const n = this.nextOccurrence("spawn", req.persona);
    const handle: AgentHandleValue = {
      agent: `sim.${req.persona}${n === 0 ? "" : `-${n + 1}`}`,
      persona: req.persona,
      ...(req.worktree !== undefined ? { worktree: req.worktree } : {}),
      ...(req.role !== undefined ? { role: req.role } : {}),
    };
    this.agents.set(handle.agent, handle);
    await ctx.bind({ simAgent: handle.agent });
    return handle;
  }

  async turn(_req: TurnRequest, ctx: EffectContext): Promise<TurnResultValue> {
    const scripted = this.resolve("turns", this.script.turns, ctx);
    await ctx.bind({ simGoal: stepKeyString(ctx.key) });
    await this.timedBy(this.script.clock?.turn, "5m", ctx);
    return { ...scripted, at: this.virtualNow };
  }

  /**
   * The one effect with a reply contract. The request's schema is read as the shorthand
   * (`askSchemaShape`), and every scripted reply is checked against it: a non-conforming reply
   * consumes one attempt, one scripted occurrence, and one reply's worth of virtual time, and
   * running out of attempts reports L4006, exactly as a production handler must. An unreadable
   * schema is refused (L4022) rather than skipped, because a schema the handler cannot read and
   * silently ignores is a contract the program believes in and nobody checks. To exercise the
   * exhaustion path, script at least as many replies as `attempts`: the simulator still never
   * invents one, so a script that runs out first fails as L6001.
   */
  async ask(req: AskRequest, ctx: EffectContext): Promise<unknown> {
    const shape = askSchemaShape(req.schema);
    if (shape === null) {
      this.checkFault(ctx);
      throw new EffectError(
        "L4022",
        "ask-schema-unreadable",
        `L4022 Unreadable ask schema\n\n  step  ${stepKeyString(ctx.key)}\n\nThe schema is not the shorthand a reference handler enforces: a record mapping each field name to one of "string", "number", "boolean", "array", "record", "null".\n\nFix: write the shorthand, for example { steps: "array" }, or pass {} to accept any record.`,
      );
    }
    const attempts = req.attempts ?? 1;
    let bound = false;
    for (let attempt = 1; ; attempt++) {
      const value = this.resolve("asks", this.script.asks, ctx);
      if (!bound) {
        await ctx.bind({ simGoal: stepKeyString(ctx.key) });
        bound = true;
      }
      await this.timedBy(this.script.clock?.ask, "1m", ctx);
      if (conformsToAskSchema(value, shape)) return value;
      if (attempt >= attempts) {
        throw new EffectError(
          "L4006",
          "ask-nonconforming",
          `L4006 ask never produced a conforming record\n\n  step  ${stepKeyString(ctx.key)}\n\n${attempts} repl${attempts === 1 ? "y was" : "ies were"} checked against the schema and none conformed.\n\nFix: script a reply that matches the schema, widen the schema, or raise attempts.`,
        );
      }
    }
  }

  /**
   * Reports WHAT HAPPENED and never whether it throws. A script says `resolved` or `expired`; the
   * interpreter journals that and applies today's `onExpiry` afterwards. A simulator that decided
   * the disposition would bake it into the record exactly as a production handler would.
   */
  async checkpoint(_req: CheckpointRequest, ctx: EffectContext): Promise<CheckpointRaw> {
    const scripted = this.resolve("checkpoints", this.script.checkpoints, ctx);
    await ctx.bind({ simCheckpoint: stepKeyString(ctx.key) });
    await this.timedBy(this.script.clock?.checkpoint, "1m", ctx);
    if (scripted.status === "expired") return { outcome: "expired", at: this.virtualNow };
    return {
      outcome: "resolved",
      ...(scripted.value !== undefined ? { value: scripted.value } : {}),
      ...(scripted.by !== undefined ? { by: scripted.by } : {}),
      ...(scripted.artifact !== undefined ? { artifact: scripted.artifact } : {}),
      at: this.virtualNow,
    };
  }

  /** Instant in wall time: the sleep parks at its wake and the queue delivers it in order. */
  async sleep(req: SleepRequest, ctx: EffectContext): Promise<null> {
    this.checkFault(ctx);
    await this.timed(parseDuration(req.duration), ctx);
    return null;
  }

  async wait(req: WaitRequest, ctx: EffectContext): Promise<unknown | null> {
    const value = this.resolve("events", this.script.events, ctx);
    // A scripted null is a timeout, and a timeout consumes the whole timeout budget.
    if (value === null && req.timeout !== undefined) await this.timed(parseDuration(req.timeout), ctx);
    else await this.timedBy(this.script.clock?.wait, "1m", ctx);
    return value;
  }

  async notify(_req: NotifyRequest, ctx: EffectContext): Promise<null> {
    this.checkFault(ctx);
    return null;
  }

  async monitor(_req: MonitorRequest, ctx: EffectContext): Promise<null> {
    this.checkFault(ctx);
    return null;
  }

  async openConclave(req: ConclaveRequest, ctx: EffectContext): Promise<ChannelHandleValue> {
    this.checkFault(ctx);
    return { channel: req.channel ?? `sim-conclave-${stepKeyString(ctx.key)}` };
  }

  async closeConclave(_req: ConclaveRequest, ctx: EffectContext): Promise<null> {
    this.checkFault(ctx);
    return null;
  }

  // ---- the report ------------------------------------------------------------------------------

  /**
   * Script entries the run never reached. Usually a renamed step, which is worth saying out loud:
   * a script that silently stops matching is a test that silently stops testing.
   */
  unusedScript(): readonly string[] {
    const used = new Set(this.consumed.map((c) => `${c.table}:${c.name}`));
    const out: string[] = [];
    for (const table of ["turns", "asks", "checkpoints", "events"] as const) {
      const t = this.script[table];
      if (t === undefined) continue;
      for (const name of Object.keys(t)) {
        if (!used.has(`${table}:${name}`)) out.push(`${table}.${name}`);
      }
    }
    return out;
  }

  /** Every effect the run performed, in order, for the dry-run report. */
  performed(): readonly Consumption[] {
    return this.consumed;
  }
}
