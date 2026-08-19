/**
 * The journalled effect path, engine side — the sequential fragment.
 *
 * TEMPORARY BY CONSTRUCTION. Seam ruling 1 granted the orchestrator's extraction: `performEffect`
 * and the per-primitive hashed projections move out of `interpret.ts` into a module BOTH engines
 * import, as a pure move proven both ways. When that lands on `feat/lang-engine`, this file is
 * deleted and `__ctx.effect` calls the shared one. It exists only so lane T's differential leg can
 * start before the extraction is up, and it is written to be deleted: the projections below are the
 * walker's, line for line, so the diff against the extracted module is empty rather than a merge.
 *
 * Nothing here invents a rule. Every hashed projection, every option that is folded in and every one
 * that is deliberately left out, is the walker's choice — the journal is the contract and the
 * differential suite compares it entry for entry.
 */

import { RuntimeFault, RunDivergence } from "../interpret.js";
import { parseDuration } from "../duration.js";
import {
  applyCheckpointPolicy,
  Cancelled,
  EffectError,
  RunReleased,
  type AgentHandleValue,
  type ChannelHandleValue,
  type CheckpointRaw,
  type EffectContext,
  type EventDescriptor,
} from "../effects.js";
import { JournalAppendRejected, type EntryError } from "../journal.js";
import { digest, requestId, stepKeyString, type StepKey } from "../keys.js";
import { notifyFactViolation } from "../notify-fact.js";
import { PRIMITIVES, type EffectKind } from "../primitives.js";
import { NotCrossable, assertCrossable, deepFreeze } from "../values.js";
import { currentFrame, type EngineFrame } from "./frame.js";
import type { EngineRun, Site } from "./ctx.js";

/** A message from a host error, read defensively: a handler may throw a primitive or null. */
function messageOf(v: unknown): string {
  if (v instanceof Error) return v.message;
  if (typeof v === "string") return v;
  return String(v);
}

const option = (bag: unknown, key: string): unknown =>
  bag === null || typeof bag !== "object" ? undefined : (bag as Record<string, unknown>)[key];

export type Perform = (name: string, args: unknown[], site?: Site) => Promise<unknown>;

export function createPerformer(run: EngineRun): Perform {
  // THE CEILING IS A RUN BOUND, so the count starts where the run left off. Starting at 0 would give
  // every activation a full allowance, and a runaway loop that crashed periodically would never
  // reach the ceiling however much it performed against the world.
  let effectCount = run.journal.dispatchedEffects();

  /**
   * Perform one effect, or replay it. Everything durable happens here: a handler is called only in
   * the `miss` and `pending` cases, and in `pending` it is told to re-bind rather than re-issue.
   */
  async function performEffect(
    kind: EffectKind,
    name: string,
    hashedInput: unknown,
    dispatch: (ctx: EffectContext, inputHash: string) => Promise<unknown>,
    frame: EngineFrame,
  ): Promise<unknown> {
    const key: StepKey = frame.keys.nextEffect(kind, name);
    const inputHash = digest(hashedInput ?? null);
    const verdict = run.journal.lookup(key, inputHash);

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

    // A cancelled branch performs no NEW effects. That is the whole of the cancellation law on this
    // side: work already in flight is another matter, and the handler owns it.
    if (frame.signal.cancelled) throw new Cancelled(frame.signal.reason ?? "cancelled");

    // THE HOST'S STOP, asked before anything is begun and after every replay has been served: no
    // entry written, no handler dispatched, so the run is exactly where it says it is.
    const stop = run.shouldStop?.();
    if (stop !== undefined) throw new RunReleased(stop);

    effectCount += 1;
    if (effectCount > run.pins.effectCeiling) {
      throw new RuntimeFault(
        "L4009",
        `this run has performed more than ${run.pins.effectCeiling} effects, which means a loop is not terminating. Add an exit condition or a permit.`,
      );
    }

    const resume = verdict.verdict === "pending" ? verdict.entry.external : undefined;
    // RECOVERY SUBMITS UNDER THE RECORDED IDENTITY. Re-deriving happens to agree whenever nothing
    // moved, which is exactly why it reads as correct: the point of writing the id down is the case
    // where it does not.
    const recorded = verdict.verdict === "pending" && verdict.entry.requestId !== undefined ? verdict.entry : undefined;
    const reqId = recorded?.requestId ?? requestId(run.runId, key, inputHash);
    const attempt = recorded?.attempt ?? 0;

    if (verdict.verdict === "miss") {
      // AWAITED, and the await is the point: the request id has to be durable BEFORE the work is
      // issued, or a crash in the gap leaves real work that nothing in the journal names.
      await run.journal.begin(key, inputHash, run.handler.now(), reqId);
      // That await is a gap, and the cancellation law holds on both sides of it: while the append
      // was in flight a sibling can have settled a race and cancelled this branch. The pending entry
      // is real, so it settles as what this branch now is.
      if (frame.signal.cancelled) {
        await run.journal.settle(key, { status: "cancelled" }, run.handler.now());
        throw new Cancelled(frame.signal.reason ?? "cancelled");
      }
    }

    const ctx: EffectContext = {
      key,
      signal: frame.signal,
      requestId: reqId,
      attempt,
      ...(resume !== undefined ? { resume } : {}),
      bind: async (external) => {
        await run.journal.bind(key, external);
      },
    };

    // TWO FAILURE DOMAINS, AND THE TERMINAL APPEND IS NOT IN THE HANDLER'S. One `try` around both
    // the dispatch and the settle records a store's refusal as a handler fault, and then every later
    // replay reports failure for work the world actually did.
    let result: unknown;
    try {
      result = await dispatch(ctx, inputHash);
      assertCrossable(result, `the result of ${stepKeyString(key)}`);
    } catch (e) {
      const endedAt = run.handler.now();
      // A journal that just refused an append cannot be asked to record why.
      if (e instanceof JournalAppendRejected) throw e;
      if (e instanceof Cancelled) {
        await run.journal.settle(key, { status: "cancelled" }, endedAt);
        throw e;
      }
      // A handler may raise a language code directly and it survives; anything else a thrown object
      // happens to call `code` is a handler fault and is recorded as one.
      const raised = (e as { code?: unknown } | null | undefined)?.code;
      const carried = typeof raised === "string" && /^L\d{4}$/.test(raised) ? raised : null;
      const error: EntryError =
        e instanceof EffectError
          ? { code: e.code, kind: e.kind, message: e.message, ...(e.detail !== undefined ? { detail: e.detail } : {}) }
          : { code: carried ?? "L4000", kind: "handler-fault", message: messageOf(e) };
      await run.journal.settle(key, { status: "failed", error }, endedAt);
      frame.clock.advance(endedAt);
      throw e instanceof EffectError ? e : new EffectError(error.code, error.kind, error.message);
    }

    const endedAt = run.handler.now();
    await run.journal.settle(key, { status: "ok", result: deepFreeze(result) }, endedAt);
    frame.clock.advance(endedAt);
    return result;
  }

  return async function perform(name: string, args: unknown[], _site?: Site): Promise<unknown> {
    const spec = PRIMITIVES[name];
    if (spec === undefined) throw new RuntimeFault("L2001", `${name} is not a primitive`);
    if (spec.opensScope) {
      // Loud, not a fallback. The scope-openers are the next landing; a silent sequential execution
      // of a `parallel` would journal a scope entry nobody opened and pass the differential suite on
      // every program that does not race.
      throw new RuntimeFault(
        "L1000",
        `\`${name}\` opens a concurrency scope, and the engine's scope machinery is not landed yet. Run this program on the walker.`,
      );
    }

    const frame = currentFrame();

    // Every argument crosses the effect boundary: it is hashed, recorded, or handed to the handler,
    // and a value with no canonical form can be none of those. Refused HERE, with the argument
    // named, before any entry is written.
    args.forEach((arg, i) => {
      try {
        assertCrossable(arg, `argument ${i + 1} of \`${name}\``);
      } catch (e) {
        if (e instanceof NotCrossable) throw new RuntimeFault(e.why === "function" ? "L3042" : "L3041", e.message);
        throw e;
      }
    });
    // FREEZE ON SHARE, at the share: what crossed is what was hashed and recorded, so neither the
    // program nor the handler may change it afterwards.
    for (const arg of args) deepFreeze(arg);

    const bag = args[spec.optionsAt];
    const stepName = (name === "checkpoint" ? args[0] : option(bag, "name")) as string | undefined;
    const handler = run.handler;

    switch (name) {
      case "spawn": {
        const subject = args[0];
        const persona = typeof subject === "string" ? subject : String(option(subject, "persona"));
        const model = typeof subject === "string" ? undefined : (option(subject, "model") as string | undefined);
        const variant = typeof subject === "string" ? undefined : (option(subject, "variant") as string | undefined);
        const req = {
          persona,
          ...(model !== undefined ? { model } : {}),
          ...(variant !== undefined ? { variant } : {}),
          ...(option(bag, "worktree") !== undefined ? { worktree: option(bag, "worktree") as string } : {}),
          ...(option(bag, "role") !== undefined ? { role: option(bag, "role") as string } : {}),
          ...(option(bag, "join") !== undefined ? { join: option(bag, "join") as ChannelHandleValue[] } : {}),
          ...(option(bag, "permits") !== undefined ? { permits: option(bag, "permits") as Record<string, unknown> } : {}),
          ...(option(bag, "supervise") !== undefined ? { supervise: option(bag, "supervise") as Record<string, unknown> } : {}),
          ...(option(bag, "onFork") !== undefined ? { onFork: option(bag, "onFork") as "respawn" | "adopt" } : {}),
        };
        return await performEffect(
          "spawn",
          stepName ?? persona,
          // Model and variant are part of the IDENTITY being spawned, so they are hashed with the
          // persona: a run that swapped the model under a recorded agent would be replaying a fact
          // about a different agent. `permits`/`supervise`/`onFork` are policy, reapplied from
          // current source on resume rather than hashed.
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
        // The deadline STOPS OBSERVATION, so it belongs in the projection: a turn recorded under a
        // 1m deadline cannot answer what a 10m turn would have produced.
        const deadline = option(bag, "deadline") as string | undefined;
        return await performEffect(
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
        // Both of these END THE ASKING: `deadline` is the cutoff, `attempts` is how many
        // schema-failed replies are tolerated before it gives up.
        const deadline = option(bag, "deadline") as string | undefined;
        const attempts = option(bag, "attempts") as number | undefined;
        return await performEffect(
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
        // live path and the replay path alike: performEffect returns the RAW outcome, and the policy
        // sandwich closes here, so a resumed run under an edited onExpiry throws even though nothing
        // about the recorded expiry changed.
        const onExpiry = option(bag, "onExpiry") as "fail" | "proceed" | "escalate" | undefined;
        const schema = option(bag, "schema");
        const cpTimeout = option(bag, "timeout") as string | undefined;
        const cpTo = option(bag, "to") as string | undefined;
        const cpInput = {
          prompt,
          schema: schema ?? null,
          timeout: cpTimeout ?? null,
          ...(onExpiry === "escalate" ? { onExpiry, to: cpTo ?? null } : {}),
        };
        return applyCheckpointPolicy(
          (await performEffect(
            "checkpoint",
            stepName as string,
            cpInput,
            async (ctx, inputHash) => {
              // ONE hash value, threaded from what the entry is actually keyed by rather than
              // re-digested here: a second derivation that happens to agree is a coincidence
              // maintained by hand.
              const attemptId = (n: number) => requestId(run.runId, ctx.key, inputHash, n);
              const req = {
                prompt,
                ...(schema !== undefined ? { schema } : {}),
                ...(cpTimeout !== undefined ? { timeout: cpTimeout } : {}),
                ...(onExpiry !== undefined ? { onExpiry } : {}),
                ...(cpTo !== undefined ? { to: cpTo } : {}),
              };
              // THE FINAL MINT DOES NOT ASK FOR AN ESCALATION: the one-hop stop rule is the
              // interpreter's, and it can only own it if the far side is not simultaneously told to
              // hop.
              const finalReq = onExpiry === "escalate" ? { ...req, onExpiry: "proceed" as const } : req;

              // RECOVERY COMPLETES THE OPEN ATTEMPT. IT DOES NOT REPLAY THE CHAIN. A non-zero
              // attempt means the hop was issued before the crash, so the far side already holds
              // work under this id; re-running from the top would read that call's cached expiry as
              // a second observation.
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
                // `ctx.attempt`, not a literal 0: the literal relabels a recovery's open attempt as
                // the first one and erases the hop from the journal.
                return { ...first, attempts: [{ attempt: ctx.attempt, requestId: ctx.requestId, settled: first.outcome }] };
              }
              // ESCALATION STAYS INSIDE THIS ENTRY: the program made one call, so a second mint must
              // not become a second occurrence — but it does need a second IDENTITY, derived and
              // recorded before the mint, or a crash in between leaves live work unnamed.
              const nextId = attemptId(1);
              await run.journal.reissueAs(ctx.key, nextId, 1);
              const second = await handler.checkpoint(finalReq, { ...ctx, requestId: nextId, attempt: 1 });
              // ONE HOP: an escalation that can escalate again never terminates, so a second expiry
              // settles as expired and the program decides.
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
        // The duration IS hashed: a resumed run reads elapsed time back through the run clock, so
        // editing 1h to 1m must diverge rather than silently keep the path the old duration chose.
        return await performEffect("sleep", stepName ?? "", { duration }, (ctx) => handler.sleep({ duration }, ctx), frame);
      }
      case "wait": {
        const event = deepFreeze(args[0]) as EventDescriptor;
        const timeout = option(bag, "timeout") as string | undefined;
        // A `wait` that resolved null observed "not within THIS timeout", never "never", so editing
        // the timeout asks a different question and replaying the recorded null answers the old one.
        return await performEffect(
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
        // THE BOUND, WHERE THE VALUE EXISTS. Checked BEFORE the entry is written, so a fact that
        // breaks it never reaches a journal, a record, or a handler. An error, never a truncation: a
        // shortened notice still delivers.
        const violation = notifyFactViolation(fact);
        if (violation !== null) throw new RuntimeFault("L3043", violation);
        return await performEffect(
          "notify",
          stepName ?? "",
          { agents: agents.map((a) => a.agent), fact },
          (ctx) => handler.notify({ agents, fact }, ctx),
          frame,
        );
      }
      case "monitor": {
        const agent = deepFreeze(args[0]) as AgentHandleValue;
        return await performEffect(
          "monitor",
          stepName ?? "",
          { agent: agent.agent },
          (ctx) => handler.monitor({ agent }, ctx),
          frame,
        );
      }
      default:
        throw new RuntimeFault("L1000", `${name} is not implemented in this engine`);
    }
  };
}
