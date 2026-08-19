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
import { RunDivergence, RuntimeFault, messageOf } from "./errors.js";
import { digest, requestId, stepKeyString, type KeyScope } from "./keys.js";
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

function option(bag: unknown, key: string): unknown {
  return bag === null || typeof bag !== "object" ? undefined : (bag as Record<string, unknown>)[key];
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
    bind: async (external) => {
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
    const error: EntryError =
      e instanceof EffectError
        ? { code: e.code, kind: e.kind, message: e.message, ...(e.detail !== undefined ? { detail: e.detail } : {}) }
        : { code: carried ?? "L4000", kind: "handler-fault", message: messageOf(e) };
    await host.journal.settle(key, { status: "failed", error }, endedAt);
    frame.clock.advance(endedAt);
    throw e instanceof EffectError ? e : new EffectError(error.code, error.kind, error.message);
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
