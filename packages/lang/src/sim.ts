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
import { EffectError } from "./effects.js";
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
   * ⚠️ `at` IS NOT SCRIPTABLE, AND THE TYPE NOW SAYS SO. The handler stamps it from virtual time —
   * `{ ...scripted, at: this.virtualNow }` — so a value written here was required by the type and
   * then silently discarded. Demanding a field the implementation overwrites makes every fixture
   * carry a number that means nothing, and reads to the next author as though it were honoured.
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
 */
export class SimHandler implements EffectHandler {
  private virtualNow: number;
  private readonly occurrences = new Map<string, number>();
  private readonly consumed: Consumption[] = [];
  private readonly agents = new Map<string, AgentHandleValue>();

  constructor(readonly script: SimScript = {}) {
    this.virtualNow = script.clock?.start ?? 0;
  }

  now(): number {
    return this.virtualNow;
  }

  /** Advance virtual time. Sleeps do this by their full duration; turns by a scripted default. */
  advance(ms: number): void {
    this.virtualNow += ms;
  }

  private advanceBy(spec: string | undefined, fallback: string): void {
    this.advance(parseDuration(spec ?? fallback));
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
    this.advanceBy(this.script.clock?.turn, "5m");
    return { ...scripted, at: this.virtualNow };
  }

  async ask(_req: AskRequest, ctx: EffectContext): Promise<unknown> {
    const value = this.resolve("asks", this.script.asks, ctx);
    await ctx.bind({ simGoal: stepKeyString(ctx.key) });
    this.advanceBy(this.script.clock?.ask, "1m");
    return value;
  }

  /**
   * Reports WHAT HAPPENED and never whether it throws. A script says `resolved` or `expired`; the
   * interpreter journals that and applies today's `onExpiry` afterwards. A simulator that decided
   * the disposition would bake it into the record exactly as a production handler would.
   */
  async checkpoint(_req: CheckpointRequest, ctx: EffectContext): Promise<CheckpointRaw> {
    const scripted = this.resolve("checkpoints", this.script.checkpoints, ctx);
    await ctx.bind({ simCheckpoint: stepKeyString(ctx.key) });
    this.advanceBy(this.script.clock?.checkpoint, "1m");
    if (scripted.status === "expired") return { outcome: "expired", at: this.virtualNow };
    return {
      outcome: "resolved",
      ...(scripted.value !== undefined ? { value: scripted.value } : {}),
      ...(scripted.by !== undefined ? { by: scripted.by } : {}),
      ...(scripted.artifact !== undefined ? { artifact: scripted.artifact } : {}),
      at: this.virtualNow,
    };
  }

  /** Instant, and honest: the clock moves by exactly what the program asked to wait. */
  async sleep(req: SleepRequest, ctx: EffectContext): Promise<null> {
    this.checkFault(ctx);
    this.advance(parseDuration(req.duration));
    return null;
  }

  async wait(req: WaitRequest, ctx: EffectContext): Promise<unknown | null> {
    const value = this.resolve("events", this.script.events, ctx);
    // A scripted null is a timeout, and a timeout consumes the whole timeout budget.
    if (value === null && req.timeout !== undefined) this.advance(parseDuration(req.timeout));
    else this.advanceBy(this.script.clock?.wait, "1m");
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
