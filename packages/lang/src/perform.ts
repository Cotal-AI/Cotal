/**
 * The effect seam, shared by both engines.
 *
 * {@link performEffect} is the durable core (key allocation, journal lookup and replay, the
 * pending protocol, the two failure domains), and {@link dispatchPrimitive} is the per-primitive
 * wiring from evaluated argument VALUES to the handler, with the hashed projections that decide
 * each effect's identity. The tree-walker (`interpret.ts`) delegates here; the v2 engine host
 * calls it directly. ONE function over ONE table: a second copy of a projection would be a
 * divergence the differential suite could only find program-by-program.
 */
import { InterpreterDefect, RunDivergence, RuntimeFault, ScopeBranchMissing, UnwalkableScope, isStackExhaustion, messageOf, stackOf } from "./errors.js";
import { atMostOnce, digest, holdRequestId, requestId, scopePathString, scopeTraits, stepKeyString, type JournalKind, type KeyScope, type PathKind, type ScopeFrame, type ScopeKind, type StepKey } from "./keys.js";
import { Journal, JournalAppendRejected, RunClock, type EntryError, type JournalEntry, type LookupVerdict } from "./journal.js";
import { NotCrossable, assertCrossable, assertScopeValueCrossable, deepFreeze } from "./values.js";
import { type EffectKind } from "./primitives.js";
import { simScopeFaults } from "./sim-scope-faults.js";
import {
  Cancelled,
  RunReleased,
  EffectRefused,
  RunHeld,
  EffectError,
  type AgentHandleValue,
  type CancelSignal,
  type ChannelHandleValue,
  type ConclaveRequest,
  type EffectContext,
  type CheckpointRaw,
} from "./effects.js";
import type { RunOptions } from "./interpret.js";

/**
 * The slice of a run the effect seam needs: the journal, the run options, the effect ceiling, and
 * the run-scoped dispatched-effect counter (mutable, because L4009 counts across activations).
 */
export interface EffectHost {
  readonly journal: Journal;
  readonly options: RunOptions;
  readonly ceiling: number;
  effectCount: number;
  readonly kindCounts: Map<EffectKind, number>;
}

/**
 * The slice of a frame an effect needs. The walker's `Frame` satisfies it structurally; so do the
 * engine host's frames.
 */
export interface EffectFrame {
  readonly keys: KeyScope;
  readonly clock: RunClock;
  readonly signal: CancelSignal;
}

export function option(bag: unknown, key: string): unknown {
  return bag === null || typeof bag !== "object" ? undefined : (bag as Record<string, unknown>)[key];
}

/** Check the handle's value shape. The host still enforces ownership and lifecycle identity. */
export function agentHandle(value: unknown, where: string): AgentHandleValue {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const r = value as Record<string, unknown>;
    if (typeof r.agent === "string" && r.agent.length > 0 && typeof r.persona === "string"
      && (r.kind === undefined || r.kind === "spawned" || r.kind === "participant")) return value as AgentHandleValue;
  }
  throw new RuntimeFault("L3050", `${where} requires an agent handle returned by \`spawn\` or \`participant\`, not an agent name or another value. Pass the returned handle instead.`);
}

/** Validate a list before a scope or effect projects its members into journal identity. */
export function agentHandles(value: unknown, where: string): AgentHandleValue[] {
  if (!Array.isArray(value)) throw new RuntimeFault("L3050", `${where} requires an array of agent handles returned by \`spawn\` or \`participant\`. Pass the returned handles instead of agent names.`);
  return value.map((member, i) => agentHandle(member, `${where}[${i}]`));
}
/**
 * An `EffectError`'s `detail` is a RECORDED VALUE, and until this function it was the last one with
 * no domain check on it.
 *
 * Measured, with the binding guard already in place: a handler throwing
 * `new EffectError("L6002", …, { cb: () => 1 })` from a step the program CATCHES leaves a run that
 * SUCCEEDS while its journal carries a function. In-process that is merely wrong; through the worker
 * the whole journal is structured-cloned back to the host, so the same run dies on a DataCloneError.
 * A failing run never posts its entries, because the worker hand-builds `{ok,code,name,message}` on
 * that path, so a caught failure on the success path is the route, and it is a real program, not a
 * contrived one.
 *
 * WHAT A REFUSAL COSTS, said out loud because it is a real cost: the handler's own classification is
 * dropped. An error whose report cannot be recorded is recorded as what it is, a fault of the
 * handler's, L4000, naming both the original message and why the detail could not be kept. Keeping
 * `code` while silently dropping `detail` was the other option and it is the fallback this repo does
 * not do: the program would catch an L6002 whose recorded form is missing the field the handler sent
 * it to explain itself.
 */
function recordableError(e: EffectError, kind: string): { readonly error: EntryError; readonly faithful: boolean } {
  if (e.detail === undefined) return { error: { code: e.code, kind: e.kind, message: e.message }, faithful: true };
  try {
    assertCrossable(e.detail, "the detail of this failure");
    return { error: { code: e.code, kind: e.kind, message: e.message, detail: e.detail }, faithful: true };
  } catch (cause) {
    if (!(cause instanceof NotCrossable)) throw cause;
    return {
      error: { code: "L4000", kind, message: `${e.message} (and its detail could not be recorded: ${cause.message})` },
      faithful: false,
    };
  }
}

/**
 * L4028: an effect kind `once` does not admit, or a scope that dispatches (spec/cotal-lang.md §7.8),
 * refused before its entry begins, so no handler method is called and a resume reaches the same
 * refusal.
 */
export function notHoldable(kind: JournalKind, path: readonly ScopeFrame[]): RuntimeFault {
  return new RuntimeFault(
    "L4028",
    `\`${kind}\` runs inside \`once\` at ${scopePathString(path)}, and \`once\` admits only \`ask\`: a resume could not hold any other kind without dispatching it again or losing run state it builds. Move the \`${kind}\` outside the \`once\` that wraps the write.`,
  );
}

/** L4011 for `once`'s body, raised by both engines before the scope's entry begins. */
export function onceBodyNotCallable(): RuntimeFault {
  return new RuntimeFault("L4011", "the body of `once` is not a function, so it cannot be called");
}

/**
 * Count one live dispatch against the run's effect ceiling (L4009), before its entry is begun so a
 * dispatch the ceiling stops leaves no pending entry for work nobody performed. Every path that
 * dispatches counts here, because `Journal.dispatchedEffects` seeds the next activation from the
 * entries those paths write, and a fresh run and a resumed one must reach the ceiling at the same step.
 * Only a `miss` counts: a pending or refused key is already in that seed, and counting its
 * re-entry again would fault a resumed run at a step where a fresh one goes on.
 */
function countEffect(host: EffectHost, verdict: LookupVerdict, kind: EffectKind): void {
  if (verdict.verdict !== "miss") return;
  const limit = host.options.pins?.ceilings?.[kind];
  const count = limit === undefined ? undefined : host.kindCounts.get(kind) ?? host.journal.dispatchedEffects(kind);
  if (limit !== undefined && count !== undefined && count >= limit)
    throw new RuntimeFault("L4029", `This run has reached its pinned ${kind} ceiling of ${limit}. No new ${kind} effect was dispatched. Other effect kinds keep their own limits.`);
  chargeEffect(host);
  if (count !== undefined) host.kindCounts.set(kind, count + 1);
}

/**
 * Charge one dispatch against the run's effect ceiling (L4009). A recorded `waitUntil` look after the
 * first is charged here too, and only here: a pinned kind ceiling limits dispatches, not looks.
 */
export function chargeEffect(host: EffectHost): void {
  if (host.effectCount >= host.ceiling) {
    throw new RuntimeFault(
      "L4009",
      `this run has reached its ceiling of ${host.ceiling} effects, including recorded wait observations. Bound loops and waits, or ask the embedder for a higher effect ceiling.`,
    );
  }
  host.effectCount += 1;
}

/**
 * Admit one live dispatch: the checks it passes after every replay verdict has been served and
 * before its entry is begun. Every path that dispatches calls this, {@link enterStep} for an effect
 * and {@link performScope} for a scope that dispatches, so a rule about admitting a dispatch cannot
 * reach one path and miss another.
 */
function admitDispatch(host: EffectHost, frame: EffectFrame, verdict: LookupVerdict, kind: EffectKind): void {
  // A cancelled branch performs no NEW effects. That is the whole of the cancellation law on
  // this side: work already in flight is another matter, and the handler owns it.
  if (frame.signal.cancelled) {
    throw new Cancelled(frame.signal.reason ?? "cancelled");
  }

  // THE HOST'S STOP, asked before anything is begun and after every replay has been served. A
  // driver holds its run under an absolute work horizon and may be asked to hand it back, and
  // neither is a fact about the program, so the place to stop is here, where no entry has been
  // written and no handler dispatched. One step later would mean a pending entry for work nobody
  // performed; inside the handler would mean settling a failure for work that really happened.
  // Replays are deliberately unaffected: replaying a recorded prefix performs nothing, and a run
  // that stopped mid-journal has to be able to walk back to where it stopped.
  const stop = host.options.shouldStop?.();
  if (stop !== undefined) {
    throw new RunReleased(stop);
  }

  countEffect(host, verdict, kind);
}

/** A live step: its entry is begun (or recovered) and its handler context is ready. */
export type LiveStep = {
  readonly key: StepKey;
  readonly inputHash: string;
  /** The entry a previous activation began and never settled, when this one is recovering it. */
  readonly pending: JournalEntry | undefined;
  readonly ctx: EffectContext;
};

/**
 * Enter one step: allocate its key, serve or throw what the journal recorded for it, and otherwise
 * run the checks that guard a new dispatch, begin its entry and hand the live step to `live`, which
 * must reach its dispatch before its first await.
 *
 * ONE ENTRY FOR EVERY EFFECT, `waitUntil` included. A wait cannot go through {@link performEffect}
 * as a whole, because a non-terminal observation leaves its entry pending, but nothing before its
 * first observation differs, and a second copy of these rules is one that can change alone and
 * leave one kind replaying, stopping or recovering differently from the rest.
 */
export async function enterStep(
  host: EffectHost,
  kind: EffectKind,
  name: string,
  hashedInput: unknown,
  frame: EffectFrame,
  live: (step: LiveStep) => Promise<unknown>,
): Promise<unknown> {
  const key = frame.keys.nextEffect(kind, name);
  const inputHash = digest(hashedInput ?? null);
  const verdict = host.journal.lookup(key, inputHash);

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
    // A REFUSED step was never attempted (§10.7): the entry records that no host could perform
    // it yet, and this activation gets to try. Falls to the live path, where `begin` writes a
    // fresh pending row over the refusal.
    case "refused":
    case "pending":
    case "miss":
      break;
  }

  admitDispatch(host, frame, verdict, kind);

  // RECOVERY SUBMITS UNDER THE RECORDED IDENTITY. Re-deriving happens to agree whenever nothing
  // moved, which is exactly why it read as correct: the whole point of writing the id down is
  // the case where it does NOT agree, and a resumed run that re-derives is reissuing under an
  // identity the far side may never have seen. An entry with no recorded id predates this rule.
  const pending = verdict.verdict === "pending" ? verdict.entry : undefined;
  const recorded = pending?.requestId !== undefined ? pending : undefined;
  const reqId = recorded?.requestId ?? requestId(host.options.runId, key, inputHash);
  // WHICH attempt is open, not merely which id. An id alone cannot say how much of an escalation
  // chain is already spent, and a recovery that cannot tell replays the hop: it mints again under
  // the id the far side already holds and reads that mint's cached expiry back as a fresh
  // observation. An entry written before the index existed reads as attempt 0, which is what it
  // is for every effect that never hops.
  const attempt = recorded?.attempt ?? 0;
  if (verdict.verdict === "miss" || verdict.verdict === "refused") {
    // AWAITED, and the await is the point: the request id the handler is about to submit under
    // has to be durable BEFORE the work is issued, or a crash in the gap leaves real work that
    // nothing in the journal names.
    await host.journal.begin(key, inputHash, host.options.handler.now(), reqId);
    // THE AWAIT ABOVE IS A GAP, and the cancellation law has to hold on both sides of it. The
    // check before `begin` sees the world as it was when this step started; while the append was
    // in flight a sibling can settle the race and cancel this branch. Measured before this line:
    // the loser's effect was still dispatched, performed against the world, and recorded `ok`,
    // a NEW effect by a cancelled branch, which is the one thing the law forbids. The pending
    // entry is real (the append happened), so it settles as what this branch now is: cancelled.
    if (frame.signal.cancelled) {
      await host.journal.settle(key, { status: "cancelled" }, host.options.handler.now());
      throw new Cancelled(frame.signal.reason ?? "cancelled");
    }
  }

  const ctx: EffectContext = {
    key,
    signal: frame.signal,
    // Derived from the run, the step, the inputs and the attempt, and written on the pending
    // entry by `begin` above BEFORE the handler runs. A handler submits under it idempotently,
    // so a resumed run reissues the same id rather than creating a second goal.
    requestId: reqId,
    attempt,
    ...(pending?.external !== undefined ? { resume: pending.external } : {}),
    // THE THIRD PATH INTO AN ENTRY, and until this line the only one with no rule. The other two sit
    // a few lines apart (the RESULT at the settle below, the ARGUMENTS in `dispatchPrimitive`), and
    // a handler's own `ctx.bind` reached `journal.bind` with nothing in between. Measured before this
    // line, on both engines: a handler binding `{ when: new Date(0), n: -0, bad: NaN, gone: undefined }`
    // recorded all four, and the durable store gives them back as a string, `0`, `null` and an absent
    // key, so the value a resume RE-BINDS to was not the value that was bound.
    //
    // CANONICAL, NOT ROUND-TRIP-EXACT, and the difference matters to whoever reads this next. `-0` is
    // the one value this rule ADMITS that JSON still flattens, and the step key's own input hash
    // equates it with `0` (`digest({n:-0}) === digest({n:0})`; the 1-vs-2 and -1-vs-1 controls
    // differ). The promise here is that a binding HAS a canonical form, not that it survives a store
    // byte for byte.
    //
    // Inside the handler's dispatch `try` by construction, so a refusal settles the entry FAILED
    // through the existing L4000 handler-fault family and needs no code of its own.
    bind: async (external) => {
      assertCrossable(external, `the binding of ${stepKeyString(key)}`);
      await host.journal.bind(key, external);
    },
  };
  // CALLED, NOT RETURNED. The cancellation check above has to share a synchronous turn with the
  // dispatch it guards. Handing the step back to an awaiting caller reopens the gap that check
  // closes: measured that way, a race's loser was dispatched with its signal already cancelled and
  // settled `ok`.
  return await live({ key, inputHash, pending, ctx });
}

/**
 * Perform one effect, or replay it.
 *
 * Everything durable happens here. A handler is called only in the `miss` and `pending` cases,
 * and in `pending` it is told to re-bind rather than re-issue.
 */
export async function performEffect(
  host: EffectHost,
  kind: EffectKind,
  name: string,
  hashedInput: unknown,
  perform: (ctx: EffectContext, inputHash: string) => Promise<unknown>,
  frame: EffectFrame,
): Promise<unknown> {
  return await enterStep(host, kind, name, hashedInput, frame, (step) => dispatchStep(host, step, perform, frame));
}

/**
 * Dispatch a live step's handler and settle its entry with the outcome, or open the hold of a
 * pending step that `once` forbids dispatching again.
 */
async function dispatchStep(
  host: EffectHost,
  { key, inputHash, pending, ctx }: LiveStep,
  perform: (ctx: EffectContext, inputHash: string) => Promise<unknown>,
  frame: EffectFrame,
): Promise<unknown> {
  // AT MOST ONCE (spec/cotal-lang.md §7.8): a pending step under `once` may already have written,
  // so it is never dispatched again. Its outcome is unknown, and a hold asks for it.
  if (pending !== undefined && atMostOnce(key.scope)) return await performHold(host, key, ctx.requestId, pending.hold, frame);

  // TWO FAILURE DOMAINS, AND THE TERMINAL APPEND IS NOT IN THE HANDLER'S.
  //
  // One `try` around both the dispatch and the settle produces the worst bug a journal can have:
  // the handler completes, the store refuses the settling append, the catch below records that
  // refusal as a handler fault, and the durable sequence becomes `[pending, settled:failed]` for
  // work the world actually did, so every later replay reports failure for a real success. The
  // handler's outcome is decided first, alone, and the append that records it happens outside,
  // where a rejection is a durability failure that travels as itself and settles nothing.
  let result: unknown;
  try {
    result = await perform(ctx, inputHash);
    assertCrossable(result, `the result of ${stepKeyString(key)}`);
  } catch (e) {
    return await settleDispatchThrown(host, key, frame, e, host.options.handler.now());
  }

  const endedAt = host.options.handler.now();
  await host.journal.settle(key, { status: "ok", result: deepFreeze(result) }, endedAt);
  frame.clock.advance(endedAt);
  return result;
}

/** Settle a failed effect or observation dispatch, including a host's refusal to attempt it. */
export async function settleDispatchThrown(host: EffectHost, key: StepKey, frame: EffectFrame, e: unknown, endedAt: number): Promise<never> {
  // A REFUSAL IS NOT A FAILURE. The handler attempted nothing, so recording `failed` would
  // replay a failure forever for work the world never saw (measured: the mesh handler's L5016
  // settled `failed`, and a run started before the durable-action surface landed could never
  // heal). The entry settles `refused` under the handler's own code, and the run halts with
  // the uncatchable L5025: a capable host's resume finds the refusal and performs the step.
  if (e instanceof EffectRefused) {
    await host.journal.settle(
      key,
      { status: "refused", error: { code: e.code, kind: "refused", message: e.message } },
      endedAt,
    );
    throw new RunHeld(stepKeyString(key), e.message);
  }
  return await settleThrown(host, key, frame, e, endedAt);
}

/**
 * Settle a step whose dispatch threw anything but a refusal, and rethrow what the program sees.
 * Effects and `waitUntil` share {@link settleDispatchThrown}; {@link performHold} keeps its own
 * refusal rule so an at-most-once step stays pending.
 */
async function settleThrown(host: EffectHost, key: StepKey, frame: EffectFrame, e: unknown, endedAt: number): Promise<never> {
  // A journal that just refused an append cannot be asked to record why. It leaves by its own
  // door, unwrapped, before anything tries to settle on top of it.
  if (e instanceof JournalAppendRejected) throw e;
  if (e instanceof Cancelled) {
    await host.journal.settle(key, { status: "cancelled" }, endedAt);
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
  const recorded = e instanceof EffectError ? recordableError(e, "handler-fault") : undefined;
  // THE STACK IS THE ONLY FIELD THAT NAMES THE HOST CODE. A handler fault happens outside both the
  // program and the language, so `message` alone ("timeout") is the symptom with no origin, and
  // the durable entry is usually the only look anyone gets at it. Read defensively, by the same
  // rule as `messageOf` one line up: a primitive throw carries no stack and none is recorded.
  const stack = stackOf(e);
  const error: EntryError = {
    ...(recorded !== undefined
      ? recorded.error
      : { code: carried ?? "L4000", kind: "handler-fault", message: messageOf(e) }),
    ...(stack !== undefined ? { stack } : {}),
  };
  await host.journal.settle(key, { status: "failed", error }, endedAt);
  frame.clock.advance(endedAt);
  // THE CALLER AND THE RECORD SAY THE SAME THING. Rethrowing the handler's own error unchanged is
  // right whenever the record kept it; when the detail forced a downgrade it is not, because the
  // program would then catch an L6002 the journal has no L6002 for.
  throw recorded?.faithful === true ? e : new EffectError(error.code, error.kind, error.message);
}

/**
 * The hold of an at-most-once step (spec/cotal-lang.md §7.8): a checkpoint under the hold id
 * whose answer becomes the step's result. The step's own handler method is never called here.
 *
 * A refused hold does not settle `refused`. That verdict means "never attempted" and dispatches,
 * so recording it would turn a host that cannot open a checkpoint into the second write. The entry
 * stays pending with the hold it had, and the next capable host opens the same hold.
 */
async function performHold(
  host: EffectHost,
  key: StepKey,
  recorded: string,
  resume: Readonly<Record<string, unknown>> | undefined,
  frame: EffectFrame,
): Promise<unknown> {
  const step = stepKeyString(key);
  const ctx: EffectContext = {
    key,
    signal: frame.signal,
    requestId: holdRequestId(recorded),
    attempt: 0,
    ...(resume !== undefined ? { resume } : {}),
    bind: (hold) => host.journal.hold(key, hold),
  };
  const prompt =
    `The outcome of ${step} is unknown: it was dispatched under request id ${recorded} and never settled, `
    + "so it is not dispatched again. Answer with the step's result; your answer becomes its value.";
  let raw: CheckpointRaw;
  try {
    raw = await host.options.handler.checkpoint({ prompt }, ctx);
    assertCrossable(raw, `the hold of ${step}`);
    // A hold settles only on `resolved` or `expired`. Any other outcome is a handler fault, never
    // an answer: read as one, it would record a result for the write that nobody gave.
    const outcome: unknown = raw.outcome;
    if (outcome !== "resolved" && outcome !== "expired")
      throw new Error(`the hold of ${step} answered outcome ${JSON.stringify(outcome)}; a checkpoint answers "resolved" or "expired"`);
  } catch (e) {
    if (e instanceof EffectRefused) throw new RunHeld(step, e.message, true);
    return await settleThrown(host, key, frame, e, host.options.handler.now());
  }

  const endedAt = host.options.handler.now();
  if (raw.outcome === "expired") {
    const error: EntryError = {
      code: "L4027",
      kind: "outcome-unknown",
      message:
        `L4027 At-most-once step's outcome was never settled\n\n  step  ${step}   request id ${recorded}\n\n`
        + "The step was dispatched and its outcome never settled, and nobody answered its hold in time. It is not dispatched again.\n\n"
        + `Options\n  catch it: \`e.code === "L4027"\` and check the far side for the write under request id ${recorded}`,
    };
    await host.journal.settle(key, { status: "failed", error }, endedAt);
    frame.clock.advance(endedAt);
    throw new EffectError(error.code, error.kind, error.message);
  }
  const result = raw.value ?? null;
  await host.journal.settle(key, { status: "ok", result: deepFreeze(result) }, endedAt);
  frame.clock.advance(endedAt);
  return result;
}
/** The identity of the run, for the `run` free constructor. */
export interface RunIdentity {
  readonly runId: string;
  readonly programHash: string;
  readonly startedAt: number;
}

/**
 * The free VALUE constructors: the two pure primitives and the four event constructors, in
 * program convention (plain args in, frozen descriptor out). The walker's installGlobals wraps
 * them into its (frame, args) convention; the engine's `free()` serves them directly. One table,
 * both engines: the shapes on the wire may not fork.
 */
export function freeConstructors(run: RunIdentity): ReadonlyArray<readonly [string, (args: unknown[]) => unknown]> {
  return [
    ["channel", (a) => deepFreeze({ channel: a[0] as string })],
    ["run", () => deepFreeze({ id: run.runId, programHash: run.programHash, startedAt: run.startedAt })],
    ["replied", (a) => deepFreeze({ event: "replied", agent: agentHandle(a[0], "argument 1 of `replied`").agent })],
    [
      "message",
      (a) => {
        const ch = (a[0] as ChannelHandleValue).channel;
        const opts = (a[1] ?? {}) as Record<string, unknown>;
        return deepFreeze({
          event: "message",
          channel: ch,
          ...(opts.from !== undefined ? { from: agentHandle(opts.from, "`from` of `message`").agent } : {}),
          ...(opts.matches !== undefined ? { matches: opts.matches as string } : {}),
        });
      },
    ],
    ["idle", (a) => deepFreeze({ event: "idle", channel: (a[0] as ChannelHandleValue).channel, duration: a[1] as string })],
    ["down", (a) => deepFreeze({ event: "down", agent: agentHandle(a[0], "argument 1 of `down`").agent })],
  ];
}

// ---- concurrency scopes -------------------------------------------------------------------------
//
// ONE scope machinery, both engines. The walker's `callScope` evaluates the AST arguments and builds
// the branch digester, then hands VALUES to the two functions below; the engine's seam does the same
// from a transformed call site. Everything between - the scope's own journal entry, the replay,
// divergence and migration paths, the branch frames, the cut and its re-decision, the loser
// accounting - lives here once, because a second copy is a second answer to what a recorded scope IS.

/**
 * A frame, structurally.
 *
 * The walker's `Frame` and the engine's `EngineFrame` are different classes with the same shape, and
 * neither imports the other: the walker's is private to interpret.ts, and the engine's belongs to a
 * module that does not edit it. This is the shape the scope machinery actually uses, and both satisfy
 * it. `Frame` is the name the moved code already spells, so the move stays a move.
 */
export interface Frame {
  readonly keys: KeyScope;
  readonly clock: RunClock;
  readonly signal: BranchSignal;
  readonly depth: number;
  branch(kind: PathKind, name: string | null, occurrence: number, branchKey: string): Frame;
}

/**
 * A branch's cancellation as the SCOPE drives it.
 *
 * `CancelSignal` is the handler's view - what a running effect may observe. A scope also cancels,
 * and in two degrees, so it needs the writing half as well.
 */
export interface BranchSignal extends CancelSignal {
  /** The stronger cut, applied to an arm that can no longer win. Observed at a fuel yield. */
  readonly cutPure: boolean;
  cancel(reason: string, opts?: { readonly cutPure: boolean }): void;
}

/**
 * What a concurrency scope produces, before it is journalled.
 *
 * `branches` is what the scope launched, `value` is what the program sees, and `cancel` is the
 * intent a cancelling scope owes its losers, durable WITH the outcome, because a process dies
 * between instructions and two appends are two network operations however few keywords separate
 * them.
 */
export interface ScopeOutcome {
  readonly branches: readonly string[];
  readonly value: unknown;
  readonly cancel?: { readonly losers: readonly string[]; readonly issued: boolean };
  /** A `conclave`'s membership disposition. See {@link JournalEntry.closed}. */
  readonly closed?: boolean;
}

/** What the interpreter knows about a failing scope, beside whatever the program threw. */
export interface ScopeFacts {
  readonly cancel?: { readonly losers: readonly string[]; readonly issued: boolean };
  readonly closed?: boolean;
  /**
   * The scope's ARM NAMES, carried as a fact rather than left inside the result.
   *
   * A successful scope records `result: { branches, value }`, and `settle` writes `result` only for
   * `status: "ok"`, since result and error are exclusive, correctly. So a scope that FAILED recorded no
   * branch list at all, and a migration reconstructed an EMPTY winner set from it, entered nothing,
   * and awaited `Promise.race([])`, which never settles. The branch names are not a result; they
   * are what the scope was, and a scope that failed was still made of arms.
   */
  readonly branches?: readonly string[];
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

/**
 * A scope's failure, carrying the interpreter's OWN facts about it.
 *
 * Attaching them to the thrown value with `Object.assign` works exactly as long as every program
 * throws an object. `throw null` is valid, and `Object.assign(null, …)` is a TypeError, so a
 * conclave whose body throws a primitive loses its closure fact AND hands the caller a manufactured
 * type error in place of the body's failure, while the entry records
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
 * A value the PROGRAM threw out of a scope, recorded so a replay can hand it back. One the record
 * cannot carry keeps the generic fault with the crossing rule's refusal as its message, and the live
 * run is handed that fault too: a value only the live run could deliver is one its resume replaces.
 */
function thrownError(value: unknown): EntryError {
  const fault = { code: "L4000", kind: "scope-fault", message: messageOf(value) };
  if (value === undefined) return { ...fault, thrown: {} };
  try {
    assertCrossable(value, "the thrown value");
  } catch (cause) {
    if (!(cause instanceof NotCrossable)) throw cause;
    // The refusal alone: a thrown function's text is the host's own source, and differs by engine.
    return { ...fault, message: cause.message };
  }
  // A COPY: freezing the value itself would freeze a record the branch threw from outside it for
  // the rest of the live run, where a resume, which never runs the branch, leaves it writable. And a
  // copy in the journal's own encoding, JSON: one record held at two places in the value comes back
  // from a durable store as two records, so a copy that kept them one would hand the live `catch` a
  // fact its resume cannot.
  return { ...fault, thrown: { value: deepFreeze(JSON.parse(JSON.stringify(value))) } };
}

/**
 * What a failed scope throws, built from its record alone: a replay has nothing else, and a live run
 * whose scope failed with a thrown value builds it here too, so `catch` binds the same value on both.
 */
function scopeFailure(e: EntryError): unknown {
  return e.thrown !== undefined ? e.thrown.value : new EffectError(e.code, e.kind, e.message, e.detail);
}

/**
 * The digest fact, written wherever the loser set is: a race that FAILED owes its losers exactly
 * as a winning one does, so it carries the digest too, and `replay-failed` compares it.
 */
function digestFacts(
  of: ((losers: readonly string[]) => string | undefined) | undefined,
  losers: readonly string[] | undefined,
): { branchDigest?: string } {
  if (of === undefined || losers === undefined) return {};
  const d = of(losers);
  return d === undefined ? {} : { branchDigest: d };
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
 * deliver the outcome. Leading with the delivery is the defect, because the next program step can share
 * a worktree with a loser that is still writing.
 */
export async function performScope(
  host: EffectHost,
  scopeKey: StepKey,
  frame: Frame,
  body: (ctx: EffectContext, only?: ReadonlySet<string>) => Promise<ScopeOutcome>,
  subject?: unknown,
  /** The `branchDigest` over a named loser set. Absent where there is nothing to digest. */
  branchDigest?: (losers: readonly string[]) => string | undefined,
): Promise<unknown> {
  const dispatches = scopeTraits(scopeKey.kind)?.dispatches === true;
  if (dispatches && atMostOnce(scopeKey.scope)) throw notHoldable(scopeKey.kind, scopeKey.scope);
  const inputHash = digest(
    subject === undefined
      ? { kind: scopeKey.kind, name: scopeKey.name }
      : { kind: scopeKey.kind, name: scopeKey.name, subject },
  );
  const verdict = host.journal.lookup(scopeKey, inputHash);

  if (verdict.verdict === "diverged") {
    throw new RunDivergence(stepKeyString(scopeKey), verdict.recordedHash, verdict.programHash);
  }
  if (verdict.verdict === "replay" || verdict.verdict === "replay-failed") {
    const entry = verdict.entry;
    const endedAt = entry.endedAt ?? host.options.handler.now();

    // The comparison: `branchDigest` is checked whenever the entry carries one. The scope's own
    // `inputHash` is `{kind, name}` (an arm's body is not in it), and a settled race is
    // delivered from this entry without entering a branch, so without this comparison an edit
    // inside a LOSING arm reaches nothing that could notice it. Both replay paths, not the
    // migration path alone: a resume of edited source is exactly the case a divergence exists to
    // make loud, and the run record carries no program hash to have refused it earlier.
    if (entry.branchDigest !== undefined && branchDigest !== undefined) {
      const now = branchDigest(entry.cancel?.losers ?? []);
      if (now !== undefined && now !== entry.branchDigest) {
        throw new RunDivergence(stepKeyString(scopeKey), entry.branchDigest, now);
      }
    }

    // A MIGRATION MUST NOT TAKE THE SHORT-CIRCUIT ABOVE.
    //
    // Consuming the subtree wholesale is right for a resume: the program hash is unchanged, so
    // nothing under this scope can have been removed, and the branches were DECIDED rather than
    // deleted. Under a migration the source HAS changed, and marking every entry beneath the
    // scope accounted for means an effect the new source removed never reaches `orphans()`: a
    // resolved human checkpoint inside the winning branch disappears and L5004 never fires. A
    // silent disappearance whose log line never fires is invisible in the artifact AND in the
    // trace, which is the worst available failure.
    //
    // So the walk enters the RECORDED WINNING branches and runs the ordinary hash and orphan
    // checks inside them, while the losers (decided, not removed) are accounted for as before.
    if (host.options.migration === true) {
      if (dispatches) throw new UnwalkableScope(stepKeyString(scopeKey), scopeKey.kind);
      // A SETTLED SCOPE CARRIES ITS ARM NAMES IN ONE OF TWO PLACES, and reading only the first
      // is what made a failed scope look like a scope with no arms. `result` holds them when the
      // scope succeeded; the `branches` FACT holds them when it failed, because `settle` writes
      // no `result` for a failure.
      const recorded = entry.result as { branches?: readonly string[] } | undefined;
      const branches = recorded?.branches ?? entry.branches ?? [];
      const losers = new Set(entry.cancel?.losers ?? []);
      await host.journal.consumeScope(stepKeyString(scopeKey), endedAt, losers);
      try {
        await body(
          {
            key: scopeKey,
            signal: frame.signal,
            requestId: entry.requestId ?? requestId(host.options.runId, scopeKey, inputHash),
            attempt: entry.attempt ?? 0,
            bind: async () => {
              throw new UnwalkableScope(stepKeyString(scopeKey), "bind");
            },
          },
          new Set(branches.filter((b) => !losers.has(b))),
        );
      } catch (e) {
        // UNWRAPPED, because the caller of a migration wants the step that diverged and not the
        // scope that carried it. A live scope wraps a branch's failure so it can record the
        // cancellation intent with it; a walk records nothing and cancels nobody, so the wrapper
        // would only hide a `RunDivergence` behind a generic scope fault.
        const reason = unwrapScope(e).reason;
        // A VALUE THE PROGRAM THREW out of a scope recorded as failed is that failure walked again,
        // so the record below delivers it, as it does for the live run and a resume: the raw value is
        // one neither of them binds. An `Error` is never the program's own and keeps propagating,
        // the walk's divergence and refusals among them.
        if (reason instanceof Error || verdict.verdict !== "replay-failed") throw reason;
      }
      if (entry.endedAt !== undefined) frame.clock.advance(entry.endedAt);
      if (verdict.verdict === "replay-failed") throw scopeFailure(entry.error as EntryError);
      return (entry.result as { value: unknown }).value;
    }

    // (1) account for the subtree, settling any loser still pending as cancelled;
    await host.journal.consumeScope(stepKeyString(scopeKey), endedAt);
    // (2) the cancellation intent is the driver's to discharge against the world; a journal write
    //     cancels nothing by itself, so an undischarged intent stays visible rather than silently
    //     reading as done.
    // (3) only now, the outcome.
    if (entry.endedAt !== undefined) frame.clock.advance(entry.endedAt);
    if (verdict.verdict === "replay-failed") throw scopeFailure(entry.error as EntryError);
    return (entry.result as { value: unknown }).value;
  }
  if (verdict.verdict === "replay-cancelled") {
    throw new Cancelled("this scope was cancelled on the recorded run");
  }

  // `miss`, `refused` and `pending` alike RE-ENTER the scope: there is no recorded outcome to
  // return (a refused conclave never opened), and a
  // pending scope's losers were never durably cancelled. Settling is idempotent, so the arm that
  // finishes first wins again, except where the journal already knows better, which is what
  // `runScope`'s replayed-branch tie-break is for.
  // A scope that CALLS THE HANDLER owes a durable request id exactly as an effect does, and for
  // the same reason: a crash between issuing the work and recording who issued it leaves real
  // work (for `conclave`, a live channel with members joined) that nothing in the journal names.
  const resume = verdict.verdict === "pending" ? verdict.entry.external : undefined;
  const recorded = verdict.verdict === "pending" && verdict.entry.requestId !== undefined ? verdict.entry : undefined;
  const reqId = recorded?.requestId ?? requestId(host.options.runId, scopeKey, inputHash);
  // A conclave's open is real work against the world, so it is admitted as an effect is.
  if (dispatches) admitDispatch(host, frame, verdict, "conclave");
  if (verdict.verdict === "miss" || verdict.verdict === "refused") {
    await host.journal.begin(scopeKey, inputHash, host.options.handler.now(), dispatches ? reqId : undefined);
    // The same gap as {@link Interpreter.performEffect}'s begin, for the scope that DISPATCHES: a
    // conclave cancelled while its begin was in flight must not open a channel and join members.
    // The non-dispatching scopes launch no work of their own, and each branch effect re-checks its
    // own signal, so only the dispatching path re-checks here.
    if (dispatches && frame.signal.cancelled) {
      await host.journal.settle(scopeKey, { status: "cancelled" }, frame.clock.now());
      throw new Cancelled(frame.signal.reason ?? "cancelled");
    }
  }
  const ctx: EffectContext = {
    key: scopeKey,
    signal: frame.signal,
    requestId: reqId,
    attempt: recorded?.attempt ?? 0,
    ...(resume !== undefined ? { resume } : {}),
    // BOTH WRAPPERS OR NEITHER: see {@link performEffect}'s bind for the rule and for why it is
    // canonical rather than round-trip-exact. Guarding the effect path alone is the half-fence: that
    // one is reached by everything (measured across the lang suites: 275 reaches, every one from the
    // simulator's own binds) and THIS one was executed by nothing at all, in either direction, until
    // the cell below it existed. A guard no run has executed is indistinguishable from a deleted one.
    bind: async (external) => {
      assertCrossable(external, `the binding of ${stepKeyString(scopeKey)}`);
      await host.journal.bind(scopeKey, external);
    },
  };
  // The same two domains as {@link Interpreter.performEffect}, for the same reason: a scope whose
  // branches all succeeded and whose settling append was refused must not be recorded as failed.
  let outcome: ScopeOutcome;
  try {
    if ((scopeKey.kind === "race" || scopeKey.kind === "fanOut" || scopeKey.kind === "parallel") && !ctx.signal.cancelled) {
      simScopeFaults.get(host.options.handler)?.(ctx);
    }
    outcome = await body(ctx);
  } catch (raw) {
    // The interpreter's facts come out of the envelope; the program's thrown value comes out
    // whole, and is what the caller sees. A value the program threw is never written on.
    const { reason, facts } = unwrapScope(raw);
    // THE SCOPE'S CLOCK AT SETTLE, not the host's clock at append. `runScope` joins the branch
    // clocks before the outcome leaves it, so `frame.clock.now()` here is the greatest `endedAt`
    // the scope's branches awaited, which is what `now()` answers after the scope, live. Replay
    // advances the parent clock from this stamp and enters no branch, so stamping anything else
    // (measured: the handler's clock at append time) makes live and replay disagree on `now()`
    // after every scope whose last-to-land effect was not the handler's last stamp, and a program
    // that branches on `now()` takes a path on resume that the live run never took.
    const endedAt = frame.clock.now();
    if (reason instanceof JournalAppendRejected) throw reason;
    // A close that did not acknowledge settles NOTHING. The entry stays pending, which is exactly
    // what "a close is still owed" looks like in a journal, and the underlying handler error is
    // what the caller sees.
    if (reason instanceof CloseOwed) {
      // A close the host CANNOT perform (a capability refusal) leaves the entry pending — the
      // durable "a close is still owed" — and holds the run: a capable host re-enters and closes.
      if (reason.reason instanceof EffectRefused) throw new RunHeld(stepKeyString(scopeKey), messageOf(reason.reason));
      throw reason.reason;
    }
    if (reason instanceof Cancelled) {
      await host.journal.settle(scopeKey, { status: "cancelled" }, endedAt, facts);
      throw reason;
    }
    // A RELEASE IS NOT AN OUTCOME, INSIDE A SCOPE EITHER. `shouldStop` documents the law it keeps:
    // a driver's reason to stop "must not be recorded as its outcome", and the run stays exactly
    // where its journal says it is. The sequential seam kept that; this path did not, because the
    // class fell past this ladder into the generic settle below and wrote the release's own text as
    // an `L4000` scope-fault. A resume with a healthy host then replayed that entry and threw, so a
    // plain host stop PERMANENTLY ended any run that happened to be inside a scope while the same
    // stop one statement earlier resumed cleanly. Settling nothing is what leaves the run where it
    // stands: a pending scope re-enters on resume (see the `miss`/`pending` note above) and settling
    // is idempotent, which is the same shape `CloseOwed` above relies on.
    if (reason instanceof RunReleased) throw reason;
    // A HELD RUN IS THE SAME SHAPE: the refusal's halt is not this scope's outcome. The refused
    // entry inside the branch is already settled; the scope stays pending and re-enters on resume.
    if (reason instanceof RunHeld) throw reason;
    // A DIVERGENCE IS NOT AN OUTCOME EITHER. It is the journal saying this program is not the one
    // that wrote it, and the interpreter already treats it as uncatchable (next to `RunReleased`
    // and `Cancelled` there); recording it here would convert that run-level signal into a durable
    // statement that the scope failed for a reason of its own, and the next resume would replay an
    // `EffectError` a program's `try` could swallow, spending the loudness before anyone sees it.
    // Settling nothing is the same shape `RunReleased` above takes: the scope stays pending, a
    // resume re-enters it, and the step that broke diverges again.
    if (reason instanceof RunDivergence) throw reason;
    // A HOST STACK EXHAUSTION IS NOT AN OUTCOME EITHER (§9.2). How deep a branch got before the host
    // ran out of stack is a fact about the host, so recording it would replay as a catchable
    // `L4000` on a host with more stack, where the same branch succeeds.
    if (isStackExhaustion(reason)) throw reason;
    // NOR IS THE COMPILED ENGINE'S OWN FAULT (#3215). An `EngineFault` is an emitter mistake the
    // engine refuses uncatchably, so recording it would hand a resume a catchable failure where the
    // live run unwound. Matched by name, as the engine's own uncatchable check matches it, because
    // the class lives on the engine's side of this module.
    if (reason instanceof Error && reason.name === "EngineFault") throw reason;
    // A CAPABILITY REFUSAL OF THE SCOPE'S OWN DISPATCH (a conclave's open): nothing was entered
    // and nothing was attempted, so the scope settles `refused` exactly as an effect does, and
    // the run is held for a host that can open it.
    if (reason instanceof EffectRefused) {
      await host.journal.settle(
        scopeKey,
        { status: "refused", error: { code: reason.code, kind: "refused", message: reason.message } },
        endedAt,
        facts,
      );
      throw new RunHeld(stepKeyString(scopeKey), reason.message);
    }
    // A handler's `EffectError` is recorded by the same rule as the effect path's.
    //
    // A `RuntimeFault` KEEPS ITS OWN CODE (#1519). It is a classified refusal the LANGUAGE raised
    // (`L3021` for a fanOut with no stable key), and flattening it to `L4000` wrote a code the spec
    // says an UNCLASSIFIED failure carries, with the real sentence still inside the message. The
    // record and the rethrow then disagreed with every resume, which replayed the recorded `L4000`
    // as an `EffectError` while the live run had thrown the `RuntimeFault` itself. The kind is
    // `runtime`, the kind a program's `catch` already binds for this class on both engines'
    // `toProgramError` (a fault the PROGRAM caused), so a reader branching on `kind` reads the same
    // verdict from the record that the program read live.
    //
    // A VALUE THE PROGRAM THREW IS RECORDED WHOLE (#2845). A replay delivers nothing but this
    // record, and it used to deliver the generic fault where the live run had rethrown the value, so
    // a resumed `catch` bound `{ code: "L4000", ... }` where the live one bound `"failure"`, and a
    // program branching on it diverged.
    //
    // ANY OTHER `Error` IS RECORDED AS THE `host` FAULT A `catch` BINDS FOR IT LIVE (#3215). It is
    // never the program's (it cannot construct one), so it is rethrown as itself and both engines'
    // `toProgramError` deliver it as `{ code: "L4000", kind: "host", message }`. Recorded as
    // `scope-fault`, the replay bound a different kind than the live run had, and a program
    // branching on it diverged on the resume of unchanged source.
    const err: EntryError =
      reason instanceof EffectError
        ? recordableError(reason, "scope-fault").error
        : reason instanceof RuntimeFault
          ? { code: reason.code, kind: "runtime", message: messageOf(reason) }
          : reason instanceof Error
            ? { code: "L4000", kind: "host", message: messageOf(reason) }
            : thrownError(reason);
    // A rejecting branch cancels its siblings and can crash before they hear it, so a FAILED scope
    // carries the intent too, and a conclave that closed says so even when its body failed.
    await host.journal.settle(scopeKey, { status: "failed", error: err }, endedAt, {
      ...facts,
      ...digestFacts(branchDigest, facts.cancel?.losers),
    });
    throw reason instanceof Error ? reason : scopeFailure(err);
  }

  // THE FACTS A SETTLED SCOPE CARRIES, assembled ONCE. Both the fence below and the success settle
  // write them, and a scope that fails its own value rule still owes the cancel intent it issued.
  // Assembling them twice is how the two settles would drift the day a fourth fact is added.
  const settledFacts = {
    ...(outcome.cancel !== undefined ? { cancel: outcome.cancel } : {}),
    ...(outcome.closed !== undefined ? { closed: outcome.closed } : {}),
    ...digestFacts(branchDigest, outcome.cancel?.losers),
  };

  // THE VALUE A SCOPE SETTLES IS A VALUE, and answers to the same rule as an effect's result. The
  // effect path fences its handler's result at its own settle; this one was left open, and the two
  // engines then disagreed about one legal program: the walker and the in-process engine recorded a
  // FUNCTION in `result.value` and completed, while the worker died on a structured-clone error
  // naming a host algorithm. Worse than either divergence, the durable store encodes with
  // `JSON.stringify` (core's `encodeRecord`), so `{ a: fn }` went to the wire as `{}` with NO error
  // and the resume replayed a value the live run never produced. All four measured before this
  // existed: walker completes with a function, engine completes with a function, worker
  // DataCloneError, and live `function` against replayed `undefined` with nothing raised.
  //
  // RECORDED AS A FAULT RATHER THAN THROWN BARE, for the effect path's reason. A scope whose
  // branches already ran has done work the world can see, and leaving its entry pending invites a
  // resume to run those branches a second time. The facts the success settle would have carried
  // travel with the failure, because a cancel intent this scope issued is owed whether or not its
  // value could be written. The kind is `host`, the one a `catch` binds for the `NotCrossable` live.
  try {
    assertScopeValueCrossable(outcome.value, `the value of ${stepKeyString(scopeKey)}`, scopeKey.kind);
  } catch (e) {
    if (!(e instanceof NotCrossable)) throw e;
    await host.journal.settle(
      scopeKey,
      { status: "failed", error: { code: "L4000", kind: "host", message: e.message } },
      frame.clock.now(),
      settledFacts,
    );
    throw e;
  }

  // A COPY, for the thrown value's reason (`thrownError`): freezing the value itself would freeze a
  // record a branch returned from outside the scope for the rest of the live run, where a resume,
  // which never runs the branch, leaves it writable (#3224). The live run gets the copy its record
  // carries, in the journal's own encoding, so it reads exactly what a replay hands back.
  const value = outcome.value === undefined ? undefined : deepFreeze(JSON.parse(JSON.stringify(outcome.value)));
  await host.journal.settle(
    scopeKey,
    { status: "ok", result: { branches: outcome.branches, value } },
    // The joined branch clock, for the same reason as the failure path above: this is the value
    // `now()` answers after the scope, and the stamp replay hands back must be that value.
    frame.clock.now(),
    settledFacts,
  );
  return value;
}

/**
 * A HOST STACK EXHAUSTION AMONG THE JOINED BRANCHES leaves the scope bare (§9.2), whichever branch
 * raised it and whatever another branch did first: a failure or a winner that settled earlier would
 * otherwise carry it into a recorded outcome the program can catch.
 */
function throwIfStackExhausted(settled: readonly PromiseSettledResult<unknown>[]): void {
  const exhausted = settled.find((r): r is PromiseRejectedResult => r.status === "rejected" && isStackExhaustion(r.reason));
  if (exhausted !== undefined) throw exhausted.reason as Error;
}

export async function runScope(
  host: EffectHost,
  scopeKind: ScopeKind,
  scopeName: string | null,
  occurrence: number,
  first: unknown,
  /**
   * The SECOND argument, DEFERRED: `fanOut`'s body, `conclave`'s body.
   *
   * A thunk rather than a value, so it is evaluated exactly where it was evaluated before: after
   * the scope's entry has begun, not at the call. `parallel` and `race` never call it - their
   * second argument is the options bag, which the caller evaluates.
   */
  second: () => Promise<unknown>,
  bag: unknown,
  frame: Frame,
  ctx: EffectContext,
  /** A migration's walk: enter exactly these branches, the ones the recorded run WON with. */
  only?: ReadonlySet<string>,
): Promise<ScopeOutcome> {
  if (scopeKind === "parallel" || scopeKind === "race") {
    const all: [string, (f: Frame, a: unknown[]) => Promise<unknown>][] = Array.isArray(first)
      ? (first as ((f: Frame, a: unknown[]) => Promise<unknown>)[]).map((fn, i) => [String(i), fn])
      : Object.entries(first as Record<string, (f: Frame, a: unknown[]) => Promise<unknown>>);
    const entries = only === undefined ? all : all.filter(([k]) => only.has(k));

    // THE WALK MUST FIND EVERY ARM IT WAS SENT TO ENTER.
    //
    // `only` is the set of RECORDED WINNING branch keys, and the whole "losers only" digest rule
    // rests on the walk entering the winner: an edit there is supposed to diverge at the step it
    // broke, which is a strictly better error than "some arm of this race changed". A RENAME
    // removes the arm, so there is no step left to diverge at and the argument silently stops
    // holding. What happened instead was worse than a silent pass. `entries` came back empty,
    // `running` with it, and `Promise.race([])` NEVER SETTLES: a migration or a fork over a
    // renamed winning arm hung rather than returning any verdict at all. `parallel` did not hang,
    // because `Promise.all([])` resolves, and handed the program back the recorded value keyed by
    // the arm the source no longer has.
    //
    // Narrow on purpose, and every neighbouring shape already has an answer: a renamed or deleted
    // LOSER diverges through the branch digest, and an ADDED arm is not an edit to anything
    // recorded, so neither reaches this.
    if (only !== undefined) {
      const present = new Set(all.map(([k]) => k));
      const missing = [...only].filter((k) => !present.has(k));
      if (missing.length > 0) {
        throw new ScopeBranchMissing(stepKeyString(ctx.key), scopeKind, missing, [...only], [...present]);
      }
      // AND THE EMPTY CASE, which the check above cannot see: with no recorded branches at all,
      // "every recorded branch is present" is vacuously true, so the guard passed and the walk
      // still entered nothing and still hung. A guard over an empty set grades nothing and is
      // green forever. Journals written before scopes recorded their arm names on failure are
      // exactly that shape, so this refuses them by name instead of hanging on them. It cannot
      // fire on a scope that has no arms in the source either, because `all` is empty then too.
      if (only.size === 0 && all.length > 0) {
        throw new ScopeBranchMissing(stepKeyString(ctx.key), scopeKind, [], [], all.map(([k]) => k));
      }
    }

    const frames = entries.map(([k]) => frame.branch(scopeKind, scopeName, occurrence, k));
    const running = entries.map(([, fn], i) => fn(frames[i] as Frame, []));

    const branches = entries.map(([k]) => k);

    if (scopeKind === "parallel") {
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
        // A HOST-SIDE UNWIND IS NOT A BRANCH FAILURE. A release or a refused append must leave
        // the run exactly where the journal says it is: cancelling siblings would settle their
        // in-flight entries `cancelled`, a durable fact about a run that was merely stopped, and
        // a resume then replays that cancellation into a healthy run. So the siblings run to
        // their own boundary (each releases there in turn, or finishes work already in flight)
        // and the unwind propagates bare, with nothing cancelled and nothing settled. A
        // divergence is the same non-fact about the branches: it says the program is not the one
        // that wrote this journal, so cancelling a sibling would record a consequence of the
        // disagreement on a run the program has no standing to speak for.
        if (e instanceof RunReleased || e instanceof RunHeld || e instanceof JournalAppendRejected || e instanceof RunDivergence || isStackExhaustion(e)) {
          await Promise.allSettled(running);
          throw e;
        }
        // The first rejection cancels the rest, then rethrows. The intent travels WITH the
        // failure, because a rejecting branch cancels its siblings and can crash before they
        // hear it, so a failed scope owes its losers exactly as a winning one does.
        for (const f of frames) f.signal.cancel("a sibling branch failed");
        throwIfStackExhausted(await Promise.allSettled(running));
        frame.clock.join(frames.map((f) => f.clock));
        const losers = branches.filter((k) => k !== failed);
        throw new ScopeFailed(e, { branches, cancel: { losers, issued: false } });
      }
    }

    // race: the earliest to settle wins, and the losers are cancelled BY SEMANTICS, not by an API
    // the program calls. A cancelled branch performs no new effects; an agent reply already in
    // flight completes and is ignored, which is the documented answer rather than an accident.
    // THE WINNER IS THE EARLIEST BRANCH, NOT THE FIRST ONE SCHEDULING HAPPENED TO WAKE.
    //
    // An arm's logical settlement time is its branch clock: the max endedAt of the effects it
    // awaited (the scope's entry clock if it awaited none), which is recorded. The winner is the
    // least clock among the arms that settled; equal clocks fall to declaration order, which is
    // recorded too. So the same journal resolves the same arm on every re-entry.
    //
    // AND LIVE, NO SCHEDULER AND NO `yieldEvery` VALUE CAN CHOOSE. When an arm settles, every
    // sibling is cancelled (no new effects, the cancellation law), and each sibling is CUT, pure
    // work included, only if it can no longer win: its clock is later, or equal and it is declared
    // later. A sibling that could still win runs its pure work to a settle, and a sibling that
    // reaches a new effect is cut there, having proven it would end after the settled arm's clock.
    // Which arms settle is therefore a function of their effects and the declaration order, and
    // so is the winner. A later settle with an earlier clock re-decides the cut for the rest.
    // A FAILURE IS A SETTLE, so a rejecting arm is a candidate to win: it just wins by failing
    // the scope. What is NOT a candidate is a branch that rejected with `Cancelled`, because that
    // is not an outcome the branch reached, it is what losing did to it. Counting those would let
    // a loser cut short at an early step outrank the winner that ran longer.
    // The FRONTIER: the least clock among the arms that have settled as candidates, ties to the
    // earlier declaration. The cut compares against it in both places below, because it is the
    // bar an unsettled arm actually has to beat.
    let bestAt = -1;
    let bestIndex = -1;
    const behindFrontier = (j: number): boolean => {
      const other = (frames[j] as Frame).clock.now();
      return !(other < bestAt || (other === bestAt && j < bestIndex));
    };
    const onSettle = (i: number, wasCancelled: boolean): void => {
      if (wasCancelled) return;
      const at = (frames[i] as Frame).clock.now();
      if (bestIndex === -1 || at < bestAt || (at === bestAt && i < bestIndex)) {
        bestAt = at;
        bestIndex = i;
      }
      for (let j = 0; j < frames.length; j += 1) {
        if (j === i) continue;
        (frames[j] as Frame).signal.cancel("a sibling branch won the race", { cutPure: behindFrontier(j) });
      }
    };
    running.forEach((p, i) => {
      p.then(
        () => onSettle(i, false),
        // A branch that rejected with `Cancelled` reached no outcome, and one that rejected with
        // a host-side unwind (a release, a held run, a refused append) reached none either:
        // neither is a candidate, and neither may cancel the arms that are still running. A
        // diverging arm is in that set too: its rejection is a fact about the program, not an
        // outcome this run reached, and the hoist below the settle surfaces it before any winner
        // is chosen.
        (e: unknown) =>
          onSettle(
            i,
            e instanceof Cancelled ||
              e instanceof RunReleased ||
              e instanceof RunHeld ||
              e instanceof JournalAppendRejected ||
              e instanceof RunDivergence ||
              isStackExhaustion(e),
          ),
      );
    });
    // AND THE CUT IS RE-DECIDED WHEN AN ARM'S OWN CLOCK MOVES. A cancelled arm with an effect
    // already in flight is allowed to see it land, since the work was issued before the
    // cancellation, but landing advances the arm's clock, and an arm that lands PAST the frontier has just
    // proven it cannot win. Deciding only at settles left that arm running its pure tail on a
    // verdict reached from its old clock: measured, an infinite pure tail burned the whole step
    // budget and killed a run whose race had already settled `ok`, while a resume of the same
    // journal returned the winner, with live and replay disagreeing on the run's outcome. An arm
    // that lands BEFORE the frontier keeps running, because it can still win (its own cell).
    frames.forEach((f, j) => {
      f.clock.onAdvance(() => {
        if (f.signal.cancelled && !f.signal.cutPure && bestIndex !== -1 && behindFrontier(j)) {
          f.signal.cancel("a sibling branch won the race", { cutPure: true });
        }
      });
    });
    // BOTH HANDLERS, and the rejection handler is the whole point. `p.then(() => undefined)`
    // propagates a rejection, so the first arm to FAIL threw straight out of this await: past the
    // cancellation, past `allSettled`, and into a scope entry recorded as failed with no losers on
    // it. The run terminated while a sibling was still performing effects, which is the exact
    // defect the scope entry exists to prevent. A rejection is a settle.
    await Promise.race(running.map((p) => p.then(() => undefined, () => undefined)));
    const settled = await Promise.allSettled(running);
    // A HOST STACK EXHAUSTION cancels no sibling (§9.2), so it leaves before the cancel below: that
    // cancel reaches every arm's handlers, and a live handler would pass it on to external work.
    throwIfStackExhausted(settled);
    // Every arm has settled, so whatever cut it did not get earlier no longer matters; the
    // signal still says cancelled, which is what a nested branch that outlives this line reads.
    for (const f of frames) f.signal.cancel("a sibling branch won the race");
    frame.clock.join(frames.map((f) => f.clock));

    // A REFUSED APPEND OUTRANKS ANY WINNER, and this check sits ABOVE the winner scan on purpose.
    // The journal refused to record an arm's outcome (L5006 ahead of the append, L5010 at the
    // store), so completing the race would settle a scope over an entry the run can no longer
    // record: a loud durability failure converted into a silent success, with the refused step
    // left pending forever inside a settled scope a resume short-circuits past. Measured before
    // the rule: race:either settled ok, ask:q pending, outcome COMPLETED. A release is different
    // and stays below: a released arm is no candidate, but in-flight work that already won is a
    // decision this driver may keep (its own cell). A HELD run rides the same hoist: the refused
    // step is settled `refused` and heals only when a resume REACHES it, and a resume
    // short-circuits a settled scope, so a race that completed over a held arm would bury the
    // heal forever. A DIVERGENCE rides it too, and for the run's own sake rather than a step's:
    // an arm whose journal lookup refused the program must not be discarded by the tie-break,
    // because the winner scan's `find` below would otherwise drop the losing arm's rejection on
    // the floor and hand the program a value recorded by a run this source no longer is. Measured
    // before this line: a losing arm's divergence, a pure sibling winning, and the run COMPLETED.
    const refusedAppend = settled.find(
      (r): r is PromiseRejectedResult =>
        r.status === "rejected" &&
        (r.reason instanceof RunHeld || r.reason instanceof JournalAppendRejected || r.reason instanceof RunDivergence),
    );
    if (refusedAppend !== undefined) throw refusedAppend.reason as Error;

    let winnerAt = -1;
    let winnerIndex = -1;
    for (let i = 0; i < settled.length; i += 1) {
      const r = settled[i] as PromiseSettledResult<unknown>;
      if (
        r.status === "rejected" &&
        (r.reason instanceof Cancelled ||
          r.reason instanceof RunReleased ||
          r.reason instanceof RunHeld ||
          r.reason instanceof JournalAppendRejected)
      ) {
        continue;
      }
      const at = (frames[i] as Frame).clock.now();
      if (winnerIndex === -1 || at < winnerAt) {
        winnerAt = at;
        winnerIndex = i;
      }
    }
    if (winnerIndex === -1) {
      // A host-side unwind outranks the cancellation story: the run was stopped, not decided,
      // and the reason has to travel bare so the scope settles nothing. A refused append never
      // reaches this branch (it threw above the winner scan); what remains here is a release
      // with no surviving candidate.
      const hostSide = settled.find(
        (r): r is PromiseRejectedResult => r.status === "rejected" && r.reason instanceof RunReleased,
      );
      if (hostSide !== undefined) throw hostSide.reason as Error;
      // Every arm was cancelled, so the race itself was: nothing here decided anything.
      const first = settled.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      throw first === undefined ? new Cancelled("every branch was cancelled") : (first.reason as Error);
    }
    const index = entries[winnerIndex]?.[0] as string;
    const won = settled[winnerIndex] as PromiseSettledResult<unknown>;
    if (won.status === "rejected") {
      // The earliest branch to settle FAILED. The scope fails with it, carrying the siblings it
      // cancelled: a losing arm can crash before the cancellation reaches it, so the intent has
      // to travel with the outcome exactly as it does for a winning race.
      throw new ScopeFailed(won.reason, {
        branches,
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

  if (scopeKind === "fanOut") {
    const items = first as unknown[];
    const fn = (await second()) as (f: Frame, a: unknown[]) => Promise<unknown>;
    const keyFn = option(bag, "key") as ((f: Frame, a: unknown[]) => Promise<unknown>) | undefined;

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
    // A fanOut has no losers: every branch is a winner, so a migration's walk enters the ones the
    // recorded run actually had. A branch the new source no longer produces is simply not walked,
    // and its entries surface as orphans, which is the whole point of walking rather than
    // consuming.
    const walk = items
      .map((item, i) => [item, i] as const)
      .filter(([, i]) => only === undefined || only.has(branchKeys[i] as string));
    // The same failure law as `parallel`: the first rejection cancels the siblings and the scope
    // fails with it, carrying the losers. Measured before this block: a rejecting branch threw out
    // of `Promise.all` alone, and every sibling went on performing effects against a scope whose
    // entry had already settled failed.
    let failed: string | null = null;
    const launched = walk.map(([item, i]) =>
      fn(frames[i] as Frame, [item, i]).catch((e: unknown) => {
        if (failed === null) failed = branchKeys[i] as string;
        throw e;
      }),
    );
    try {
      const results = await Promise.all(launched);
      frame.clock.join(frames.map((f) => f.clock));
      return { branches: branchKeys, value: results };
    } catch (e) {
      // The same host-side rule as `parallel`: a release, a held run, a refused append, or a
      // divergence cancels nothing.
      if (e instanceof RunReleased || e instanceof RunHeld || e instanceof JournalAppendRejected || e instanceof RunDivergence || isStackExhaustion(e)) {
        await Promise.allSettled(launched);
        throw e;
      }
      for (const f of frames) f.signal.cancel("a sibling branch failed");
      throwIfStackExhausted(await Promise.allSettled(launched));
      frame.clock.join(frames.map((f) => f.clock));
      const losers = branchKeys.filter((k) => k !== failed);
      throw new ScopeFailed(e, { branches: branchKeys, cancel: { losers, issued: false } });
    }
  }

  if (scopeKind === "conclave") {
    // A conclave is a scope AND an effect, and it gets ONE entry, of kind `conclave`, carrying
    // the durable answer to "is this sub-team still live". That answer is the explicit `closed`
    // FACT, not the entry's state: a body that failed after a clean close settles `failed`
    // exactly like one whose close never acknowledged, and only the fact separates them. Pending
    // means a close is still owed. The migrate table reads that fact (an orphaned conclave is
    // rejected unless the scope closed), so a second entry for the close would be a second thing
    // to keep in agreement with the first, and nothing needs it.
    const members = deepFreeze(first) as AgentHandleValue[];
    const fn = (await second()) as (f: Frame, a: unknown[]) => Promise<unknown>;
    const channel = option(bag, "channel") as string | undefined;
    const req: ConclaveRequest = { members, ...(channel !== undefined ? { channel } : {}) };
    const handler = host.options.handler;
    const handle = deepFreeze(await handler.openConclave(req, ctx)) as ChannelHandleValue;

    // One body, one branch, and the branch key is the fixed literal `in` rather than the channel
    // name. The channel is HANDLER-DERIVED (the simulator and the mesh mint different ones), so
    // keying the journal namespace by it would make a journal replayable only under the handler
    // that wrote it, which is the one thing the effect seam exists to prevent.
    // ONE constant, used for both the namespace and the recorded branch list, so the entry cannot
    // claim a key the body's steps were not actually filed under.
    const branchKey = "in";
    const branch = frame.branch(scopeKind, scopeName, occurrence, branchKey);

    // The body's outcome is decided FIRST, alone. The close is a separate act with a separate
    // failure mode, and folding it into this try is what made a close rejection retry itself and
    // then settle as an ordinary body failure, a `failed` entry indistinguishable from "the body
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

    // A CANCELLED branch performs no new effects, so a cancelled conclave does not close
    // itself: releasing the membership travels the same recovery path as every other branch-local
    // resource a race loser took. A conclave whose body merely FAILED is not cancelled, because
    // this process is live and the world is reachable, and walking away from live membership on
    // an ordinary error would be the `spawn` leak in another shape.
    // A HOST-SIDE UNWIND leaves the close owed: closing would be a new action after the driver
    // said stop, and the pending entry is exactly what "a close is still owed" looks like. A host
    // stack exhaustion in the body is the same unwind (§9.2): closing after it would be a new effect
    // on a run that must stop, and a close error would replace it with one a program can catch.
    if (
      bodyError instanceof RunReleased ||
      bodyError instanceof RunHeld ||
      bodyError instanceof JournalAppendRejected ||
      isStackExhaustion(bodyError)
    )
      throw bodyError;
    if (bodyError instanceof Cancelled) throw new ScopeFailed(bodyError, { closed: false });

    try {
      await handler.closeConclave(req, ctx);
    } catch (e) {
      // THE CLOSE DID NOT ACKNOWLEDGE, so the scope does not settle at all. A pending entry IS
      // the durable "a close is still owed" (re-entry retries it), and settling anything here
      // would be the journal claiming a disposition the world never confirmed. The body's own
      // error, if there was one, is subordinate: it did not leave members joined; this did.
      throw new CloseOwed(e);
    }

    if (threw) throw new ScopeFailed(bodyError, { closed: true });
    return { branches: [branchKey], value, closed: true };
  }

  if (scopeKind === "once") {
    // One body, the fixed branch `in`, as `conclave`'s, with no open and no close. `only` is
    // ignored: a migration's walk always enters `in`, because one branch is never a loser.
    const branch = frame.branch(scopeKind, scopeName, occurrence, "in");
    try {
      return { branches: ["in"], value: await (first as (f: Frame, a: unknown[]) => Promise<unknown>)(branch, []) };
    } finally {
      frame.clock.join([branch.clock]);
    }
  }

  // Every kind returns from its arm above, so a kind added to `ScopeKind` without one stops the
  // build here rather than reaching a program as a defect.
  const unhandled: never = scopeKind;
  throw new InterpreterDefect(`the primitive ${unhandled}`);
}
