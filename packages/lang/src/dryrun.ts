/**
 * Dry run: simulate a program and report what it WOULD do, before it does it. `plan` before
 * `apply`.
 *
 * The report is built by wrapping any {@link EffectHandler} in a recorder rather than by teaching
 * the simulator to describe itself. That matters for a reason beyond tidiness: the recorder sees
 * exactly what the interpreter hands a handler, so a dry run cannot describe a program differently
 * from the way it would be executed. A reporter that reads the source separately can drift from the
 * runtime; this one is downstream of the same call.
 *
 * It also means the recorder works over the production handler, which is what makes "the run I
 * dry-ran is the run I got" checkable later rather than promised now.
 *
 * What a dry run answers: which effects run and in what order, which agents get spawned and on what
 * permits, and which checkpoints a human will be asked to sit in front of. That last one is the
 * point of the feature. A program that quietly stops on a checkpoint at 3am is a fact worth having
 * before the run starts, not after.
 */

import { run } from "./interpret.js";
import { SimHandler, type SimScript } from "./sim.js";
import { stepKeyString } from "./keys.js";
import type { Journal } from "./journal.js";
import type {
  AgentHandleValue,
  AskRequest,
  ChannelHandleValue,
  CheckpointRequest,
  CheckpointRaw,
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

/** One effect, in the order the run reached it. */
export interface PlannedEffect {
  readonly step: string;
  readonly kind: string;
  readonly name: string;
  /** `ok`, `failed`, or `cancelled`. A cancelled branch is part of the plan and says so. */
  readonly status: string;
}

/** An agent the program would spawn, with the permits it would hold. */
export interface PlannedAgent {
  readonly persona: string;
  readonly worktree?: string;
  readonly role?: string;
  readonly permits?: Readonly<Record<string, unknown>>;
  readonly joins: readonly string[];
}

/** A point where the run stops and waits for a person. */
export interface PlannedCheckpoint {
  readonly step: string;
  readonly name: string;
  readonly prompt: string;
  readonly timeout?: string;
  readonly onExpiry?: string;
  readonly to?: string;
}

export interface DryRunReport {
  readonly effects: readonly PlannedEffect[];
  readonly agents: readonly PlannedAgent[];
  readonly checkpoints: readonly PlannedCheckpoint[];
  /** Total virtual time the simulated run consumed, in ms. */
  readonly elapsedMs: number;
  readonly steps: number;
  /**
   * Script entries the run never reached, usually a renamed step. Surfaced in the report rather
   * than left for someone to ask about: a script that silently stops matching is a test that
   * silently stops testing.
   */
  readonly unusedScript: readonly string[];
  readonly journal: Journal;
}

/**
 * Wrap a handler so every request through it is recorded, and delegate everything unchanged.
 *
 * Deliberately NOT a `SimHandler` subclass. A dry run over the production handler is the thing
 * that makes the report worth trusting, and inheritance would tie it to simulation forever.
 */
export class RecordingHandler implements EffectHandler {
  readonly spawns: SpawnRequest[] = [];
  readonly checkpointsAsked: { req: CheckpointRequest; step: string }[] = [];

  constructor(private readonly inner: EffectHandler) {}

  now(): number {
    return this.inner.now();
  }

  async spawn(req: SpawnRequest, ctx: EffectContext): Promise<AgentHandleValue> {
    this.spawns.push(req);
    return await this.inner.spawn(req, ctx);
  }

  async checkpoint(req: CheckpointRequest, ctx: EffectContext): Promise<CheckpointRaw> {
    this.checkpointsAsked.push({ req, step: stepKeyString(ctx.key) });
    return await this.inner.checkpoint(req, ctx);
  }

  async turn(req: TurnRequest, ctx: EffectContext): Promise<TurnResultValue> {
    return await this.inner.turn(req, ctx);
  }
  async ask(req: AskRequest, ctx: EffectContext): Promise<unknown> {
    return await this.inner.ask(req, ctx);
  }
  async sleep(req: SleepRequest, ctx: EffectContext): Promise<null> {
    return await this.inner.sleep(req, ctx);
  }
  async wait(req: WaitRequest, ctx: EffectContext): Promise<unknown | null> {
    return await this.inner.wait(req, ctx);
  }
  async notify(req: NotifyRequest, ctx: EffectContext): Promise<null> {
    return await this.inner.notify(req, ctx);
  }
  async monitor(req: MonitorRequest, ctx: EffectContext): Promise<null> {
    return await this.inner.monitor(req, ctx);
  }
  async openConclave(req: ConclaveRequest, ctx: EffectContext): Promise<ChannelHandleValue> {
    return await this.inner.openConclave(req, ctx);
  }
  async closeConclave(req: ConclaveRequest, ctx: EffectContext): Promise<null> {
    return await this.inner.closeConclave(req, ctx);
  }
}

export interface DryRunOptions {
  readonly runId?: string;
  readonly seed?: string;
  readonly file?: string;
  readonly stepBudget?: number;
  readonly yieldEvery?: number;
}

/**
 * Simulate `source` under `script` and report what it would do.
 *
 * The simulator refuses any unscripted effect (L6001), so a dry run of a program whose script does
 * not cover it FAILS rather than reporting a shorter plan. That is the intended behaviour and it is
 * the whole reason to trust the output: a report that stopped early and said so is useful, and one
 * that quietly described half a program would be worse than no report.
 */
export async function dryRun(
  source: string,
  script: SimScript = {},
  options: DryRunOptions = {},
): Promise<DryRunReport> {
  const sim = new SimHandler(script);
  const startedAt = sim.now();
  const recorder = new RecordingHandler(sim);

  const result = await run(source, {
    runId: options.runId ?? "dry-run",
    handler: recorder,
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
    ...(options.file !== undefined ? { file: options.file } : {}),
    ...(options.stepBudget !== undefined ? { stepBudget: options.stepBudget } : {}),
    ...(options.yieldEvery !== undefined ? { yieldEvery: options.yieldEvery } : {}),
  });

  const effects: PlannedEffect[] = result.journal.entries().map((e) => ({
    step: `${e.scope}/${e.kind}${e.name === "" ? "" : `:${e.name}`}#${e.occurrence}`,
    kind: e.kind,
    name: e.name,
    status: e.status ?? e.state,
  }));

  const agents: PlannedAgent[] = recorder.spawns.map((s) => ({
    persona: s.persona,
    ...(s.worktree !== undefined ? { worktree: s.worktree } : {}),
    ...(s.role !== undefined ? { role: s.role } : {}),
    ...(s.permits !== undefined ? { permits: s.permits } : {}),
    joins: (s.join ?? []).map((c) => c.channel),
  }));

  const checkpoints: PlannedCheckpoint[] = recorder.checkpointsAsked.map(({ req, step }) => {
    const name = step.slice(step.lastIndexOf(":") + 1, step.lastIndexOf("#"));
    return {
      step,
      name,
      prompt: req.prompt,
      ...(req.timeout !== undefined ? { timeout: req.timeout } : {}),
      ...(req.onExpiry !== undefined ? { onExpiry: req.onExpiry } : {}),
      ...(req.to !== undefined ? { to: req.to } : {}),
    };
  });

  return {
    effects,
    agents,
    checkpoints,
    elapsedMs: sim.now() - startedAt,
    steps: result.steps,
    unusedScript: sim.unusedScript(),
    journal: result.journal,
  };
}

/** Render a report for a human. The order is the order the run would take. */
export function renderReport(report: DryRunReport): string {
  const out: string[] = [];
  const dur = (ms: number): string => {
    if (ms < 1_000) return `${ms}ms`;
    if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
  };

  out.push(`Dry run: ${report.effects.length} effects, ${report.agents.length} agents, ${dur(report.elapsedMs)} of simulated time.`);

  if (report.checkpoints.length > 0) {
    // First, and named as a person's problem rather than a step type. This is the part of the
    // report someone acts on before starting the run.
    out.push("", `A person is asked ${report.checkpoints.length} time(s):`);
    for (const c of report.checkpoints) {
      const on = c.onExpiry === undefined ? "" : `, then ${c.onExpiry}`;
      const t = c.timeout === undefined ? "waits indefinitely" : `waits ${c.timeout}${on}`;
      out.push(`  ${c.name}   "${c.prompt}"   (${t})`);
    }
  } else {
    out.push("", "No checkpoints: this run never stops for a person.");
  }

  if (report.agents.length > 0) {
    out.push("", "Agents:");
    for (const a of report.agents) {
      const bits = [
        a.worktree === undefined ? null : `worktree ${a.worktree}`,
        a.role === undefined ? null : `role ${a.role}`,
        a.permits === undefined ? null : `permits ${JSON.stringify(a.permits)}`,
        a.joins.length === 0 ? null : `joins ${a.joins.join(", ")}`,
      ].filter((x) => x !== null);
      out.push(`  ${a.persona}${bits.length === 0 ? "" : `   ${bits.join("   ")}`}`);
    }
  }

  out.push("", "Effects, in order:");
  for (const e of report.effects) {
    out.push(`  ${e.status === "ok" ? " " : "!"} ${e.step}${e.status === "ok" ? "" : `   ${e.status}`}`);
  }

  if (report.unusedScript.length > 0) {
    out.push("", `Script entries never reached: ${report.unusedScript.join(", ")}`);
  }
  return out.join("\n");
}
