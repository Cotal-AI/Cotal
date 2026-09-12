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
      /**
       * Which answer the settle accepted. Every resolver presents as the run driver, so the
       * arbiter has to NAME its choice: a principal cannot discriminate between two answers.
       *
       * NOTHING IN THIS PACKAGE SETS IT. The binding between an answer id and a settle fact lives
       * in the substrate the mesh handler talks to, which is a v0.4 delta this package does not
       * carry; the field is here so the journal preserves what a production handler reports rather
       * than dropping it, and the simulator deliberately never invents one. Read an absent
       * `answerId` as "this handler does not name its answers", never as "the answer was anonymous".
       */
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

/**
 * ONE observation of something outside the mesh, asked for by {@link EffectHandler.observe}.
 *
 * The handler's whole job here is the WAITING, not the looking: the probe belongs to the program
 * and the interpreter calls it. What the handler owns is the cadence (sleep `every` between
 * observations, durably, so a host that dies mid-cadence does not lose the wait) and the answer to
 * "is there any time left". That split is what keeps the predicate in the program where an author
 * can read it, and the durability in the host where it belongs.
 */
export interface ObserveRequest {
  /** The step's own name, for tracing and for the operator surface. A handler never keys on it. */
  readonly name: string;
  /**
   * The cadence between observations, ALWAYS present, including on the first observation, which
   * does not wait.
   *
   * "Absent means do not wait" was the first shape and it was wrong in a way worth recording: the
   * cadence is a property of the STEP, so a request that dropped it on the first observation left
   * every operator surface and every dry-run plan reporting the cadence as unknown for exactly the
   * request they see first. `attempt` already says which observation this is, so the handler has
   * the fact it needs to skip the first wait without the cadence having to disappear to say so.
   */
  readonly every: string;
  /** The absolute instant the wait fails at, already resolved against the recorded start. */
  readonly deadlineAt: number;
  /**
   * The deadline AS THE PROGRAM WROTE IT, beside the absolute instant rather than instead of it.
   *
   * The instant is what a handler compares against and the only form that survives a resume
   * correctly; the duration is what an operator surface and a dry-run plan can show. Deriving
   * either from the other needs the step's start, which a handler does not hold, so carrying both
   * is what keeps a plan from having to guess.
   */
  readonly deadline: string;
  /**
   * Which observation this is, counted from 0.
   *
   * ATTEMPT 0 DOES NOT WAIT. A wait that sleeps before it has ever looked cannot notice a
   * predicate that already holds, and "are the checks finished" is very often already true when
   * the run asks. So a handler waits `every` before observations 1, 2, 3 and returns immediately
   * for 0. It is counted from the RECORDED observations, so a resumed wait continues its count
   * rather than restarting it, and a resume therefore does not get a free immediate look on every
   * activation.
   */
  readonly attempt: number;
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

// ---- the ask schema shorthand -----------------------------------------------------------------

/**
 * The reply contract a reference handler enforces on `ask`. The language itself leaves `schema`
 * opaque (it is hashed and handed over unchanged, §6.5); this shorthand is the handler-side
 * contract: a record mapping each required top-level field of the reply to one of six kind
 * names. A reply must be a record; extra fields are allowed; a missing or mistyped declared
 * field makes the reply non-conforming, which costs one attempt.
 */
export type AskFieldKind = "string" | "number" | "boolean" | "array" | "record" | "null";

const ASK_FIELD_KINDS: readonly string[] = ["string", "number", "boolean", "array", "record", "null"];

/**
 * Read a schema as the shorthand, or return null for one this contract cannot read. A handler
 * that enforces the shorthand refuses an unreadable schema (L4022) rather than skipping it: a
 * schema the program wrote and nobody checks is worse than a loud refusal.
 */
export function askSchemaShape(schema: unknown): Readonly<Record<string, AskFieldKind>> | null {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return null;
  const out: Record<string, AskFieldKind> = {};
  for (const [field, kind] of Object.entries(schema)) {
    if (typeof kind !== "string" || !ASK_FIELD_KINDS.includes(kind)) return null;
    out[field] = kind as AskFieldKind;
  }
  return out;
}

/** Whether a reply conforms: a record carrying every declared field with its declared kind. */
export function conformsToAskSchema(
  value: unknown,
  shape: Readonly<Record<string, AskFieldKind>>,
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const [field, kind] of Object.entries(shape)) {
    const v = record[field];
    if (kind === "string" && typeof v !== "string") return false;
    if (kind === "number" && typeof v !== "number") return false;
    if (kind === "boolean" && typeof v !== "boolean") return false;
    if (kind === "array" && !Array.isArray(v)) return false;
    if (kind === "record" && (typeof v !== "object" || v === null || Array.isArray(v))) return false;
    if (kind === "null" && v !== null) return false;
  }
  return true;
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
 * The host is stopping before the next effect, and the program is not at fault.
 *
 * A driver holds a run under a lease with an absolute horizon, and it may be asked to hand the run
 * back. Neither is a fact about the workflow: it has not failed and it has not finished, it is
 * exactly where its journal says it is. So this is raised BEFORE an effect is begun — never once a
 * handler has been dispatched — and it travels like {@link Cancelled} and `JournalAppendRejected`:
 * a workflow's `try` cannot catch it. A program that could catch its host's shutdown could carry on
 * performing effects after the horizon it was granted, which is the thing the stop exists to end.
 *
 * The language raises it; it never accepts it from outside. A caller answers only "should I stop,
 * and why" — if a driver could throw the class itself it could also throw something catchable, and
 * the guarantee would be the caller's to keep rather than the language's.
 */
export class RunReleased extends Error {
  readonly code = "L5012";

  constructor(readonly reason: string) {
    super(`this run was released before its next effect: ${reason}`);
    this.name = "RunReleased";
  }
}

/**
 * A handler's refusal to perform an effect this host has no substrate for.
 *
 * Not a failure, and the distinction is durable: nothing was attempted, so settling the entry
 * `failed` would replay a failure forever for work the world never saw. A handler throws this,
 * the interpreter settles the entry `refused` — keeping the code the handler raised, L5016 for
 * the reference handler — and halts the run with {@link RunHeld}. A later resume finds the
 * `refused` entry and performs the step live, as a fresh attempt, which is how a run started
 * before a substrate landed heals the day it does.
 */
export class EffectRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EffectRefused";
  }
}

/**
 * The halt a refusal unwinds the run with (L5025).
 *
 * It travels like {@link RunReleased}: a workflow's `try` cannot catch it and `finally` does not
 * run on the way out (§9.2). The program is not at fault and has not failed; the run is exactly
 * where its journal says it is, holding one `refused` entry, and the repair is a capable host
 * rather than anything the program could do with one more effect. Like {@link RunReleased}, the
 * language raises it and never accepts it from outside.
 */
export class RunHeld extends Error {
  readonly code = "L5025";

  constructor(
    readonly step: string,
    /** The refusal's own message. Named `reason` so it crosses the worker boundary like {@link RunReleased.reason}. */
    readonly reason: string,
  ) {
    super(
      `L5025 Effect refused; run held for a capable host\n\n  step  ${step}\n\n${reason}\n\n` +
        `The step was never attempted: its entry is settled \`refused\`, and a resume on a host ` +
        `that can perform it picks the run up exactly here.`,
    );
    this.name = "RunHeld";
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
   * Which attempt of this step {@link EffectContext.requestId} names, counted from 0.
   *
   * Only an escalating checkpoint ever exceeds 0, and it is the interpreter, not the handler, that
   * decides whether to hop. A handler reads this for tracing and for the far side's own idempotency
   * bookkeeping; it must not treat a non-zero attempt as licence to retry, because the attempt that
   * is open is the only one it has been asked to complete.
   */
  readonly attempt: number;
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
  /**
   * Hold the run until it is time to observe again, and say whether there was time.
   *
   * `true` means "observe now"; `false` means the deadline passed while waiting, and the
   * interpreter raises the catchable L4023. The handler never evaluates the predicate and never
   * sees the observation: the probe is the program's, the interpreter calls it, and this is only
   * the durable pause between two calls. A handler with no durable timer may implement it with
   * whatever it has — the simulator parks on its virtual clock — and one that cannot wait durably
   * at all should refuse with {@link EffectRefused} rather than busy-wait, exactly as any other
   * effect it has no substrate for.
   */
  observe(req: ObserveRequest, ctx: EffectContext): Promise<boolean>;
  notify(req: NotifyRequest, ctx: EffectContext): Promise<null>;
  monitor(req: MonitorRequest, ctx: EffectContext): Promise<null>;
  openConclave(req: ConclaveRequest, ctx: EffectContext): Promise<ChannelHandleValue>;
  closeConclave(req: ConclaveRequest, ctx: EffectContext): Promise<null>;
}
