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
  spawn(req: SpawnRequest, ctx: EffectContext): Promise<AgentHandleValue>;
  turn(req: TurnRequest, ctx: EffectContext): Promise<TurnResultValue>;
  ask(req: AskRequest, ctx: EffectContext): Promise<unknown>;
  checkpoint(req: CheckpointRequest, ctx: EffectContext): Promise<CheckpointResultValue>;
  sleep(req: SleepRequest, ctx: EffectContext): Promise<null>;
  wait(req: WaitRequest, ctx: EffectContext): Promise<unknown | null>;
  notify(req: NotifyRequest, ctx: EffectContext): Promise<null>;
  monitor(req: MonitorRequest, ctx: EffectContext): Promise<null>;
  openConclave(req: ConclaveRequest, ctx: EffectContext): Promise<ChannelHandleValue>;
  closeConclave(req: ConclaveRequest, ctx: EffectContext): Promise<null>;
}
