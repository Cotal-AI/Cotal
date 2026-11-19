/** A run's turn and ask clients: `turn` wakes a seat of this run and reads its yield, `ask` relays a
 *  schema-checked pause to a seat and judges its answers, and the roster lookups both share. The
 *  mesh handler composes it; the run-memory maps it writes are the handler's, mutated in place, and
 *  every input, the handler's own members included, is read through the handler at its use. */
import {
  EpEnvelopeError, listRunNotices, markRunNoticeConsumed, principalKey, readCheckpointAnswer, readGoalResult, readGoalStatus,
  type ActionContext, type CheckpointRef, type CheckpointSettleFact, type EpAttributedReply, type EpVerbTarget, type GoalRef,
  type GoalResultFact, type ResolvedService,
} from "@cotal-ai/core";
import {
  Cancelled, EffectError, askSchemaShape, conformsToAskSchema, parseDuration, stepKeyString,
  type AgentHandleValue, type AskFieldKind, type AskRequest, type CancelSignal, type EffectContext, type TurnRequest,
  type TurnResultValue,
} from "@cotal-ai/lang";
import type { KV } from "@nats-io/kv";
import { delay } from "./delay.js";
import { servedDespiteStarvation, type LoopLagObserver } from "./host-starvation.js";
import {
  CheckpointAnswerMissing, TURN_ACCEPT_DEADLINE_MS, WAIT_POLL_MS, parseAgentHandle, seatDownReading,
  type MeshHandlerBinding, type RunMeshServices, type SeatAddress,
} from "./mesh-handler.js";
import type { DeathWatch } from "./mesh-seat-watch.js";
import { askAttemptToken } from "./pause-tokens.js";
import { PauseOverdue } from "./run-pause-host.js";
import { renderRunContext } from "./run-context.js";

type AskSeat = SeatAddress & { schema: unknown };

/** A step key's enclosing scope: the journal's own rendering (`entry.scope`), re-derived so the
 *  live path and the adoption rebuild key the handoff memos identically. */
function scopeOf(key: Parameters<typeof stepKeyString>[0]): string {
  const k = stepKeyString(key);
  return k.slice(0, k.lastIndexOf("/"));
}

/** The recorded ask progress a resume re-enters at, or undefined for a fresh first attempt. The
 *  external is bytes from an earlier process, so the shape is checked rather than trusted. */
function askResume(v: Readonly<Record<string, unknown>> | undefined):
  { attempt: number; deadlineAt: number; refused?: string } | undefined {
  if (v === undefined) return undefined;
  if (!(typeof v.attempt === "number" && v.attempt >= 1 && typeof v.deadlineAt === "number")) return undefined;
  // The refusal is bound with the attempt it belongs to. A resume that dropped it would re-ask the
  // seat with no reason its last answer failed, which is the one thing the re-ask exists to say.
  return {
    attempt: v.attempt,
    deadlineAt: v.deadlineAt,
    ...(typeof v.refused === "string" ? { refused: v.refused } : {}),
  };
}

/** WHY a reply does not conform, per declared field — the refusal an answerer reads off the entry
 *  before answering again. Judged with the same single-field check that judged the reply, so the
 *  description can never disagree with the verdict. */
function askNonconformance(value: unknown, shape: Readonly<Record<string, AskFieldKind>>): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "the reply is not a record";
  const record = value as Record<string, unknown>;
  const bad: string[] = [];
  for (const [field, kind] of Object.entries(shape)) {
    if (conformsToAskSchema({ [field]: record[field] }, { [field]: kind })) continue;
    bad.push(field in record ? `"${field}" wants ${kind}` : `"${field}" is missing (wants ${kind})`);
  }
  return bad.join("; ");
}

/** The handler members the moved code calls on itself, so a patched handler member is the one used. */
interface TurnAskHandler {
  turn(req: TurnRequest, ctx: EffectContext): Promise<TurnResultValue>;
  ask(req: AskRequest, ctx: EffectContext): Promise<unknown>;
  handoffRefusal(fromWorktree: string | undefined, to: unknown): "L4005" | "L4004" | undefined;
  seatAddress(name: string, uid?: string): { address: SeatAddress; why?: undefined } | { address?: undefined; why: "not-in-roster" | "no-floor" };
  waitSender(agent: string): string;
}

/** The roster fields the turn and ask clients read; the handler's entries carry more. */
interface TurnAskRosterEntry {
  handle: AgentHandleValue;
  owner?: string;
  actor?: string;
  uid: string;
  permits?: { turns?: number; wallClockMs?: number };
  spawnedAt?: number;
  host?: string;
}

/** What the turn and ask clients read from the handler that composes them, each at its use. The
 *  maps are the handler's own instances, never copies. */
export interface TurnAskDeps {
  self(): unknown;
  binding(): MeshHandlerBinding;
  kv(): KV;
  services(): RunMeshServices | undefined;
  lag(): LoopLagObserver;
  onStarved(): (note: string) => void;
  roster(): ReadonlyMap<string, TurnAskRosterEntry>;
  turnsTaken(): Map<string, number>;
  handoffMemos(): Map<string, { to: string; fromGoalId: string } | "ambiguous">;
  turnGoals(): Map<string, Set<string>>;
  now(): number;
  actionCtx(): Promise<ActionContext>;
  manager(command: string, instanceId?: string): Promise<ResolvedService>;
  invokeManager(service: ResolvedService, command: string, args: Record<string, unknown> | undefined, opts: { target?: EpVerbTarget; deadlineMs?: number; id?: string }): Promise<EpAttributedReply>;
  relayManagerBeforeSubmit(host: string | undefined, command: string, ref: GoalRef, kind: "turn" | "ask" | "checkpoint", label: string): Promise<ResolvedService>;
  arm(ref: CheckpointRef, deadline: number): Promise<void>;
  expired(ref: CheckpointRef | undefined): Promise<CheckpointSettleFact | undefined>;
  cancelTimer(ref: CheckpointRef): Promise<void>;
  settle(ref: CheckpointRef, signal?: CancelSignal, relayed?: boolean): Promise<CheckpointSettleFact>;
  presenceDeath(name: string, uid: string, watch: DeathWatch, decided: () => Promise<boolean>): Promise<"superseded" | "lapsed" | undefined>;
  relayToSeat(seat: SeatAddress, goalId: string, payload: string, deadlineAt: number, kind: "ask" | "checkpoint", step: string): Promise<void>;
  withdrawCancelledRelay(goalId: string, deadlineAt?: number): Promise<void>;
  recordTurnGoal(handle: string, goalId: string): void;
  recordHandoffMemo(scope: string, to: string, fromGoalId: string): void;
}

/** The turn and ask members of a mesh handler, over the handler's own inputs. */
export class TurnAsk {
  constructor(private readonly deps: TurnAskDeps) {}

  private get handler(): TurnAskHandler { return this.deps.self() as TurnAskHandler; }
  private get binding(): MeshHandlerBinding { return this.deps.binding(); }
  private get kv(): KV { return this.deps.kv(); }
  private get services(): RunMeshServices | undefined { return this.deps.services(); }
  private get lag(): LoopLagObserver { return this.deps.lag(); }
  private get onStarved(): (note: string) => void { return this.deps.onStarved(); }
  private get roster() { return this.deps.roster(); }
  private get turnsTaken() { return this.deps.turnsTaken(); }
  private get handoffMemos() { return this.deps.handoffMemos(); }
  private get turnGoals() { return this.deps.turnGoals(); }
  private now(): number { return this.deps.now(); }
  private actionCtx(): Promise<ActionContext> { return this.deps.actionCtx(); }
  private manager(command: string, instanceId?: string) { return this.deps.manager(command, instanceId); }
  private invokeManager(service: ResolvedService, command: string, args: Record<string, unknown> | undefined, opts: { target?: EpVerbTarget; deadlineMs?: number; id?: string }) {
    return this.deps.invokeManager(service, command, args, opts);
  }
  private relayManagerBeforeSubmit(host: string | undefined, command: string, ref: GoalRef, kind: "turn" | "ask" | "checkpoint", label: string) {
    return this.deps.relayManagerBeforeSubmit(host, command, ref, kind, label);
  }
  private arm(ref: CheckpointRef, deadline: number) { return this.deps.arm(ref, deadline); }
  private expired(ref: CheckpointRef | undefined) { return this.deps.expired(ref); }
  private cancelTimer(ref: CheckpointRef) { return this.deps.cancelTimer(ref); }
  private settle(ref: CheckpointRef, signal?: CancelSignal, relayed?: boolean) { return this.deps.settle(ref, signal, relayed); }
  private presenceDeath(name: string, uid: string, watch: DeathWatch, decided: () => Promise<boolean>) { return this.deps.presenceDeath(name, uid, watch, decided); }
  private relayToSeat(seat: SeatAddress, goalId: string, payload: string, deadlineAt: number, kind: "ask" | "checkpoint", step: string) {
    return this.deps.relayToSeat(seat, goalId, payload, deadlineAt, kind, step);
  }
  private withdrawCancelledRelay(goalId: string, deadlineAt?: number) { return this.deps.withdrawCancelledRelay(goalId, deadlineAt); }
  private recordTurnGoal(handle: string, goalId: string): void { this.deps.recordTurnGoal(handle, goalId); }
  private recordHandoffMemo(scope: string, to: string, fromGoalId: string): void { this.deps.recordHandoffMemo(scope, to, fromGoalId); }

  /**
   * `turn` wakes ONE AGENT for one turn, over the manager's relay (a seat is not an endpoint):
   * the manager accepts the goal, parks the rendered context durably, the seat pulls and yields
   * under its own self reach, and the yield is this goal's terminal. The request id is the goalId,
   * the same recovery discipline as `spawn`: a resumed run re-enters the poll, never re-submits.
   *
   * THREE AUTHORITIES END IT, one per ending. The seat's yield is the manager's `succeeded`
   * terminal, carrying the TurnResult. The DEADLINE is double-covered: the manager arms a
   * goal-bound hold (its expiry commits `failed` reason `turn-deadline`), and this client arms its
   * OWN pause under the step's request id — the L4003 authority that survives a dead manager.
   * DEATH: the manager's reap hook marks pending turns; death rides the deadline terminal as
   * `agentDownAt`. This client's presence watch is the early L4002 authority even while the
   * manager runs. The watch reads death the way `wait(down)` does: a superseded incarnation at
   * once, a lapsed row only once it has stayed absent for {@link LAPSE_CONFIRM_MS} and its manager
   * no longer runs the seat.
   *
   * Handoff honoring (lang §5.3) happens HERE: the scope's pending memo is spent at every turn's
   * begin, and when this turn targets its `to`, the link rides the submission (`handoffFrom`, the
   * manager mirrors it into the terminal) and the bound external state. A handoff YIELD is
   * validated against the run roster: an addressee outside it is L4005, one in a different
   * worktree is L4004.
   */
  async turn(req: TurnRequest, ctx: EffectContext): Promise<TurnResultValue> {
    if (ctx.signal.cancelled) throw new Cancelled(ctx.signal.reason ?? "cancelled");
    const { name, uid } = parseAgentHandle(req.agent.agent);
    const goalId = ctx.requestId;
    const ref: GoalRef = { endpoint: this.binding.endpoint, caller: this.binding.caller, goalId };
    const primary: CheckpointRef = { endpoint: this.binding.endpoint, token: goalId };
    const scope = scopeOf(ctx.key);

    let ext: Readonly<Record<string, unknown>> | undefined =
      ctx.resume?.goalId === goalId ? (ctx.resume as Readonly<Record<string, unknown>>) : undefined;
    if (ext === undefined) {
      const seat = this.handler.seatAddress(name, uid);
      if (seat.address === undefined) {
        if (seat.why === "not-in-roster")
          throw new Error(`turn(${name}#${uid}) addresses an agent that is not in this run's roster; a turn wakes an agent this run spawned`);
        throw new Error(`turn(${name}#${uid}) has no address: the spawn's acceptance floor was never served, so the seat's owner/actor coordinates are unknown`);
      }
      const { owner, actor, host } = seat.address;
      // The permits are the roster entry's, not the address's: a budget is spent per spawn, and
      // the address is only where this turn is sent.
      const entry = this.roster.get(name)!;
      // Spend the scope's handoff memo at BEGIN, honored or not — honoring is immediate-only.
      const memo = this.handoffMemos.get(scope);
      this.handoffMemos.delete(scope);
      const handoffFrom = memo !== undefined && memo !== "ambiguous" && memo.to === name ? memo.fromGoalId : undefined;
      // Render the seat's context: every unconsumed notice addressed to it, as one durable payload.
      const step = stepKeyString(ctx.key);
      // Addressed by the HANDLE COMPOSITE, exactly as `notify` filed them (an incarnation is the
      // addressee, and a successor under the name is somebody else).
      const notices = (await listRunNotices(this.kv, this.binding.endpoint, this.binding.runId, req.agent.agent))
        .filter((n) => n.consumed === undefined);
      const context = renderRunContext({ run: this.binding.runId, step, notices });
      const deadlineMs = parseDuration(req.deadline ?? this.binding.defaultCheckpointTimeout);
      // The agent's permits are budgets this run spends at the call that would exceed them
      // (cotal-lang 6.5, L4001): one turn per `turns`, and a turn whose deadline runs past the
      // agent's remaining wall clock is already over it. Counted on the fresh path only: a resume
      // re-enters a turn the seed already counted from its journal entry.
      const taken = this.turnsTaken.get(`${name}#${uid}`) ?? 0;
      if (entry.permits?.turns !== undefined && taken >= entry.permits.turns)
        throw new EffectError("L4001", "permit-turns", `turn(${name}#${uid}) would be that agent's turn ${taken + 1}, past its permit of ${entry.permits.turns}`);
      if (entry.permits?.wallClockMs !== undefined && entry.spawnedAt !== undefined) {
        const remaining = entry.spawnedAt + entry.permits.wallClockMs - this.now();
        if (remaining <= 0)
          throw new EffectError("L4001", "permit-wall-clock", `turn(${name}#${uid}): the agent's wall-clock permit (${entry.permits.wallClockMs}ms from its spawn) is spent`);
        if (deadlineMs > remaining)
          throw new EffectError("L4001", "permit-wall-clock", `turn(${name}#${uid}): a ${deadlineMs}ms deadline runs past the agent's remaining wall clock (${remaining}ms of its ${entry.permits.wallClockMs}ms permit)`);
      }
      const payload = JSON.stringify({ run: this.binding.runId, step, context, noticeIds: notices.map((n) => n.noticeId) });
      let submitted = false;
      const submit = async (): Promise<EpAttributedReply> => {
        const service = submitted ? await this.manager("turn", host)
          : await this.relayManagerBeforeSubmit(host, "turn", ref, "turn", `turn(${name}#${uid})`);
        // After invocation may have run, retain the existing goal reconciliation.
        submitted = true;
        return this.invokeManager(service, "turn",
          { payload, deadlineMs, ...(handoffFrom !== undefined ? { handoffFrom } : {}) }, {
            id: goalId,
            deadlineMs: TURN_ACCEPT_DEADLINE_MS,
            target: { mode: "owner", owner, actor, lifecycleUid: uid },
          });
      };

      let reply: EpAttributedReply | undefined;
      try {
        reply = await submit();
      } catch (err) {
        // The invoke did not come back — the goal record is the arbiter, exactly as in `spawn`.
        if ((await readGoalStatus(await this.actionCtx(), ref)) === undefined) throw err;
      }
      // ONE reading of a refused acceptance, for both submits: a seat that dies between the first
      // submit and the re-read is the same dead seat, and the resubmit path classing it as an
      // ordinary refusal made an L4002 the program can catch arrive as an uncatchable L4000.
      const refusal = (r: EpAttributedReply, resubmitted: boolean): Error => {
        const err = r.reply.error;
        // `expired` is the serve boundary's "target is not a live managed agent". From the placed
        // host that is the seat's own manager answering about it. From the class rail it is only
        // the members this call reached, so the message does not claim more than that.
        if (err?.code === "expired")
          return new EffectError("L4002", "turn", `turn(${name}#${uid}) ${seatDownReading(err, host)} before the relay began: ${err.message}`);
        return new Error(resubmitted
          ? `turn(${name}#${uid}) landed but its acceptance could not be re-read: ${err?.message ?? "refused with no message"}`
          : `turn(${name}#${uid}) was refused by the ${this.binding.endpoint} endpoint: ${err?.message ?? "refused with no message"}`);
      };
      if (reply !== undefined && reply.reply.ok === false) throw refusal(reply, false);
      if (reply === undefined) {
        // The acceptance carries the deadline authority, so a lost reply is asked for again: the
        // same goalId under the same fingerprint is served from the manager's acceptance cache.
        reply = await submit();
        if (reply.reply.ok === false) throw refusal(reply, true);
      }
      const floor = reply.reply.data as { deadlineAt?: unknown } | undefined;
      if (typeof floor?.deadlineAt !== "number")
        throw new Error(`turn(${name}#${uid}) was accepted with no readable deadline (${JSON.stringify(reply.reply.data)}); a garbled acceptance never authorizes (SPEC 13.6)`);
      // ONE deadline for the turn: the acceptance's `deadlineAt` is the instant the manager's own
      // hold denies at, and the client's pause is armed on that same instant. A second clock read
      // before the accept round-trip would fire first by the round-trip plus skew and throw away a
      // yield the manager's window still admitted.
      const deadlineAt = floor.deadlineAt;
      ext = {
        goalId, name, owner, actor, uid, deadlineAt,
        noticeIds: notices.map((n) => n.noticeId),
        ...(handoffFrom !== undefined ? { handoffFrom } : {}),
      };
      await ctx.bind(ext);
      // Spent once the turn is RECORDED, which is the same event the adoption seed counts. Spending
      // it before the submit charged a permit for a turn the seat never saw (a dead seat's L4002,
      // an endpoint refusal), and a recovering run would then read a different number off the
      // journal than the live one held.
      this.turnsTaken.set(`${name}#${uid}`, taken + 1);
    }
    this.recordTurnGoal(`${name}#${uid}`, goalId);
    const deadlineAt = ext.deadlineAt;
    if (typeof deadlineAt !== "number")
      throw new Error(`turn(${name}#${uid}) resumed with no recorded deadline; a garbled external state never authorizes`);
    // The client's OWN deadline authority: minted on the first pass, attached to on re-entry.
    await this.arm(primary, deadlineAt);

    const actx = await this.actionCtx();
    const watch: DeathWatch = {};
    // Only re-enter the read, never the relay submission or its outcome processing. Each read
    // gets the pause plane's bounded timeout/starvation policy and names itself in diagnostics.
    const poll = <T>(what: string, read: () => Promise<T>): Promise<T> => servedDespiteStarvation(async () => {
      if (ctx.signal.cancelled) throw new Cancelled(ctx.signal.reason ?? "cancelled");
      return await read();
    }, this.lag, `turn(${name}#${uid}) ${what}`, this.onStarved);
    const result = () => poll("readGoalResult", () => readGoalResult(actx, ref));
    const expired = () => poll("expired", () => this.expired(primary));
    const decided = async (): Promise<boolean> =>
      ctx.signal.cancelled || (await result()) !== undefined || (await expired()) !== undefined;
    try {
      for (;;) {
        if (ctx.signal.cancelled) throw new Cancelled(ctx.signal.reason ?? "cancelled");
        const fact = await result();
        if (fact !== undefined) {
          await this.cancelTimer(primary);
          return await this.turnOutcome(req, fact, ext, scope, name, uid);
        }
        const ended = await expired();
        if (ended !== undefined)
          throw new EffectError("L4003", "turn-deadline", `turn(${name}#${uid}) deadline elapsed before a yield`);
        const reason = await poll("presenceDeath", () => this.presenceDeath(name, uid, watch, decided));
        if (reason !== undefined) {
          await this.cancelTimer(primary);
          throw new EffectError("L4002", "turn", `turn(${name}#${uid}) found the agent down (${reason}) before a yield`);
        }
        await delay(WAIT_POLL_MS);
      }
    } catch (e) {
      // A turn that ends on the run's side without a yield the run accepted (its deadline, the
      // seat's death, a refused handoff, a cancellation) is not a reply, whatever the relay
      // records later: `wait(replied)` reads the verdict this branch raised, never a stale yield.
      this.turnGoals.get(`${name}#${uid}`)?.delete(goalId);
      // In particular a read that exhausted its retry budget must not leave a live relay that
      // tells the seat its later yield continued a turn the run already abandoned. The ordinary
      // turn verdicts already have an authority: death, the shared deadline, or a yielded handoff.
      // Do not ask a dead manager to confirm the client's independent deadline or death verdict.
      const terminal = e instanceof EffectError && ["L4002", "L4003", "L4004", "L4005"].includes(e.code);
      if (!terminal) {
        // Neither cleanup failure may prevent the other resource from being retired.
        const cleanup = await Promise.allSettled([
          this.cancelTimer(primary),
          this.withdrawCancelledRelay(goalId, deadlineAt),
        ]);
        const failures = cleanup.flatMap((r, i) => r.status === "rejected"
          ? [{ resource: i === 0 ? "primary timer claim" : "relay withdrawal", error: r.reason as unknown }]
          : []);
        if (failures.length > 0) {
          const message = `${e instanceof Error ? e.message : String(e)}; turn cleanup failed: `
            + failures.map((f) => `${f.resource}: ${f.error instanceof Error ? f.error.message : String(f.error)}`).join("; ");
          const cause = new AggregateError([e, ...failures.map((f) => f.error)], message);
          if (e instanceof EffectError) {
            const error = new EffectError(e.code, e.kind, message, e.detail);
            error.cause = cause;
            throw error;
          }
          throw cause;
        }
      }
      throw e;
    }
  }

  /**
   * A yielded handoff's refusal class: L4005 when the addressee is not in this run's roster,
   * L4004 when it sits in a different worktree than the seat handing off, undefined when the
   * handoff is honorable. One reading for the turn that raises it and the `wait(replied)` that
   * must not count it, so the two observers never diverge on a spoofed or misdirected `to`.
   */
  handoffRefusal(fromWorktree: string | undefined, to: unknown): "L4005" | "L4004" | undefined {
    const toName = typeof to === "string" ? to : "";
    const target = this.roster.get(toName);
    if (toName.length === 0 || target === undefined) return "L4005";
    if ((target.handle.worktree ?? undefined) !== (fromWorktree ?? undefined)) return "L4004";
    return undefined;
  }

  /** Map a turn goal's terminal onto the effect's contract: `succeeded` carries the TurnResult
   *  (a handoff addressee resolved against the roster — L4005 outside it, L4004 across
   *  worktrees), `failed` splits on the manager's recorded reason, `cancelled` unwinds. The
   *  consumed notices are marked HERE, by the goal that carried them, tolerating the re-entry
   *  conflict (a crash between the terminal and the mark re-marks on resume). */
  private async turnOutcome(
    req: TurnRequest,
    fact: GoalResultFact,
    ext: Readonly<Record<string, unknown>>,
    scope: string,
    name: string,
    uid: string,
  ): Promise<TurnResultValue> {
    if (fact.state === "cancelled") throw new Cancelled(`the turn goal for ${name}#${uid} was cancelled`);
    if (fact.state === "failed") {
      const d = fact.data as { reason?: unknown; error?: unknown; agentDownAt?: unknown } | undefined;
      // The one reasoned failure a relay commits. A dead target has no early terminal of its own
      // on the goal plane (SPEC 13.6 item 7): the client's presence watch in the poll loop is the
      // first L4002 authority, and a death that rode to the deadline arrives on this same deny,
      // MARKED by the relay (`agentDownAt`) — read here as the agent-down failure it is, never as
      // a deadline the program could have set longer.
      if (d?.reason === "turn-deadline") {
        if (typeof d.agentDownAt === "number")
          throw new EffectError("L4002", "turn", `turn(${name}#${uid}) found the agent down (it left presence at ${new Date(d.agentDownAt).toISOString()}) before a yield; the deadline terminal carries its death`);
        throw new EffectError("L4003", "turn-deadline", `turn(${name}#${uid}) deadline elapsed before a yield`);
      }
      throw new Error(`turn(${name}#${uid}) failed at the ${this.binding.endpoint} endpoint: ${typeof d?.error === "string" ? d.error : JSON.stringify(fact.data)}`);
    }
    if (fact.state !== "succeeded")
      throw new Error(`turn(${name}#${uid}) settled ${fact.state}; a turn's yield is a succeeded terminal or a reasoned failure, never this`);
    const d = fact.data as { status?: unknown; to?: unknown; note?: unknown; at?: unknown } | undefined;
    if ((d?.status !== "done" && d?.status !== "blocked" && d?.status !== "handoff") || typeof d.at !== "number")
      throw new Error(`turn(${name}#${uid}) succeeded with a malformed TurnResult (${JSON.stringify(fact.data)}); a garbled terminal never yields a result`);
    let to: AgentHandleValue | undefined;
    if (d.status === "handoff") {
      const toName = typeof d.to === "string" ? d.to : "";
      const refusal = this.handler.handoffRefusal(req.agent.worktree, d.to);
      if (refusal === "L4005")
        throw new EffectError("L4005", "turn-handoff", `turn(${name}#${uid}) yielded a handoff to "${toName}", which is not in this run's roster`);
      const target = this.roster.get(toName)!;
      if (refusal === "L4004")
        throw new EffectError("L4004", "turn-handoff", `turn(${name}#${uid}) yielded a handoff to "${toName}" across worktrees (${req.agent.worktree ?? "none"} -> ${target.handle.worktree ?? "none"}); you cannot hand someone a working tree they are not in`);
      to = target.handle;
    }
    // The notices this turn carried are consumed by THIS goal — the create-only CAS arbitrates,
    // and a re-entry's conflict reads as "already recorded", never as a failure.
    const noticeIds = Array.isArray(ext.noticeIds) ? ext.noticeIds.filter((n): n is string => typeof n === "string") : [];
    for (const noticeId of noticeIds) {
      try {
        await markRunNoticeConsumed(this.kv, this.binding.endpoint, this.binding.runId, req.agent.agent, noticeId, String(ext.goalId), this.now());
      } catch (e) {
        if (!(e instanceof EpEnvelopeError && e.code === "conflict")) throw e;
      }
    }
    if (d.status === "handoff" && to !== undefined)
      this.recordHandoffMemo(scope, parseAgentHandle(to.agent).name, String(ext.goalId));
    return {
      status: d.status,
      ...(to !== undefined ? { to } : {}),
      ...(typeof d.note === "string" ? { note: d.note } : {}),
      at: d.at,
    };
  }

  /**
   * `ask` is a schema-checked pause the ADDRESSED AGENT is expected to answer.
   *
   * Each attempt is one checkpoint-plane pause — the same mint, settle and answer record a
   * `checkpoint` rides, answered through the run driver's `resolveCheckpoint` (`cotal run
   * answer`), which is how "the agent publishes a record" reaches a holder-bound plane: the agent,
   * or anyone the run's ACL admits on its behalf, answers through the driver exactly as a human
   * answers a checkpoint. What `ask` adds is the handler-side contract of §6.5: the schema is read
   * as the SHORTHAND (refused L4022 when it cannot be), every answer is checked against it, a
   * non-conforming answer costs one attempt and the refusal reason is bound onto the entry for the
   * answerer to read, and exhausted attempts are the effect's own catchable L4006.
   *
   * **One absolute deadline for the whole ask**, computed once and bound with the first attempt: a
   * re-ask does not restart the clock, or a stream of non-conforming answers could stretch the
   * pause forever. The deadline elapsing with no conforming answer is the ask's own L4006, the
   * same outcome exhausted attempts name: the budget it ran out of is the ask's, and L4003 belongs
   * to a `turn` whose own deadline elapsed.
   *
   * **Attempt N's token derives from the step's request id** (attempt 1 IS the request id), and
   * the CURRENT attempt's token is bound as `askToken` before its pause is armed — so a resume
   * re-enters the attempt in flight, an answer judged non-conforming just before a crash is
   * re-judged identically from its durable settle, and the discharge and the adoption re-arm
   * address the one timer that is actually armed.
   */
  async ask(req: AskRequest, ctx: EffectContext): Promise<unknown> {
    if (ctx.signal.cancelled) throw new Cancelled(ctx.signal.reason ?? "cancelled");
    const shape = askSchemaShape(req.schema);
    if (shape === null) {
      throw new EffectError(
        "L4022",
        "ask-schema-unreadable",
        `L4022 Unreadable ask schema\n\n  step  ${stepKeyString(ctx.key)}\n\nThe schema is not the shorthand this handler enforces: a record mapping each field name to one of "string", "number", "boolean", "array", "record", "null".\n\nFix: write the shorthand, for example { steps: "array" }, or pass {} to accept any record.`,
      );
    }
    const attempts = req.attempts ?? 1;
    // The seat the ask is told to, resolved before anything binds: an ask addresses an agent this
    // run spawned, and one it cannot tell opens no attempt.
    const seat = this.askSeat(req, ctx);
    const resume = askResume(ctx.resume);
    const deadlineAt = resume?.deadlineAt
      ?? this.now() + parseDuration(req.deadline ?? this.binding.defaultCheckpointTimeout);
    let attempt = resume?.attempt ?? 1;
    // The resumed attempt is already bound; every attempt this call opens binds before it arms.
    let bindOwed = resume === undefined;
    let refused: string | undefined = resume?.refused;
    for (;;) {
      const token = askAttemptToken(ctx.requestId, attempt);
      if (bindOwed) {
        await ctx.bind({
          attempt,
          askToken: token,
          deadlineAt,
          ...(refused !== undefined ? { refused } : {}),
        });
      }
      bindOwed = true;
      // The addressed agent is TOLD: the attempt rides the turn relay under the attempt's own
      // token, carrying the token, the schema, the attempt count, the deadline and the previous
      // refusal, so the seat can answer through `cotal run answer`. Idempotent by goal id: a
      // re-entry finds the relay already accepted and submits nothing.
      await this.relayAsk(seat, ctx, token, { attempt, attempts, deadlineAt, ...(refused !== undefined ? { refused } : {}) });
      const ref: CheckpointRef = { endpoint: this.binding.endpoint, token };
      // The deadline is the ask's whole budget of time: passing it with no conforming record
      // is the same outcome exhausted attempts name (L4006), never a turn's deadline (L4003),
      // and that holds when it passed while the attempt was bound and relayed, before its pause
      // could be minted.
      const expired = () => new EffectError(
        "L4006",
        "ask-deadline",
        `ask(${stepKeyString(ctx.key)}) produced no conforming record before its recorded deadline: attempt ${attempt} of ${attempts} was still open when it passed`,
      );
      try {
        await this.arm(ref, deadlineAt);
      } catch (e) {
        if (e instanceof PauseOverdue) throw expired();
        throw e;
      }
      const settled = await this.settle(ref, ctx.signal, true);
      if (settled.settle === "expired") throw expired();
      const answer = settled.answerId === undefined
        ? undefined
        : this.services ? await this.services.pauses.readAnswer(token) : await readCheckpointAnswer(this.kv, this.binding.endpoint, token, settled.answerId);
      if (answer === undefined) throw new CheckpointAnswerMissing(token, settled.answerId);
      if (conformsToAskSchema(answer.value, shape)) return answer.value;
      const why = askNonconformance(answer.value, shape);
      if (attempt >= attempts) {
        throw new EffectError(
          "L4006",
          "ask-nonconforming",
          `L4006 ask never produced a conforming record\n\n  step  ${stepKeyString(ctx.key)}\n\n${attempts} repl${attempts === 1 ? "y was" : "ies were"} checked against the schema and none conformed; the last was refused: ${why}.\n\nFix: have the agent publish a record matching the schema, widen the schema, or raise attempts.`,
        );
      }
      refused = why;
      attempt += 1;
    }
  }

  /**
   * One ask attempt's relay to the addressed seat: a `turn` goal under the attempt's token whose
   * payload carries the ask (token, schema, attempt, deadline, the previous refusal), rendered by
   * the seat's connector as the request to answer. The goal is the seat's to yield when it has
   * answered; the ask itself settles on the checkpoint plane, so the relay's terminal is never
   * read here, and it is never a reply `wait(replied)` observes. A seat the serve boundary reports
   * gone is the agent-down failure (L4002).
   */
  private askSeat(req: AskRequest, ctx: EffectContext): AskSeat {
    const { name, uid } = parseAgentHandle(req.agent.agent);
    const seat = this.handler.seatAddress(name, uid);
    const step = stepKeyString(ctx.key);
    if (seat.address === undefined) {
      if (seat.why === "not-in-roster")
        throw new Error(`ask(${step}) addresses ${name}#${uid}, which is not in this run's roster; an ask is relayed to an agent this run spawned`);
      throw new Error(`ask(${step}) has no address for ${name}#${uid}: the spawn's acceptance floor was never served, so the seat's owner/actor coordinates are unknown`);
    }
    return { ...seat.address, schema: req.schema };
  }

  /**
   * Where a relay to an agent of this run is addressed: the roster entry under the handle's name,
   * at the handle's incarnation, with the owner/actor coordinates its acceptance floor served.
   * One resolver for the three relays (`turn`, `ask`, an escalation), because the three
   * dispositions differ and the lookup does not: a turn and an ask refuse, an escalation stands.
   */
  seatAddress(name: string, uid?: string): { address: SeatAddress; why?: undefined } | { address?: undefined; why: "not-in-roster" | "no-floor" } {
    const entry = this.roster.get(name);
    if (entry === undefined || (uid !== undefined && entry.uid !== uid)) return { why: "not-in-roster" };
    if (entry.owner === undefined || entry.actor === undefined) return { why: "no-floor" };
    return { address: { name, uid: entry.uid, owner: entry.owner, actor: entry.actor, ...(entry.host !== undefined ? { host: entry.host } : {}) } };
  }

  /**
   * The principal a `message` wait's `from` handle names, as `<owner>.<actor>`: the coordinates
   * this run's roster recorded when it spawned the seat or bound the participant. A message
   * answers only when its subject's sender is that principal. A handle outside the roster, or one
   * whose coordinates were never served, refuses: matching it on a display name would let any peer
   * that names itself after the agent answer.
   */
  waitSender(agent: string): string {
    const { name, uid } = parseAgentHandle(agent);
    const seat = this.handler.seatAddress(name, uid);
    if (seat.address === undefined) {
      if (seat.why === "not-in-roster")
        throw new Error(`wait(message(..., { from: ${name}#${uid} })) names an agent that is not in this run's roster; \`from\` takes a handle this run spawned or bound with participant()`);
      throw new Error(`wait(message(..., { from: ${name}#${uid} })) has no sender to match: the spawn's acceptance floor was never served, so the seat's owner/actor coordinates are unknown`);
    }
    return principalKey(seat.address.owner, seat.address.actor).key;
  }

  private async relayAsk(
    seat: AskSeat,
    ctx: EffectContext,
    token: string,
    ask: { attempt: number; attempts: number; deadlineAt: number; refused?: string },
  ): Promise<void> {
    const step = stepKeyString(ctx.key);
    const context = renderRunContext({ run: this.binding.runId, step, notices: [] });
    const payload = JSON.stringify({
      run: this.binding.runId, step, context, noticeIds: [],
      ask: { token, schema: seat.schema, attempt: ask.attempt, attempts: ask.attempts, deadlineAt: ask.deadlineAt, ...(ask.refused !== undefined ? { refused: ask.refused } : {}) },
    });
    await this.relayToSeat(seat, token, payload, ask.deadlineAt, "ask", step);
  }
}
