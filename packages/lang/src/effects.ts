/**
 * The effect interface: one seam, two implementations.
 *
 * A handler is told to do a thing and reports what happened. It never touches the journal. That
 * split is what makes the simulator a real test harness rather than a second implementation to
 * keep in sync: every durability rule holds identically under simulation and production, because
 * the interpreter, not the handler, is what enforces them.
 *
 * The simulation handler lives in this package. The production handler binds these calls onto the
 * mesh (goals, checkpoints, work leases) and lives outside it, so this package stays pure.
 */

import type { StepKey } from "./keys.js";

// ---- values that cross the boundary ---------------------------------------------------------

/**
 * A handle's journalled form is a stable, site-independent reference: an agent's persistent
 * identity, a channel's name, a run id. Never a session id, a file descriptor, or a host path.
 * A run that resumes on another machine has to mean the same thing by every binding it holds,
 * and a host-local pointer in journalled state is exactly how that stops being true.
 */
export interface AgentHandleValue {
  readonly agent: string;
  readonly persona: string;
  readonly worktree?: string;
  readonly role?: string;
}

export interface ChannelHandleValue {
  readonly channel: string;
}

export type TurnStatus = "done" | "blocked" | "handoff";

export interface TurnResultValue {
  readonly status: TurnStatus;
  readonly to?: AgentHandleValue;
  readonly note?: string;
  readonly at: number;
}

/**
 * WHAT HAPPENED, which is all a handler is allowed to decide.
 *
 * A handler never chooses whether an expiry is returned or thrown. It reports the raw outcome, the
 * interpreter journals THAT, and the disposition is computed from today's source afterwards, on
 * the live path and the replay path alike (see applyCheckpointPolicy).
 *
 * Written the other way round the reapply rule cannot work at all, and this package shipped it
 * that way for a day: a handler that throws L4007 makes the journal record `failed`, and a replay
 * under an edited `proceed` then has nothing but an error to reinterpret. A policy applied before
 * the journal is a policy baked into the record.
 */
export type CheckpointRaw =
  | {
      readonly outcome: "resolved";
      readonly value?: unknown;
      readonly artifact?: string;
      readonly by?: string;
      readonly at: number;
      /** Which answer the settle accepted. Every resolver presents as the run driver, so the
       *  arbiter has to NAME its choice: a principal cannot discriminate between two answers. */
      readonly answerId?: string;
    }
  | { readonly outcome: "expired"; readonly at: number };

export interface CheckpointResultValue {
  readonly status: "resolved" | "expired";
  readonly value?: unknown;
  readonly by?: string;
  readonly at: number;
  readonly artifact?: string;
}

/** An event descriptor. Pure: building one performs no effect. */
export type EventDescriptor =
  | { readonly event: "replied"; readonly agent: string }
  | { readonly event: "message"; readonly channel: string; readonly from?: string; readonly matches?: string }
  | { readonly event: "idle"; readonly channel: string; readonly duration: string }
  | { readonly event: "down"; readonly agent: string };

/** A notify fact: a bounded decision record, never a message. See NOTIFY_BOUND. */
export interface NotifyFact {
  readonly decision: string;
  readonly outcome: string;
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

// ---- requests --------------------------------------------------------------------------------

export interface SpawnRequest {
  readonly persona: string;
  readonly model?: string;
  readonly variant?: string;
  readonly worktree?: string;
  readonly join?: readonly ChannelHandleValue[];
  readonly role?: string;
  readonly permits?: Readonly<Record<string, unknown>>;
  readonly supervise?: Readonly<Record<string, unknown>>;
  /** What a fork does with this agent: spawn a fresh one, or reuse the original. Default respawn. */
  readonly onFork?: "respawn" | "adopt";
}

export interface TurnRequest {
  readonly agent: AgentHandleValue;
  readonly deadline?: string;
}

export interface AskRequest {
  readonly agent: AgentHandleValue;
  readonly schema: unknown;
  readonly deadline?: string;
  readonly attempts?: number;
}

export interface CheckpointRequest {
  readonly prompt: string;
  readonly schema?: unknown;
  readonly timeout?: string;
  readonly onExpiry?: "fail" | "proceed" | "escalate";
  readonly to?: string;
}

export interface SleepRequest {
  readonly duration: string;
}

export interface WaitRequest {
  readonly event: EventDescriptor;
  readonly timeout?: string;
}

export interface NotifyRequest {
  readonly agents: readonly AgentHandleValue[];
  readonly fact: NotifyFact;
}

export interface MonitorRequest {
  readonly agent: AgentHandleValue;
}

export interface ConclaveRequest {
  readonly members: readonly AgentHandleValue[];
  readonly channel?: string;
}

// ---- the handler contract ---------------------------------------------------------------------

/** Raised by a handler when an effect fails in a way the program can catch. */
export class EffectError extends Error {
  constructor(
    readonly code: string,
    readonly kind: string,
    message: string,
    readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "EffectError";
  }
}

/** Raised into a branch that a `race` loser or a run cancellation has cut short. */
export class Cancelled extends Error {
  constructor(readonly reason: string) {
    super(`cancelled: ${reason}`);
    this.name = "Cancelled";
  }
}

/**
 * Raw outcome to what the program sees, computed from TODAY's source.
 *
 * The same call runs on the live path and after a journal hit, which is the whole point: a resumed
 * run must reach this with the recorded fact and the current `onExpiry`, so editing `proceed` to
 * `fail` makes the resume throw even though nothing about the recorded expiry changed.
 *
 * `escalate` never arrives here. It mints an effect rather than choosing a disposition, so it is
 * hashed (design 5.12) and an edit to it diverges before any of this runs.
 */
export function applyCheckpointPolicy(
  raw: CheckpointRaw,
  onExpiry: "fail" | "proceed" | "escalate" | undefined,
): CheckpointResultValue {
  if (raw.outcome === "resolved") {
    return {
      status: "resolved",
      ...(raw.value !== undefined ? { value: raw.value } : {}),
      ...(raw.by !== undefined ? { by: raw.by } : {}),
      ...(raw.artifact !== undefined ? { artifact: raw.artifact } : {}),
      at: raw.at,
    };
  }
  // `escalate` reaching here means the chain is FINISHED: the interpreter already performed the
  // one hop, and a second expiry settles exactly as `proceed` would (design 5.5, one hop). Only
  // `fail` throws. Treating escalate as a throw made a completed escalation raise L4007, which is
  // the opposite of what the stop rule says happens.
  const disposition = onExpiry ?? "fail";
  if (disposition === "proceed" || disposition === "escalate") return { status: "expired", at: raw.at };
  throw new EffectError(
    "L4007",
    "checkpoint-expired",
    `L4007 Checkpoint expired\n\nNobody answered in time and this checkpoint's onExpiry is "fail".\n\nOptions\n  onExpiry: "proceed"    return { status: "expired" } and let the program decide\n  onExpiry: "escalate"   mint a second checkpoint addressed to someone else\n  raise the timeout`,
  );
}

export interface CancelSignal {
  readonly cancelled: boolean;
  readonly reason?: string;
  onCancel(fn: (reason: string) => void): void;
}

export interface EffectContext {
  /** The key of the step being performed. Handlers use it for tracing, never for lookup. */
  readonly key: StepKey;
  readonly signal: CancelSignal;
  /**
   * `base64url(sha256(runId, stepKey, inputHash, attempt))`, on the pending entry BEFORE this
   * handler was called. SUBMIT UNDER IT, idempotently: a resumed run reissues the same id and the
   * far side recognises it rather than creating a second goal. This is the identity that makes an
   * effect recoverable; {@link EffectContext.bind} carries facts the handler LEARNS and is never
   * what recovery keys on, because a crash before the handler learned them leaves none.
   */
  readonly requestId: string;
  /**
   * Present when a previous attempt at this step started but never settled, carrying whatever it
   * passed to {@link EffectContext.bind}. The handler must RE-BIND to that resource and await its
   * terminal, not issue a fresh action: the goal already exists, the checkpoint token is already
   * minted, and issuing a second one is how a crash turns into a duplicate side effect.
   */
  readonly resume?: Readonly<Record<string, unknown>>;
  /**
   * Declare the external resource this effect just created, BEFORE awaiting its terminal.
   *
   * This is what makes a crash mid-effect recoverable: the pending journal entry points at a
   * real thing, so a resumed run re-binds to it and awaits its outcome instead of issuing a
   * second action. Idempotency then comes from the layer underneath (a goal's bind fingerprint,
   * a checkpoint's one-use settle fact, a work item's lease).
   */
  bind(external: Readonly<Record<string, unknown>>): Promise<void>;
}

export interface EffectHandler {
  /**
   * The host clock, which the interpreter uses to stamp `startedAt` and `endedAt` on journal
   * entries. Production reads the wall clock; simulation reads a virtual one, which is how a
   * program that waits four hours is tested in microseconds without pretending the wait did not
   * happen. The program's own `now()` never reads this: it reads the run clock derived from
   * those journalled stamps, which is what makes time advance only at effect boundaries.
   */
  now(): number;

  spawn(req: SpawnRequest, ctx: EffectContext): Promise<AgentHandleValue>;
  turn(req: TurnRequest, ctx: EffectContext): Promise<TurnResultValue>;
  ask(req: AskRequest, ctx: EffectContext): Promise<unknown>;
  checkpoint(req: CheckpointRequest, ctx: EffectContext): Promise<CheckpointRaw>;
  sleep(req: SleepRequest, ctx: EffectContext): Promise<null>;
  wait(req: WaitRequest, ctx: EffectContext): Promise<unknown | null>;
  notify(req: NotifyRequest, ctx: EffectContext): Promise<null>;
  monitor(req: MonitorRequest, ctx: EffectContext): Promise<null>;
  openConclave(req: ConclaveRequest, ctx: EffectContext): Promise<ChannelHandleValue>;
  closeConclave(req: ConclaveRequest, ctx: EffectContext): Promise<null>;
}
