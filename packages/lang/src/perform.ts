/**
 * The effect seam, shared by both engines.
 *
 * {@link performEffect} is the durable core — key allocation, journal lookup and replay, the
 * pending protocol, the two failure domains — and {@link dispatchPrimitive} is the per-primitive
 * wiring from evaluated argument VALUES to the handler, with the hashed projections that decide
 * each effect's identity. The tree-walker (`interpret.ts`) delegates here; the v2 engine host
 * calls it directly. ONE function over ONE table: a second copy of a projection would be a
 * divergence the differential suite could only find program-by-program.
 */
import { RunDivergence, RuntimeFault, ScopeBranchMissing, UnwalkableScope, messageOf } from "./errors.js";
import { digest, requestId, stepKeyString, type KeyScope, type ScopeKind, type StepKey } from "./keys.js";
import { Journal, JournalAppendRejected, RunClock, type EntryError } from "./journal.js";
import { NotCrossable, assertCrossable, deepFreeze } from "./values.js";
import { PRIMITIVES, type EffectKind } from "./primitives.js";
import { parseDuration } from "./duration.js";
import { notifyFactViolation } from "./notify-fact.js";
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
  type CheckpointRaw,
  type EventDescriptor,
} from "./effects.js";
import type { RunOptions } from "./interpret.js";

/**
 * The slice of a run the effect seam needs: the journal, the run options, the effect ceiling, and
 * the run-scoped dispatched-effect counter (mutable — L4009 counts across activations).
 */
export interface EffectHost {
  readonly journal: Journal;
  readonly options: RunOptions;
  readonly ceiling: number;
  effectCount: number;
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

/**
 * Perform one effect, or replay it.
 *
 * Everything durable happens here. A handler is called only in the `miss` and `pending` cases,
 * and in `pending` it is told to re-bind rather than re-issue.
 */
/**
 * An `EffectError`'s `detail` is a RECORDED VALUE, and until this function it was the last one with
 * no domain check on it.
 *
 * Measured, with the binding guard already in place: a handler throwing
 * `new EffectError("L6002", …, { cb: () => 1 })` from a step the program CATCHES leaves a run that
 * SUCCEEDS while its journal carries a function. In-process that is merely wrong; through the worker
 * the whole journal is structured-cloned back to the host, so the same run dies on a DataCloneError.
 * A failing run never posts its entries — the worker hand-builds `{ok,code,name,message}` on that
 * path — so a caught failure on the success path is the route, and it is a real program, not a
 * contrived one.
 *
 * WHAT A REFUSAL COSTS, said out loud because it is a real cost: the handler's own classification is
 * dropped. An error whose report cannot be recorded is recorded as what it is — a fault of the
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

export async function performEffect(
  host: EffectHost,
  kind: EffectKind,
  name: string,
  hashedInput: unknown,
  perform: (ctx: EffectContext, inputHash: string) => Promise<unknown>,
  frame: EffectFrame,
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
  const stop = host.options.shouldStop?.();
  if (stop !== undefined) {
    throw new RunReleased(stop);
  }

  host.effectCount += 1;
  if (host.effectCount > host.ceiling) {
    throw new RuntimeFault(
      "L4009",
      `this run has performed more than ${host.ceiling} effects, which means a loop is not terminating. Add an exit condition or a permit.`,
    );
  }

  const resume = verdict.verdict === "pending" ? verdict.entry.external : undefined;
  // RECOVERY SUBMITS UNDER THE RECORDED IDENTITY. Re-deriving happens to agree whenever nothing
  // moved, which is exactly why it read as correct: the whole point of writing the id down is
  // the case where it does NOT agree, and a resumed run that re-derives is reissuing under an
  // identity the far side may never have seen. An entry with no recorded id predates this rule.
  const recorded = verdict.verdict === "pending" && verdict.entry.requestId !== undefined ? verdict.entry : undefined;
  const reqId = recorded?.requestId ?? requestId(host.options.runId, key, inputHash);
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
    await host.journal.begin(key, inputHash, host.options.handler.now(), reqId);
    // THE AWAIT ABOVE IS A GAP, and the cancellation law has to hold on both sides of it. The
    // check before `begin` sees the world as it was when this step started; while the append was
    // in flight a sibling can settle the race and cancel this branch. Measured before this line:
    // the loser's effect was still dispatched, performed against the world, and recorded `ok` —
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
    ...(resume !== undefined ? { resume } : {}),
    // THE THIRD PATH INTO AN ENTRY, and until this line the only one with no rule. The other two sit
    // a few lines apart — the RESULT at the settle below, the ARGUMENTS in `dispatchPrimitive` — and
    // a handler's own `ctx.bind` reached `journal.bind` with nothing in between. Measured before this
    // line, on both engines: a handler binding `{ when: new Date(0), n: -0, bad: NaN, gone: undefined }`
    // recorded all four, and the durable store gives them back as a string, `0`, `null` and an absent
    // key — so the value a resume RE-BINDS to was not the value that was bound.
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
    const endedAt = host.options.handler.now();
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
    const error: EntryError =
      recorded !== undefined
        ? recorded.error
        : { code: carried ?? "L4000", kind: "handler-fault", message: messageOf(e) };
    await host.journal.settle(key, { status: "failed", error }, endedAt);
    frame.clock.advance(endedAt);
    // THE CALLER AND THE RECORD SAY THE SAME THING. Rethrowing the handler's own error unchanged is
    // right whenever the record kept it; when the detail forced a downgrade it is not, because the
    // program would then catch an L6002 the journal has no L6002 for.
    throw recorded?.faithful === true ? e : new EffectError(error.code, error.kind, error.message);
  }

  const endedAt = host.options.handler.now();
  await host.journal.settle(key, { status: "ok", result: deepFreeze(result) }, endedAt);
  frame.clock.advance(endedAt);
  return result;
}

/**
 * Dispatch one non-scope primitive from evaluated argument VALUES: the crossability refusals, the
 * freeze on share, and the per-primitive hashed projection, ending in {@link performEffect}. The
 * scope-openers never come here — their branches must stay unevaluated.
 */
export async function dispatchPrimitive(host: EffectHost, name: string, args: unknown[], frame: EffectFrame): Promise<unknown> {
  const spec = PRIMITIVES[name];
  if (spec === undefined) throw new RuntimeFault("L2001", `${name} is not a primitive`);
  // Every argument crosses the effect boundary: it is hashed, recorded, or handed to the handler,
  // and a value with no canonical form can be none of those. Refused HERE, before any entry is
  // written, with the argument named: `undefined`, a non-finite number and an opaque object are
  // L3041, a function is L3042. The result of the effect is held to the same rule in
  // {@link Interpreter.performEffect}.
  args.forEach((arg, i) => {
    try {
      assertCrossable(arg, `argument ${i + 1} of \`${name}\``);
    } catch (e) {
      if (e instanceof NotCrossable) throw new RuntimeFault(e.why === "function" ? "L3042" : "L3041", e.message);
      throw e;
    }
  });
  // FREEZE ON SHARE, at the share. What crossed is what was hashed and recorded, so the program
  // mutating it afterwards — or the HANDLER mutating it on its side — would make the run's own
  // value disagree with its recorded form (measured before this line: `schema.deep.x = 2` after
  // an `ask` succeeded, no L2031, and a handler's write to `req.schema` reached the program).
  for (const arg of args) deepFreeze(arg);
  const bag = args[spec.optionsAt];
  const stepName = (name === "checkpoint" ? args[0] : option(bag, "name")) as string | undefined;
  const handler = host.options.handler;

  switch (name) {
    case "spawn": {
      // The first argument is a persona name, or a record carrying the persona WITH its model
      // and variant. Only the persona was ever read, so the object form silently dropped model
      // and variant from both the request and the hash: editing a model did not diverge, and the
      // handler was never told which model to run. This was missed by an audit that exercised
      // only the string form, which is the same defect one level up.
      const spawnSubject = args[0];
      const persona =
        typeof spawnSubject === "string" ? spawnSubject : String(option(spawnSubject, "persona"));
      const model = typeof spawnSubject === "string" ? undefined : (option(spawnSubject, "model") as string | undefined);
      const variant = typeof spawnSubject === "string" ? undefined : (option(spawnSubject, "variant") as string | undefined);
      // Every accepted option is forwarded, including the three that are policy rather than
      // identity. Dropping them here would be silent: the validator accepts `permits`, so an
      // author who writes a budget gets no error and no budget. They are deliberately absent
      // from `hashedOptions` (§5.12) because they decide the INTERPRETATION of a result, not the
      // recorded fact, so they are reapplied from current source on resume rather than hashed.
      const req = {
        persona,
        ...(model !== undefined ? { model } : {}),
        ...(variant !== undefined ? { variant } : {}),
        ...(option(bag, "worktree") !== undefined ? { worktree: option(bag, "worktree") as string } : {}),
        ...(option(bag, "role") !== undefined ? { role: option(bag, "role") as string } : {}),
        ...(option(bag, "join") !== undefined ? { join: option(bag, "join") as ChannelHandleValue[] } : {}),
        ...(option(bag, "permits") !== undefined
          ? { permits: option(bag, "permits") as Record<string, unknown> }
          : {}),
        ...(option(bag, "supervise") !== undefined
          ? { supervise: option(bag, "supervise") as Record<string, unknown> }
          : {}),
        ...(option(bag, "onFork") !== undefined ? { onFork: option(bag, "onFork") as "respawn" | "adopt" } : {}),
      };
      return await performEffect(host,
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
      const deadline = option(bag, "deadline") as string | undefined;
      return await performEffect(host,
        "turn",
        stepName as string,
        { agent: agent.agent, deadline: deadline ?? null },
        (ctx) => handler.turn({ agent, ...(deadline !== undefined ? { deadline } : {}) }, ctx),
        frame,
      );
    }
    case "ask": {
      const agent = deepFreeze(args[0]) as AgentHandleValue;
      const schema = option(bag, "schema");
      // Both of these END THE ASKING: `deadline` is the cutoff and `attempts` is how many
      // schema-failed replies are tolerated before it gives up. A record made under one attempt
      // is not an answer to what five attempts would have produced.
      const deadline = option(bag, "deadline") as string | undefined;
      const attempts = option(bag, "attempts") as number | undefined;
      return await performEffect(host,
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
      const onExpiry = option(bag, "onExpiry") as "fail" | "proceed" | "escalate" | undefined;
      const schema = option(bag, "schema");
      // The SAME projection the entry is keyed by, so an attempt's identity is a function of the
      // step it belongs to rather than of anything the escalation invents.
      // Design 5.12, and every field here earns its place. `timeout` STOPS OBSERVATION, so a
      // record made under 1m cannot answer what a 3m wait would have seen. `escalate` and its
      // `to` CREATE AN EFFECT rather than choosing a disposition, so editing them must diverge
      // rather than be reapplied. `fail` versus `proceed` is the one genuine reapply and stays
      // out. Hashing only prompt and schema left a timeout edit replaying clean, which is the
      // silent-wrong-path class this projection exists to close.
      const cpTimeout = option(bag, "timeout") as string | undefined;
      const cpTo = option(bag, "to") as string | undefined;
      const cpInput = {
        prompt,
        schema: schema ?? null,
        timeout: cpTimeout ?? null,
        ...(onExpiry === "escalate" ? { onExpiry, to: cpTo ?? null } : {}),
      };
      return applyCheckpointPolicy(
        (await performEffect(host,
        "checkpoint",
        stepName as string,
        cpInput,
        async (ctx, inputHash) => {
          // ONE hash value, threaded from what the entry is actually keyed by rather than
          // re-digested from the projection here. The two agreed, which is exactly the problem:
          // a second derivation that happens to match is a coincidence maintained by hand, and
          // the first edit to the projection would desync attempt 1's identity from its own
          // step with no type error and no failing test.
          const attemptId = (n: number) => requestId(host.options.runId, ctx.key, inputHash, n);
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
          await host.journal.reissueAs(ctx.key, nextId, 1);
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
      return await performEffect(host,
        "sleep",
        stepName ?? "",
        { duration },
        (ctx) => handler.sleep({ duration }, ctx),
        frame,
      );
    }
    case "wait": {
      const event = deepFreeze(args[0]) as EventDescriptor;
      const timeout = option(bag, "timeout") as string | undefined;
      // A `wait` that resolved null did not observe "the event never happens": it observed "the
      // event did not happen WITHIN THIS TIMEOUT". Editing the timeout therefore asks a different
      // question, and replaying the recorded null answers the old one. This is the same hole the
      // checkpoint projection closed, and leaving it open here left `?? recovery` steering off a
      // stale cutoff.
      return await performEffect(host,
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
      return await performEffect(host,
        "notify",
        stepName ?? "",
        { agents: agents.map((a) => a.agent), fact },
        (ctx) => handler.notify({ agents, fact }, ctx),
        frame,
      );
    }
    case "monitor": {
      const agent = deepFreeze(args[0]) as AgentHandleValue;
      return await performEffect(host,
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
 * both engines — the shapes on the wire may not fork.
 */
export function freeConstructors(run: RunIdentity): ReadonlyArray<readonly [string, (args: unknown[]) => unknown]> {
  return [
    ["channel", (a) => deepFreeze({ channel: a[0] as string })],
    ["run", () => deepFreeze({ id: run.runId, programHash: run.programHash, startedAt: run.startedAt })],
    ["replied", (a) => deepFreeze({ event: "replied", agent: (a[0] as AgentHandleValue).agent })],
    [
      "message",
      (a) => {
        const ch = (a[0] as ChannelHandleValue).channel;
        const opts = (a[1] ?? {}) as Record<string, unknown>;
        return deepFreeze({
          event: "message",
          channel: ch,
          ...(opts.from !== undefined ? { from: (opts.from as AgentHandleValue).agent } : {}),
          ...(opts.matches !== undefined ? { matches: opts.matches as string } : {}),
        });
      },
    ],
    ["idle", (a) => deepFreeze({ event: "idle", channel: (a[0] as ChannelHandleValue).channel, duration: a[1] as string })],
    ["down", (a) => deepFreeze({ event: "down", agent: (a[0] as AgentHandleValue).agent })],
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
 * lane that does not edit it. This is the shape the scope machinery actually uses, and both satisfy
 * it. `Frame` is the name the moved code already spells, so the move stays a move.
 */
export interface Frame {
  readonly keys: KeyScope;
  readonly clock: RunClock;
  readonly signal: BranchSignal;
  readonly depth: number;
  branch(kind: ScopeKind, name: string | null, occurrence: number, branchKey: string): Frame;
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
 * intent a cancelling scope owes its losers — durable WITH the outcome, because a process dies
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
   * `status: "ok"` — result and error are exclusive, correctly. So a scope that FAILED recorded no
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
 * The digest fact, written wherever the loser set is — a race that FAILED owes its losers exactly
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
 * deliver the outcome. Leading with the delivery is the defect — the next program step can share
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
    // `inputHash` is `{kind, name}` — an arm's body is not in it — and a settled race is
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
    // Consuming the subtree wholesale is right for a resume — the program hash is unchanged, so
    // nothing under this scope can have been removed, and the branches were DECIDED rather than
    // deleted. Under a migration the source HAS changed, and marking every entry beneath the
    // scope accounted for means an effect the new source removed never reaches `orphans()`: a
    // resolved human checkpoint inside the winning branch disappears and L5004 never fires. A
    // silent disappearance whose log line never fires is invisible in the artifact AND in the
    // trace, which is the worst available failure.
    //
    // So the walk enters the RECORDED WINNING branches and runs the ordinary hash and orphan
    // checks inside them, while the losers — decided, not removed — are accounted for as before.
    if (host.options.migration === true) {
      if (subject !== undefined) throw new UnwalkableScope(stepKeyString(scopeKey), "conclave");
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
        throw unwrapScope(e).reason;
      }
      if (entry.endedAt !== undefined) frame.clock.advance(entry.endedAt);
      if (verdict.verdict === "replay-failed") {
        const e = entry.error as EntryError;
        throw new EffectError(e.code, e.kind, e.message, e.detail);
      }
      return (entry.result as { value: unknown }).value;
    }

    // (1) account for the subtree, settling any loser still pending as cancelled;
    await host.journal.consumeScope(stepKeyString(scopeKey), endedAt);
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
  const reqId = recorded?.requestId ?? requestId(host.options.runId, scopeKey, inputHash);
  if (verdict.verdict === "miss") {
    await host.journal.begin(scopeKey, inputHash, host.options.handler.now(), dispatches ? reqId : undefined);
    // The same gap as {@link Interpreter.performEffect}'s begin, for the scope that DISPATCHES: a
    // conclave cancelled while its begin was in flight must not open a channel and join members.
    // The non-dispatching scopes launch no work of their own — each branch effect re-checks its
    // own signal — so only the dispatching path re-checks here.
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
    // BOTH WRAPPERS OR NEITHER — see {@link performEffect}'s bind for the rule and for why it is
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
    outcome = await body(ctx);
  } catch (raw) {
    // The interpreter's facts come out of the envelope; the program's thrown value comes out
    // whole, and is what the caller sees. A value the program threw is never written on.
    const { reason, facts } = unwrapScope(raw);
    // THE SCOPE'S CLOCK AT SETTLE, not the host's clock at append. `runScope` joins the branch
    // clocks before the outcome leaves it, so `frame.clock.now()` here is the greatest `endedAt`
    // the scope's branches awaited — which is what `now()` answers after the scope, live. Replay
    // advances the parent clock from this stamp and enters no branch, so stamping anything else
    // (measured: the handler's clock at append time) makes live and replay disagree on `now()`
    // after every scope whose last-to-land effect was not the handler's last stamp, and a program
    // that branches on `now()` takes a path on resume that the live run never took.
    const endedAt = frame.clock.now();
    if (reason instanceof JournalAppendRejected) throw reason;
    // A close that did not acknowledge settles NOTHING. The entry stays pending, which is exactly
    // what "a close is still owed" looks like in a journal, and the underlying handler error is
    // what the caller sees.
    if (reason instanceof CloseOwed) throw reason.reason;
    if (reason instanceof Cancelled) {
      await host.journal.settle(scopeKey, { status: "cancelled" }, endedAt, facts);
      throw reason;
    }
    // Same rule as the effect path's. The RETHROW below is deliberately left alone: this scope
    // rethrows the raw reason, so a program catching a scope fault sees no language code where the
    // effect path hands it one. That asymmetry predates this rule — measured with a plain throw on
    // both paths — and it is recorded as a finding rather than repaired here, because repairing it
    // moves the spec, the walker and the engine together.
    const err: EntryError =
      reason instanceof EffectError
        ? recordableError(reason, "scope-fault").error
        : { code: "L4000", kind: "scope-fault", message: messageOf(reason) };
    // A rejecting branch cancels its siblings and can crash before they hear it, so a FAILED scope
    // carries the intent too — and a conclave that closed says so even when its body failed.
    await host.journal.settle(scopeKey, { status: "failed", error: err }, endedAt, {
      ...facts,
      ...digestFacts(branchDigest, facts.cancel?.losers),
    });
    throw reason;
  }

  await host.journal.settle(
    scopeKey,
    { status: "ok", result: { branches: outcome.branches, value: deepFreeze(outcome.value) } },
    // The joined branch clock, for the same reason as the failure path above: this is the value
    // `now()` answers after the scope, and the stamp replay hands back must be that value.
    frame.clock.now(),
    {
      ...(outcome.cancel !== undefined ? { cancel: outcome.cancel } : {}),
      ...(outcome.closed !== undefined ? { closed: outcome.closed } : {}),
      ...digestFacts(branchDigest, outcome.cancel?.losers),
    },
  );
  return outcome.value;
}


export async function runScope(
  host: EffectHost,
  name: string,
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
  if (name === "parallel" || name === "race") {
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
    // `running` with it, and `Promise.race([])` NEVER SETTLES — a migration or a fork over a
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
        throw new ScopeBranchMissing(stepKeyString(ctx.key), name, missing, [...only], [...present]);
      }
      // AND THE EMPTY CASE, which the check above cannot see: with no recorded branches at all,
      // "every recorded branch is present" is vacuously true, so the guard passed and the walk
      // still entered nothing and still hung. A guard over an empty set grades nothing and is
      // green forever. Journals written before scopes recorded their arm names on failure are
      // exactly that shape, so this refuses them by name instead of hanging on them. It cannot
      // fire on a scope that has no arms in the source either, because `all` is empty then too.
      if (only.size === 0 && all.length > 0) {
        throw new ScopeBranchMissing(stepKeyString(ctx.key), name, [], [], all.map(([k]) => k));
      }
    }

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
    // A FAILURE IS A SETTLE, so a rejecting arm is a candidate to win — it just wins by failing
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
        (e: unknown) => onSettle(i, e instanceof Cancelled),
      );
    });
    // AND THE CUT IS RE-DECIDED WHEN AN ARM'S OWN CLOCK MOVES. A cancelled arm with an effect
    // already in flight is allowed to see it land — the work was issued before the cancellation
    // — but landing advances the arm's clock, and an arm that lands PAST the frontier has just
    // proven it cannot win. Deciding only at settles left that arm running its pure tail on a
    // verdict reached from its old clock: measured, an infinite pure tail burned the whole step
    // budget and killed a run whose race had already settled `ok`, while a resume of the same
    // journal returned the winner — live and replay disagreeing on the run's outcome. An arm
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
    // Every arm has settled, so whatever cut it did not get earlier no longer matters; the
    // signal still says cancelled, which is what a nested branch that outlives this line reads.
    for (const f of frames) f.signal.cancel("a sibling branch won the race");
    frame.clock.join(frames.map((f) => f.clock));

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

  if (name === "fanOut") {
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
    // and its entries surface as orphans — which is the whole point of walking rather than
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
      for (const f of frames) f.signal.cancel("a sibling branch failed");
      await Promise.allSettled(launched);
      frame.clock.join(frames.map((f) => f.clock));
      const losers = branchKeys.filter((k) => k !== failed);
      throw new ScopeFailed(e, { branches: branchKeys, cancel: { losers, issued: false } });
    }
  }

  if (name === "conclave") {
    // A conclave is a scope AND an effect, and it gets ONE entry, of kind `conclave`, carrying
    // the durable answer to "is this sub-team still live". That answer is the explicit `closed`
    // FACT, not the entry's state: a body that failed after a clean close settles `failed`
    // exactly like one whose close never acknowledged, and only the fact separates them. Pending
    // means a close is still owed. The migrate table reads that fact — an orphaned conclave is
    // rejected unless the scope closed — so a second entry for the close would be a second thing
    // to keep in agreement with the first, and nothing needs it.
    const members = deepFreeze(first) as AgentHandleValue[];
    const fn = (await second()) as (f: Frame, a: unknown[]) => Promise<unknown>;
    const channel = option(bag, "channel") as string | undefined;
    const req: ConclaveRequest = { members, ...(channel !== undefined ? { channel } : {}) };
    const handler = host.options.handler;
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

    // A CANCELLED branch performs no new effects, so a cancelled conclave does not close
    // itself: releasing the membership travels the same recovery path as every other branch-local
    // resource a race loser took. A conclave whose body merely FAILED is not cancelled —
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
