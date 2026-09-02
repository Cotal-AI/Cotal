/**
 * The mesh handler: `packages/lang`'s `EffectHandler` over the real planes.
 *
 * The language performs effects through an interface and knows nothing about NATS. The simulator
 * implements that interface with scripted answers, which is what lets a program be tested without a
 * broker. This is the other implementation — the one where an effect actually happens — and it is
 * deliberately thin: everything hard about durability already lives in the planes it calls.
 *
 * **The request id IS the durable token.** `ctx.requestId` is `base64url(sha256(runId, stepKey,
 * inputHash, attempt))`, written onto the pending journal entry BEFORE the handler is called, and
 * it is a valid `<token>` by construction — same alphabet, 43 characters. So a crashed run that
 * resumes re-derives the same token and ATTACHES to the pause the crashed attempt recorded instead
 * of opening a second one. Nothing here remembers anything across a crash, because the identity was
 * recorded before the work started and the pause itself holds the rest: `mintCheckpoint` is
 * idempotent only if the ENTIRE spec is identical, and the deadline in it cannot be recomputed from
 * a clock that has moved, so `arm()` reads the recorded spec rather than doing the arithmetic
 * again.
 */
import { createHash } from "node:crypto";
import {
  mintCheckpoint,
  heartbeatCheckpoint,
  resumeCheckpoint,
  readCheckpointSettle,
  readCheckpointAnswer,
  readCheckpointStatus,
  readCheckpointSpec,
  reconcileCheckpointSchedule,
  handleCheckpointFire,
  checkpointSettleSubject,
  epfStreamName,
  eptStreamName,
  eptSubject,
  chatStream,
  chatSubject,
  isConcreteChannel,
  assertSafePattern,
  assertValidChannel,
  presenceBucket,
  liveKvEntries,
  IncompleteKvScan,
  openMembersRegistry,
  openChannelRegistry,
  writeChannelConfig,
  readMember,
  commitMember,
  tombstoneMember,
  StaleMembershipWrite,
  runNoticeId,
  writeRunNotice,
  actionContext,
  invokeCommand,
  readGoalResult,
  readGoalStatus,
  resolveService,
  listRunNotices,
  markRunNoticeConsumed,
  readRunRecord,
  writeRunStatus,
  EpEnvelopeError,
  type ActionContext,
  type CheckpointRef,
  type CheckpointSettleFact,
  type CotalMessage,
  type EpAttributedReply,
  type EpCaller,
  type GoalRef,
  type GoalResultFact,
  type Presence,
  type ResolvedService,
} from "@cotal-ai/core";
import { renderRunContext } from "./run-context.js";
import type { NatsConnection } from "@nats-io/transport-node";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import {
  parseDuration,
  Cancelled,
  EffectError,
  EffectRefused,
  askSchemaShape,
  conformsToAskSchema,
  type AskFieldKind,
  type AskRequest,
  type AgentHandleValue,
  type CancelSignal,
  type ChannelHandleValue,
  type ConclaveRequest,
  type WaitRequest,
  type CheckpointRaw,
  type CheckpointRequest,
  type EffectContext,
  type JournalEntry,
  type MonitorRequest,
  type NotifyRequest,
  type SleepRequest,
  type SpawnRequest,
  type TurnRequest,
  type TurnResultValue,
  journalEntryKeyString,
  stepKeyString,
} from "@cotal-ai/lang";

/** Who this handler acts as, and where. All of it is the DRIVER's identity, not the program's. */
export interface MeshHandlerBinding {
  readonly space: string;
  /** The endpoint hosting the driver — the manager daemon. */
  readonly endpoint: string;
  /**
   * WHICH RUN this handler performs for.
   *
   * It is here rather than on `EffectContext` because the effect context deliberately
   * carries the step's identity and nothing about the run: `requestId` already folds the run
   * in, and a handler that needed to name the run for recovery would be recovering by something
   * other than the recorded identity. A NOTICE is keyed by its run, though — it is filed onto the
   * run — so the run is part of what this handler is bound to. A drive is already shaped that way:
   * the caller hands `drive()` a run id and a handler together.
   */
  readonly runId: string;
  /**
   * The caller triple this run's durable ACTIONS ride: goal facts key on
   * `epf.<e>.goal.<owner>.<actor>.<uid>.<goalId>.result`, so the triple that submits a spawn must
   * be the triple that reads its terminal back after a crash — on any host, at any epoch. It is
   * therefore RUN-STABLE by contract: derive it from the run id (the run-command derivation), never
   * from the process identity, or a resumed run polls a subject its own submission never wrote.
   */
  readonly caller: EpCaller;
  readonly instanceId: string;
  readonly epoch: number;
  /**
   * MANDATORY, and the reason is worth keeping next to it: a checkpoint's resume is holder-bound,
   * so an omitted holder would make the token a BEARER credential resumable by anyone who learns
   * it (SPEC 13.6/13.10).
   */
  readonly holder: { readonly id: string; readonly lifecycleUid: string };
  /**
   * The deadline a `checkpoint` gets when the program names no `timeout`.
   *
   * MANDATORY, because `mintCheckpoint` requires a future deadline and there is no such thing as a
   * checkpoint that waits forever on this plane: an unbounded pause is a run that can never be
   * reconciled, and picking a silent constant here would be this file deciding a pin. It is read
   * ONLY at the first mint — a resume finds the checkpoint already minted, and the recorded
   * deadline is the authority from then on, so changing this never moves a pause already taken.
   */
  readonly defaultCheckpointTimeout: string;
}

/**
 * A checkpoint resumed with no answer to read.
 *
 * The settle fact is the arbiter and it NAMES the answer it accepted, so a `resumed` settlement
 * with no id — or with an id no record answers to — means the token was presented by something
 * other than the run driver's own `resolveCheckpoint`. There is no honest value to return for it:
 * the program asked a question, something released the pause, and what was answered is not
 * recoverable. Returning `resolved` with an empty value would invent one.
 */
export class CheckpointAnswerMissing extends Error {
  constructor(readonly token: string, readonly answerId: string | undefined) {
    super(
      `checkpoint "${token}" settled as resumed but ${answerId === undefined
        ? "its settle fact names no answer"
        : `no answer record exists under the id ${answerId} it names`}; ` +
        `a workflow checkpoint is answered through the run driver's resolveCheckpoint, which writes the answer BEFORE presenting the token`,
    );
    this.name = "CheckpointAnswerMissing";
  }
}

/** How the handler learns that a checkpoint settled. Injected so a test can drive it directly. */
export interface SettleWatcher {
  /**
   * Resolve when this ref's one-use settle fact exists. Called AFTER the mint, so a fact that
   * already landed — the ordinary case for a run resuming across a crash — must resolve at once
   * rather than wait for an event that has already happened.
   */
  awaitSettle(ref: CheckpointRef): Promise<CheckpointSettleFact>;
}

/**
 * The one subject the remaining seam is gated by: `turn` and `wait(replied)` both ride the turn
 * machinery an agent handle answers through (`spawn`, `conclave`, `ask`, `monitor` and
 * `wait(down)` perform). Named once so the refusals cannot drift apart.
 */
const ACTION_MACHINERY = "the durable-action machinery an agent handle rides";

export class MeshHandler {
  constructor(
    private readonly nc: NatsConnection,
    private readonly kv: KV,
    private readonly js: JetStreamClient,
    private readonly jsm: JetStreamManager,
    private readonly binding: MeshHandlerBinding,
    private readonly watcher: SettleWatcher,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /**
   * The resolved manager service, memoized as a PROMISE so concurrent branches share one describe
   * round-trip — and dropped on failure, so a resolve that lost to a manager restart is retried by
   * the next effect instead of poisoning every spawn for the handler's lifetime.
   */
  private managerService: Promise<ResolvedService> | undefined;
  private manager(): Promise<ResolvedService> {
    this.managerService ??= resolveService(this.nc, this.binding.space, this.binding.endpoint, this.binding.caller)
      .catch((e) => {
        this.managerService = undefined;
        throw e;
      });
    return this.managerService;
  }

  /** The branded goal-fact context over this handler's own connection, memoized the same way. */
  private actions: Promise<ActionContext> | undefined;
  private actionCtx(): Promise<ActionContext> {
    this.actions ??= actionContext(this.nc, this.binding.space).catch((e) => {
      this.actions = undefined;
      throw e;
    });
    return this.actions;
  }

  // The three registries a conclave touches, memoized like the service resolves above. All three
  // are OPENED, never created: the provisioner pre-creates them at `cotal up` (auth mode) and the
  // endpoints create presence/channels lazily in open mode — a mesh where one is genuinely absent
  // was never provisioned for durable membership, and that fails loud rather than self-provisions.
  private presenceKvOpen: Promise<KV> | undefined;
  private presenceRegistry(): Promise<KV> {
    this.presenceKvOpen ??= new Kvm(this.nc).open(presenceBucket(this.binding.space)).catch((e) => {
      this.presenceKvOpen = undefined;
      throw e;
    });
    return this.presenceKvOpen;
  }

  private membersKvOpen: Promise<KV> | undefined;
  private membersRegistry(): Promise<KV> {
    this.membersKvOpen ??= openMembersRegistry(this.nc, this.binding.space).catch((e) => {
      this.membersKvOpen = undefined;
      throw e;
    });
    return this.membersKvOpen;
  }

  private channelsKvOpen: Promise<KV> | undefined;
  private channelRegistry(): Promise<KV> {
    this.channelsKvOpen ??= openChannelRegistry(this.nc, this.binding.space).catch((e) => {
      this.channelsKvOpen = undefined;
      throw e;
    });
    return this.channelsKvOpen;
  }

  /** The chat stream's current last sequence — a conclave join/leave cursor (SPEC §7 interval). */
  private async chatFrontier(): Promise<number> {
    return (await this.jsm.streams.info(chatStream(this.binding.space))).state.last_seq;
  }

  /** The open conclaves this process performed, keyed by the scope's request id, so the close that
   *  follows the body reads the SAME plan the open executed. A crash loses the map and loses
   *  nothing: the plan was bound as the entry's external state before a single row was written,
   *  and a re-entered open repopulates the map from `ctx.resume`. */
  private readonly conclaves = new Map<string, ConclavePlan>();

  /** The run's roster: every agent this run spawned, by name — the handle a handoff resolves to,
   *  and the owner/actor address a `turn` targets (absent when the spawn's acceptance floor was
   *  never served; a `turn` on such an agent refuses loudly rather than guessing an address).
   *  Seeded live by `spawn`, rebuilt at adoption from the journal's settled spawn entries. */
  private readonly roster = new Map<string, { handle: AgentHandleValue; owner?: string; actor?: string; uid: string }>();

  /** The most recent unhonored handoff yield per SCOPE (lang §5.3): the goal-chain linkage memo.
   *  `"ambiguous"` when two pending handoffs in one scope named the same agent — ambiguity records
   *  no linkage at all. Spent (deleted) by the next `turn` in the scope, honored or not: honoring
   *  is immediate-only. Rebuilt at adoption by replaying the same two rules over the journal. */
  private readonly handoffMemos = new Map<string, { to: string; fromGoalId: string } | "ambiguous">();

  now(): number {
    return this.clock();
  }

  /**
   * WHAT to repair when this process takes a run over. The driver decides WHEN and calls this.
   *
   * It is a method rather than an optional hook the host wires: an adopted run whose timers stay
   * armed at the predecessor's coordinates fires where nobody listens, and the object that knows how
   * to re-arm is the one the driver already holds.
   *
   * Failures are raised, not swallowed: a driver holding a run whose pauses it could not re-arm
   * cannot advance it.
   */
  async adopted(entries: readonly JournalEntry[]): Promise<string[]> {
    this.seedRunMemos(entries);
    return await rearmOutstandingPauses(
      { kv: this.kv, js: this.js, jsm: this.jsm },
      this.binding,
      entries,
    );
  }

  /**
   * Rebuild the in-memory run memos an adopted run needs to keep performing `turn`: the roster
   * (from every settled ok `spawn`, its result the handle and its bound floor the address) and the
   * handoff memos (replaying, in journal order, the same two rules the live path applies — a turn's
   * begin spends its scope's memo, a settled handoff yield writes one, a second pending handoff to
   * the same name in one scope makes it ambiguous). Deterministic from the journal alone.
   */
  private seedRunMemos(entries: readonly JournalEntry[]): void {
    for (const e of entries) {
      if (e.kind === "spawn" && e.state === "settled" && e.status === "ok" && e.result !== undefined) {
        const handle = e.result as AgentHandleValue;
        if (typeof handle.agent !== "string") continue; // a garbled result seeds nothing; the turn that needs it refuses loudly
        const { name, uid } = parseAgentHandle(handle.agent);
        const ext = e.external as { owner?: unknown; actor?: unknown } | undefined;
        this.roster.set(name, {
          handle,
          uid,
          ...(typeof ext?.owner === "string" ? { owner: ext.owner } : {}),
          ...(typeof ext?.actor === "string" ? { actor: ext.actor } : {}),
        });
        continue;
      }
      if (e.kind !== "turn") continue;
      this.handoffMemos.delete(e.scope); // its begin spent whatever was pending, honored or not
      if (e.state !== "settled" || e.status !== "ok" || e.result === undefined) continue;
      const r = e.result as TurnResultValue;
      if (r.status !== "handoff" || r.to === undefined || typeof r.to.agent !== "string") continue;
      this.recordHandoffMemo(e.scope, parseAgentHandle(r.to.agent).name, e.requestId ?? "");
    }
  }

  /** One handoff yield's memo write: most-recent-wins across different names, ambiguous when a
   *  pending handoff to the SAME name is already waiting (lang §5.3 — ambiguity records nothing). */
  private recordHandoffMemo(scope: string, to: string, fromGoalId: string): void {
    const prev = this.handoffMemos.get(scope);
    this.handoffMemos.set(scope, prev !== undefined && (prev === "ambiguous" || prev.to === to) ? "ambiguous" : { to, fromGoalId });
  }

  /**
   * End the external state of a cancelled scope's LOSERS: the world half of the discharge the
   * scope entry's `cancel.issued` records (§7.6, and the driver's `dischargeCancellations` is the
   * caller). The entries handed in are the losers' subtrees; what has external state to end is the
   * three pause kinds — a pause's timer is claimed so its armed schedule cannot fire into a run
   * that moved on, and a wait's durable consumer is deleted because a cancelled wait replays as
   * cancelled and nothing will ever read its position.
   *
   * IDEMPOTENT BY THE PLANE: `cancelTimer` declines a pause that is not waiting, the consumer
   * delete tolerates one already gone, and both tolerate a loser that cleaned up after itself on
   * the live path — this is the durable backstop for the process that died before its own cleanup
   * landed, and the flip to `issued: true` happens only after it returns.
   */
  async discharge(entries: readonly JournalEntry[]): Promise<void> {
    for (const e of entries) {
      if (e.requestId === undefined) continue;
      if (e.kind === "spawn") {
        await this.dischargeSpawn(e);
        continue;
      }
      if (e.kind === "conclave") {
        await this.dischargeConclave(e);
        continue;
      }
      if (e.kind !== "sleep" && e.kind !== "checkpoint" && e.kind !== "wait" && e.kind !== "ask" && e.kind !== "turn") continue;
      // An ask's armed timer is its CURRENT attempt's, whose token is bound as `askToken`; a
      // crash before the first bind leaves attempt 1, which is the request id itself.
      const current = e.kind === "ask" && typeof e.external?.askToken === "string"
        ? e.external.askToken
        : e.requestId;
      await this.cancelTimer({ endpoint: this.binding.endpoint, token: current });
      if (e.kind === "wait") {
        await this.cancelTimer({ endpoint: this.binding.endpoint, token: derivedToken(e.requestId, "wait-timeout") });
        try {
          await this.jsm.consumers.delete(chatStream(this.binding.space), waitConsumerName(e.requestId));
        } catch { /* never created, or already deleted — nothing is held either way */ }
      }
    }
  }

  /**
   * Release a cancelled spawn's AGENT (§8.6.4): the world half a loser `spawn` leaves behind is a
   * seat the run will never address, so the discharge despawns it. The goal's identity re-derives
   * from the entry alone — the request id IS the goalId (the pinned envelope id), and the caller
   * triple is run-stable — so a crash before the acceptance was even bound still finds its goal.
   *
   * The terminal is what says whether a seat exists. No goal at all: the submission never landed,
   * nothing to release. Accepted but not terminal: the manager owes a terminal within the accepted
   * readiness window, so this waits it out (bounded by the recorded window plus one poll of slack)
   * and THROWS if none lands — an unfinished discharge must not be flipped to `issued`, and the
   * driver's next sweep retries idempotently. `succeeded` and `uncertain` both despawn (an
   * uncertain readiness verdict leaves the process running); `failed` was reaped by the manager
   * and `cancelled` means a despawn already drove the teardown, so both are already released.
   */
  private async dischargeSpawn(e: JournalEntry): Promise<void> {
    const goalId = e.requestId as string;
    const ref: GoalRef = { endpoint: this.binding.endpoint, caller: this.binding.caller, goalId };
    const actx = await this.actionCtx();
    let fact = await readGoalResult(actx, ref);
    if (fact === undefined) {
      if ((await readGoalStatus(actx, ref)) === undefined) return;
      const window = typeof e.external?.readinessDeadlineMs === "number" ? e.external.readinessDeadlineMs : DISCHARGE_TERMINAL_BOUND_MS;
      const deadline = this.now() + window + GOAL_POLL_MS;
      for (;;) {
        fact = await readGoalResult(actx, ref);
        if (fact !== undefined) break;
        if (this.now() >= deadline)
          throw new Error(`the cancelled spawn goal "${goalId}" is accepted but reached no terminal within its ${window}ms readiness window; its agent cannot be released yet, and the discharge stays open to retry`);
        await new Promise((r) => setTimeout(r, GOAL_POLL_MS).unref());
      }
    }
    if (fact.state !== "succeeded" && fact.state !== "uncertain") return;
    const target = spawnDespawnTarget(e.external, fact);
    if (target === undefined) {
      // An `uncertain` terminal carries no identity, and this entry bound none (the crash landed
      // between the acceptance and the bind). The seat — if one came up — is not addressable from
      // here, and no retry will ever learn more, so throwing would wedge every future sweep of
      // this run behind an answer that cannot arrive. Name the leak for the operator instead.
      console.error(`! discharge: the cancelled spawn goal "${goalId}" settled ${fact.state} with no readable agent identity; if its seat is up it must be despawned by hand (cotal ps)`);
      return;
    }
    const service = await this.manager();
    const reply = await invokeCommand(this.nc, this.binding.space, service, "despawn", { graceful: true }, {
      target: { mode: "owner", ...target },
      deadlineMs: SPAWN_ACCEPT_DEADLINE_MS,
    });
    // Tolerated refusals are the two "already gone" shapes: `not-found` (no such agent), and
    // `expired` (the target's lifecycle mapping is gone or rotated — this despawn pins one
    // incarnation, and an incarnation the mapping no longer names is not running).
    const code = reply.reply.ok === false ? reply.reply.error?.code : undefined;
    if (code !== undefined && code !== "not-found" && code !== "expired")
      throw new Error(`the cancelled spawn's agent could not be despawned: ${reply.reply.error?.message ?? "refused"}`);
  }

  /**
   * Release a cancelled conclave's MEMBERSHIP (spec §7.5): a cancelled body performs no new
   * effect, so it never closed its room, and the release travels this recovery path like every
   * other branch-local resource. The entry's own `closed` fact is the gate — a conclave whose
   * body failed but whose close acknowledged holds nothing. An entry with no bound plan created
   * nothing (rows are written only after the bind), so there is nothing to release and no retry
   * that could learn more. Failures are raised: an unfinished release must not be flipped to
   * `issued`, and the driver's next sweep retries idempotently.
   */
  private async dischargeConclave(e: JournalEntry): Promise<void> {
    if (e.closed === true) return;
    const plan = e.external;
    if (!isConclavePlan(plan)) return;
    await this.releaseConclave(plan);
    this.conclaves.delete(e.requestId as string);
  }

  /**
   * `sleep` is a checkpoint nobody answers.
   *
   * There is no separate timer plane and there should not be one: a durable pause with a deadline,
   * a token that survives a crash, and a one-use settle is exactly what the checkpoint plane is,
   * and a second mechanism would be a second thing to get wrong. The difference is only that no
   * `resolveCheckpoint` will ever arrive for this token, so the timer's expiry is the whole story
   * and `null` is the whole answer.
   */
  async sleep(req: SleepRequest, ctx: EffectContext): Promise<null> {
    if (ctx.signal.cancelled) throw new Cancelled(ctx.signal.reason ?? "cancelled");
    const ref: CheckpointRef = { endpoint: this.binding.endpoint, token: ctx.requestId };
    const now = this.now();
    const deadline = now + parseDuration(req.duration);

    // The record is durable BEFORE the timer exists, and the MINT is what asks for the timer —
    // this handler never emits its own schedule request. That is not tidiness: mint re-emits at
    // the status's CURRENT authoritative generation, so a replay repairs the crash-before-arm
    // window without rolling a heartbeat-advanced deadline back to the one this caller computed.
    // A request emitted from here would carry the caller's coordinates and could arm a stale
    // generation the writer would then have to be trusted to ignore.
    await this.arm(ref, deadline);

    await this.settle(ref, ctx.signal);
    return null;
  }

  /**
   * `checkpoint` is the same durable pause with somebody expected to answer it.
   *
   * The mint is identical to `sleep`'s — one token, one deadline, one settle fact — and everything
   * that differs is on the ANSWER side, which is deliberately not this handler's to arrange: the
   * run driver's `resolveCheckpoint` writes the answer record and presents the token, because the
   * checkpoint's holder is the driver and a resume is holder-bound. So this waits, and then reads
   * what the arbiter says was accepted.
   *
   * It returns the RAW outcome and never the program's result. Whether an expiry throws or returns
   * is `onExpiry`, which is computed from today's source on the live path and the replay path
   * alike; deciding it here would bake one answer into the journal.
   */
  async checkpoint(req: CheckpointRequest, ctx: EffectContext): Promise<CheckpointRaw> {
    if (ctx.signal.cancelled) throw new Cancelled(ctx.signal.reason ?? "cancelled");
    const ref: CheckpointRef = { endpoint: this.binding.endpoint, token: ctx.requestId };
    const now = this.now();
    const deadline = now + parseDuration(req.timeout ?? this.binding.defaultCheckpointTimeout);

    await this.arm(ref, deadline);

    const settled = await this.settle(ref, ctx.signal);
    if (settled.settle === "expired") return { outcome: "expired", at: settled.ts };
    // The settle NAMES its answer, and the record is read under that name rather than by looking
    // for "the answer to this token": two resolvers can have filed answers and only one of them
    // was accepted, so an answer found by token alone could be the loser's.
    const answer = settled.answerId === undefined
      ? undefined
      : await readCheckpointAnswer(this.kv, this.binding.endpoint, ref.token, settled.answerId);
    if (answer === undefined) throw new CheckpointAnswerMissing(ref.token, settled.answerId);
    return {
      outcome: "resolved",
      ...(answer.value !== undefined ? { value: answer.value } : {}),
      ...(answer.artifact !== undefined ? { artifact: answer.artifact } : {}),
      by: answer.by,
      answerId: answer.answerId,
      at: settled.ts,
    };
  }

  /**
   * `wait` — an event await that survives the process waiting for it.
   *
   * A DURABLE consumer named from `ctx.requestId` holds the run's position on the channel, so an
   * event published while the host was down is still there when the run re-attaches under the same
   * derived name. An ephemeral consumer, or one created on resume, starts from "now" and the event
   * never happened.
   *
   * The TIMEOUT rides the checkpoint plane and is minted once with an absolute deadline, so a
   * resumed 20-minute wait with 30 seconds left has 30 seconds left. A timeout resolves `null` and
   * never throws: `??` is `otherwise`.
   *
   * `down(agent)` is an agent-addressed event with no channel, so it branches to `waitDown`
   * before any of the channel machinery. `replied(agent)` rides the turn machinery that has not
   * landed, so it refuses through the same named seam as the durable actions.
   */
  async wait(req: WaitRequest, ctx: EffectContext): Promise<unknown | null> {
    if (ctx.signal.cancelled) throw new Cancelled(ctx.signal.reason ?? "cancelled");
    const ev = req.event;
    if (ev.event === "replied") {
      throw new NotYetDurable("wait(replied(…))", ACTION_MACHINERY);
    }
    if (ev.event === "down") return await this.waitDown(ev, req, ctx);
    if (!isConcreteChannel(ev.channel)) {
      throw new Error(`wait() cannot await a wildcard channel ("${ev.channel}"); an await names one channel`);
    }
    // A recorded seq is a previous attempt's MATCH, taken before the crash. Return that message
    // rather than looking again: the consumer has already acked it, so looking again would wait for
    // a second event the program never asked for.
    const bound = ctx.resume?.chatSeq;
    if (typeof bound === "number") return await this.messageAt(bound);

    const timeoutAt = req.timeout === undefined ? undefined : this.now() + parseDuration(req.timeout);
    const idleFor = ev.event === "idle" ? parseDuration(ev.duration) : undefined;
    const matcher = ev.event === "message" && ev.matches !== undefined ? compileMatch(ev.matches) : undefined;
    const from = ev.event === "message" ? ev.from : undefined;

    // ONE token per deadline, both derived, so a resume re-derives them instead of remembering.
    // The step's own id is the deadline that DEFINES the wait — the idle window where there is one,
    // the timeout otherwise — and a second, derived id carries an idle wait's outer timeout.
    const primary = idleFor !== undefined || timeoutAt !== undefined
      ? { endpoint: this.binding.endpoint, token: ctx.requestId }
      : undefined;
    const outer = idleFor !== undefined && timeoutAt !== undefined
      ? { endpoint: this.binding.endpoint, token: derivedToken(ctx.requestId, "wait-timeout") }
      : undefined;
    if (primary !== undefined) {
      await this.arm(primary, idleFor !== undefined ? this.now() + idleFor : timeoutAt!);
    }
    if (outer !== undefined) await this.arm(outer, timeoutAt!);

    const durable = waitConsumerName(ctx.requestId);
    const stream = chatStream(this.binding.space);
    await this.jsm.consumers.add(stream, waitConsumerConfig(this.binding.space, ctx.requestId, ev.channel));
    const consumer = await this.js.consumers.get(stream, durable);
    // Set on each of the three paths that END the wait, and read by the cleanup below. A THROW is
    // not one of them — see the note there.
    let over = false;
    try {
      for (;;) {
        // THE CANCELLATION IS OBSERVED ON THE SAME CADENCE AS THE DEADLINE: once per poll, so a
        // race decided against this branch ends its wait within one fetch rather than never
        // (§7.6 — a cancelled branch performs no new work, and a wait mid-poll is this branch's
        // one in-flight effect). A cancelled wait is OVER, not abandoned: its timers are claimed
        // here and its consumer is deleted by the cleanup below, because a `cancelled` settle
        // replays as cancelled and nothing will ever re-attach to this position.
        if (ctx.signal.cancelled) {
          if (primary !== undefined) await this.cancelTimer(primary);
          if (outer !== undefined) await this.cancelTimer(outer);
          over = true;
          throw new Cancelled(ctx.signal.reason ?? "cancelled");
        }
        // The deadline is durable and authoritative — a checkpoint's settle fact — and this is only
        // the OBSERVATION of it, so the cost of polling is lateness bounded by one poll rather than
        // a wait that outlives its deadline.
        const ended = await this.expired(outer ?? (idleFor === undefined ? primary : undefined));
        if (ended !== undefined) { over = true; return null; }
        if (idleFor !== undefined && (await this.expired(primary)) !== undefined) {
          over = true;
          return { channel: ev.channel, at: this.now() };
        }
        for await (const m of await consumer.fetch({ max_messages: 16, expires: WAIT_POLL_MS })) {
          const msg = decodeMessage(m.data);
          if (idleFor !== undefined) {
            // ANY traffic resets an idle window, matched or not: "idle" is a fact about the
            // channel, not about the messages this program finds interesting.
            m.ack();
            await this.push(primary!, this.now() + idleFor);
            continue;
          }
          if (msg === undefined || !matchesEvent(msg, from, matcher)) { m.ack(); continue; }
          // BIND BEFORE ACK. The bind is durable; the ack is what makes the message unrecoverable.
          // In this order a crash in between redelivers it, and a crash after it is answered from
          // the recorded sequence — in the other order the match is simply lost.
          await ctx.bind({ chatSeq: m.seq });
          m.ack();
          if (primary !== undefined) await this.cancelTimer(primary);
          if (outer !== undefined) await this.cancelTimer(outer);
          over = true;
          return msg;
        }
      }
    } finally {
      // A THROW IS NOT AN ENDING — with one exception, and it marks itself. The three returns above
      // are the wait being over and its position worthless; a throw leaves the step pending, and
      // the consumer's position is the only record of where this run reached on the channel.
      // `ctx.bind` is a journal append and a journal can refuse one (L5010, RunSuperseded), so a
      // throw here is ordinary operation and not only a bug. The exception is `Cancelled`, which
      // sets `over` before it leaves: a cancelled wait settles `cancelled` and replays as
      // cancelled, so its position answers nothing ever again.
      // Keeping the consumer costs one durable on an abandoned run, which is what a host crash
      // already costs; reaping on inactivity instead could delete a live wait's position while its
      // host was down.
      if (over) {
        try {
          await this.jsm.consumers.delete(stream, durable);
        } catch { /* already gone, or never created — either way there is nothing to hold */ }
      }
    }
  }

  /**
   * `wait(down(agent))` — the death of one incarnation, read off presence liveness.
   *
   * The handle pins `<name>#<lifecycleUid>` and DOWN is a fact about the INCARNATION. The mesh's
   * liveness witness is the presence row a seat heartbeats — TTL'd out of the bucket when the
   * heartbeats stop — and it is the same source conclave membership resolves members through, so
   * "down" here and "down or gone" at a conclave join are one definition. No live row carrying
   * the name AND this incarnation is the death, with the reason split by what the name shows now:
   * `"lapsed"` when nothing live holds the name any more, `"superseded"` when a live row holds it
   * under a DIFFERENT incarnation — this incarnation dead with a successor already up.
   *
   * NOTHING BINDS, because a death is re-observable where a matched message is not: a lifecycle
   * uid is minted once per incarnation and never heartbeats again after its row lapses, so a
   * crash between the observation and the settle re-observes the same death on resume — at worst
   * with the reason upgraded from `"lapsed"` to `"superseded"` by a successor that appeared in
   * between. `at` is the time of OBSERVATION: presence records no time of death, and inventing
   * one would be a value the planes cannot back.
   *
   * The TIMEOUT is the same mediated pause every wait arms — minted once with an absolute
   * deadline under the step's own request id, so a resume ATTACHES to the recorded deadline
   * rather than restarting the clock — and it resolves `null`, never a throw: `??` is
   * `otherwise`. The discharge and the adoption re-arm already speak this wait's tokens (the
   * `wait` kind arms under its request id), so a cancelled or adopted down-wait needs nothing of
   * its own.
   */
  private async waitDown(
    ev: { readonly agent: string },
    req: WaitRequest,
    ctx: EffectContext,
  ): Promise<unknown | null> {
    const { name, uid } = parseAgentHandle(ev.agent);
    const primary = req.timeout === undefined
      ? undefined
      : { endpoint: this.binding.endpoint, token: ctx.requestId };
    if (primary !== undefined) await this.arm(primary, this.now() + parseDuration(req.timeout!));
    for (;;) {
      if (ctx.signal.cancelled) {
        if (primary !== undefined) await this.cancelTimer(primary);
        throw new Cancelled(ctx.signal.reason ?? "cancelled");
      }
      const ended = await this.expired(primary);
      if (ended !== undefined) return null;
      let rows: readonly Presence[];
      try {
        rows = await this.presenceRows();
      } catch (e) {
        // `liveKvEntries` REFUSES a pass cut short mid-scan instead of returning a partial view —
        // and a partial view is exactly what must not decide a death. Its own contract says retry,
        // so the next poll is the retry; a link that stays down keeps surfacing here rather than
        // as a false DOWN, and the deadline above still ends the wait.
        if (e instanceof IncompleteKvScan) {
          await new Promise((r) => setTimeout(r, WAIT_POLL_MS).unref());
          continue;
        }
        throw e;
      }
      if (!rows.some((p) => p.card?.name === name && p.lifecycleUid === uid)) {
        const reason = rows.some((p) => p.card?.name === name) ? "superseded" : "lapsed";
        if (primary !== undefined) await this.cancelTimer(primary);
        return { agent: ev.agent, reason, at: this.now() };
      }
      await new Promise((r) => setTimeout(r, WAIT_POLL_MS).unref());
    }
  }

  /**
   * `notify` writes one bounded decision record per addressee, onto the run.
   *
   * NOT a channel post, and that is the whole point of the primitive: a post would put the program
   * into the conversation as a participant, where conversation is the data plane and
   * the program is the control plane. A notice is data filed on the run and rendered ahead of the
   * addressee's next turn.
   *
   * **One call to N agents is N records, and a retry lands on its own.** The id is derived from the
   * step's request id and the addressee, so a crash between the second and third write is repaired
   * by re-running the call: the first two creates find their own bytes and return, the third
   * happens. Nothing is written twice and nothing needs a memo of how far it got.
   *
   * The fact's bound is the language's and is enforced BEFORE this is reached (L3043 at the effect
   * boundary), so a fact that could not be rendered as one table row cannot arrive here.
   */
  async notify(req: NotifyRequest, ctx: EffectContext): Promise<null> {
    const at = this.now();
    const step = stepKeyString(ctx.key);
    for (const agent of req.agents) {
      const noticeId = runNoticeId(ctx.requestId, agent.agent);
      await writeRunNotice(this.kv, this.binding.endpoint, noticeId, {
        v: 1,
        run: this.binding.runId,
        step,
        addressee: agent.agent,
        fact: req.fact,
        at,
      });
    }
    return null;
  }

  // ── The Lane-A seam ────────────────────────────────────────────────────────────────────────────
  //
  // Every effect in this group addresses an AGENT HANDLE. `spawn` — the effect that produces one —
  // `conclave` — the scope that assembles a sub-team of them — `ask` — the schema-checked pause
  // the agent answers — and `monitor` with `wait(down)` — the liveness pair over presence — now
  // perform, so the remaining refusals are `turn` (with `wait(replied)` gated above, which rides
  // the same turn machinery, and the `worktree` sub-refusal on `spawn` itself): the handle
  // consumers whose durable machinery has not landed yet, still refusing through one class with
  // one reason.
  //
  // THEY ARE HERE RATHER THAN ABSENT, and that is the point of the slice. A handler that simply
  // lacks the method fails as a TypeError from inside the interpreter: a fault about JavaScript
  // rather than about the run, at a call site that says nothing about what is missing or when it
  // arrives. The refusal is the honest two-exit — the simulator performs the whole group, so a
  // program using them can be written, validated and dry-run today, and a DURABLE run declines
  // rather than performing an effect it could not recover after a crash.
  //
  // THE REFUSAL HOLDS THE RUN RATHER THAN ENDING IT. `NotYetDurable` is an `EffectRefused`, so
  // the interpreter settles the entry `refused` under L5016 — never `failed`, which would replay
  // a failure forever for work nobody attempted — and unwinds the run with the uncatchable L5025
  // (spec §9.2). The driver records the run `released`; a resume on a host where the
  // durable-action surface has landed finds the `refused` verdict (§10.7) and performs the step
  // live, so a run started today heals the day the substrate arrives. This was referred up as a
  // live question and is now settled: an effect a host cannot perform is a hold, not a failure.

  /**
   * `spawn` is the manager's spawn ACTION, submitted under the step's own identity.
   *
   * **The request id is the goalId.** The envelope id is pinned to `ctx.requestId`, and the
   * manager binds its goal under the envelope id — so a resumed run that re-submits is served the
   * RECORDED acceptance (same fingerprint, same goal) instead of allocating a second seat, and the
   * goal's terminal fact sits on a subject this run can re-derive from nothing but its journal.
   *
   * The ACCEPTANCE is bound as the entry's external state before the terminal is awaited, so a
   * crash mid-await resumes straight into the poll — it must NOT re-invoke, because by then the
   * manager may have restarted and a fresh submission would be judged against a live seat rather
   * than served from its acceptance cache. The terminal await itself is a read of a durable fact,
   * deliberately not `submitAndFollowGoal`: a live progress subscription dies with the process,
   * and the fact is the thing a resume can still read.
   *
   * `permits`, `supervise` and `onFork` are POLICY, not identity (§6.4): they ride the journalled
   * request and are enforced where they bind (`permits` at `turn`, `supervise` by `monitor`, an
   * `onFork` at fork adoption) — nothing about them travels in the submission.
   */
  async spawn(req: SpawnRequest, ctx: EffectContext): Promise<AgentHandleValue> {
    if (ctx.signal.cancelled) throw new Cancelled(ctx.signal.reason ?? "cancelled");
    if (req.worktree !== undefined) throw new NotYetDurable("spawn({worktree})", "the §9 worktree binding");
    const goalId = ctx.requestId;
    const ref: GoalRef = { endpoint: this.binding.endpoint, caller: this.binding.caller, goalId };

    // A recorded goalId is a previous attempt's ACCEPTANCE: the submission landed and its
    // identity was bound before the crash. Go straight back to the terminal.
    let ext: Readonly<Record<string, unknown>> | undefined =
      ctx.resume?.goalId === goalId ? (ctx.resume as Readonly<Record<string, unknown>>) : undefined;
    if (ext === undefined) {
      let reply: EpAttributedReply | undefined;
      try {
        const service = await this.manager();
        reply = await invokeCommand(this.nc, this.binding.space, service, "spawn", spawnArgs(req), {
          id: goalId,
          deadlineMs: SPAWN_ACCEPT_DEADLINE_MS,
        });
      } catch (err) {
        // The invoke did not come back — which does not prove nothing happened: the request may
        // have been accepted while the reply was lost. The goal record is the arbiter: a durable
        // trace under this goalId means the submission landed, so proceed to its terminal; none
        // means it never did, and the raised error is the honest outcome.
        if ((await readGoalStatus(await this.actionCtx(), ref)) === undefined) throw err;
      }
      if (reply !== undefined && reply.reply.ok === false) {
        // Refused AT ACCEPT (persona not found, name collision, capacity): the manager bound no
        // goal and provisioned nothing, so this is the effect's own failure, catchable as such.
        const err = reply.reply.error;
        throw new EffectError("L4002", "spawn",
          `spawn(${req.persona}) was refused by the ${this.binding.endpoint} endpoint: ${err?.message ?? "refused with no message"}`,
          err?.code !== undefined ? { code: err.code } : undefined);
      }
      const floor = reply === undefined ? undefined : (reply.reply.data as Record<string, unknown> | undefined);
      if (floor !== undefined && floor.goalId !== goalId)
        throw new Error(`the spawn acceptance names goal "${String(floor.goalId)}" but this submission pinned "${goalId}"; a mismatched acceptance never authorizes (SPEC 13.6)`);
      // BIND BEFORE AWAITING: the goalId is re-derivable, but the bind is what tells a resume the
      // submission LANDED — and the identity floor beside it is what a discharge despawns by when
      // the terminal alone carries none (an `uncertain` verdict).
      ext = {
        goalId,
        ...(floor !== undefined ? pickAcceptanceFloor(floor) : {}),
      };
      await ctx.bind(ext);
    }

    const fact = await this.goalTerminal(ref, ctx.signal);
    const handle = spawnHandleOf(req, fact, this.binding.endpoint);
    // Register the run-roster entry `turn` addresses and a handoff resolves to. The owner/actor
    // address prefers the bound floor and falls back to the terminal's own recorded identity —
    // the same discipline the discharge uses (see spawnDespawnTarget).
    const address = spawnDespawnTarget(ext, fact);
    this.roster.set(parseAgentHandle(handle.agent).name, {
      handle,
      uid: parseAgentHandle(handle.agent).uid,
      ...(address !== undefined ? { owner: address.owner, actor: address.actor } : {}),
    });
    return handle;
  }

  /** Poll the goal's durable terminal fact, observing cancellation on the poll cadence — the same
   *  discipline as `wait`: a race decided against this branch stops parking within one poll, and
   *  the seat its acceptance may have produced is the DISCHARGE's to release, not this branch's. */
  private async goalTerminal(ref: GoalRef, signal: CancelSignal): Promise<GoalResultFact> {
    const actx = await this.actionCtx();
    for (;;) {
      if (signal.cancelled) throw new Cancelled(signal.reason ?? "cancelled");
      const fact = await readGoalResult(actx, ref);
      if (fact !== undefined) return fact;
      await new Promise((r) => setTimeout(r, GOAL_POLL_MS).unref());
    }
  }

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
   * DEATH likewise: the manager's reap hook fails pending turns `agent-down`, and this client
   * watches presence itself (the L4002 authority when the manager died with the seat).
   *
   * Handoff honoring (lang §5.3) happens HERE: the scope's pending memo is spent at every turn's
   * begin, and when this turn targets its `to`, the link rides the submission (`handoffFrom`, the
   * manager mirrors it into the terminal), the bound external state, and the run record's
   * `conversationOwner`. A handoff YIELD is validated against the run roster: an addressee
   * outside it is L4005, one in a different worktree is L4004.
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
      const entry = this.roster.get(name);
      if (entry === undefined || entry.uid !== uid)
        throw new Error(`turn(${name}#${uid}) addresses an agent that is not in this run's roster; a turn wakes an agent this run spawned`);
      if (entry.owner === undefined || entry.actor === undefined)
        throw new Error(`turn(${name}#${uid}) has no address: the spawn's acceptance floor was never served, so the seat's owner/actor coordinates are unknown`);
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
      const deadlineAt = this.now() + deadlineMs;
      const payload = JSON.stringify({ run: this.binding.runId, step, context, noticeIds: notices.map((n) => n.noticeId) });

      let reply: EpAttributedReply | undefined;
      try {
        const service = await this.manager();
        reply = await invokeCommand(this.nc, this.binding.space, service, "turn",
          { payload, deadlineMs, ...(handoffFrom !== undefined ? { handoffFrom } : {}) }, {
            id: goalId,
            deadlineMs: TURN_ACCEPT_DEADLINE_MS,
            target: { mode: "owner", owner: entry.owner, actor: entry.actor, lifecycleUid: uid },
          });
      } catch (err) {
        // The invoke did not come back — the goal record is the arbiter, exactly as in `spawn`.
        if ((await readGoalStatus(await this.actionCtx(), ref)) === undefined) throw err;
      }
      if (reply !== undefined && reply.reply.ok === false) {
        const err = reply.reply.error;
        // `expired` is the serve boundary's "target is not a live managed agent": the seat is gone.
        if (err?.code === "expired")
          throw new EffectError("L4002", "turn", `turn(${name}#${uid}) found the agent down before the relay began: ${err.message}`);
        throw new Error(`turn(${name}#${uid}) was refused by the ${this.binding.endpoint} endpoint: ${err?.message ?? "refused with no message"}`);
      }
      ext = {
        goalId, name, owner: entry.owner, actor: entry.actor, uid, deadlineAt,
        noticeIds: notices.map((n) => n.noticeId),
        ...(handoffFrom !== undefined ? { handoffFrom } : {}),
      };
      await ctx.bind(ext);
    }
    const deadlineAt = ext.deadlineAt;
    if (typeof deadlineAt !== "number")
      throw new Error(`turn(${name}#${uid}) resumed with no recorded deadline; a garbled external state never authorizes`);
    // The client's OWN deadline authority: minted on the first pass, attached to on re-entry.
    await this.arm(primary, deadlineAt);
    // Honoring moves the conversation owner. Re-driven on resume — idempotent when already moved.
    if (typeof ext.handoffFrom === "string") await this.moveConversationOwner(name);

    const actx = await this.actionCtx();
    for (;;) {
      if (ctx.signal.cancelled) {
        await this.cancelTimer(primary);
        throw new Cancelled(ctx.signal.reason ?? "cancelled");
      }
      const fact = await readGoalResult(actx, ref);
      if (fact !== undefined) {
        await this.cancelTimer(primary);
        return await this.turnOutcome(req, fact, ext, scope, name, uid);
      }
      const ended = await this.expired(primary);
      if (ended !== undefined)
        throw new EffectError("L4003", "turn-deadline", `turn(${name}#${uid}) deadline elapsed before a yield`);
      let rows: readonly Presence[];
      try {
        rows = await this.presenceRows();
      } catch (e) {
        if (e instanceof IncompleteKvScan) { await new Promise((r) => setTimeout(r, WAIT_POLL_MS).unref()); continue; }
        throw e;
      }
      if (!rows.some((pr) => pr.card?.name === name && pr.lifecycleUid === uid)) {
        const reason = rows.some((pr) => pr.card?.name === name) ? "superseded" : "lapsed";
        await this.cancelTimer(primary);
        throw new EffectError("L4002", "turn", `turn(${name}#${uid}) found the agent down (${reason}) before a yield`);
      }
      await new Promise((r) => setTimeout(r, WAIT_POLL_MS).unref());
    }
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
      const d = fact.data as { reason?: unknown; error?: unknown } | undefined;
      // The one reasoned failure a relay commits. Seat DEATH deliberately has no arm here: a
      // dead target has no honest early terminal on the goal plane (SPEC 13.6 item 7), so the
      // client's own presence watch in the poll loop is the L4002 authority, and a death that
      // rode to the deadline arrives as this same turn-deadline deny.
      if (d?.reason === "turn-deadline")
        throw new EffectError("L4003", "turn-deadline", `turn(${name}#${uid}) deadline elapsed before a yield`);
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
      const target = this.roster.get(toName);
      if (toName.length === 0 || target === undefined)
        throw new EffectError("L4005", "turn-handoff", `turn(${name}#${uid}) yielded a handoff to "${toName}", which is not in this run's roster`);
      if ((target.handle.worktree ?? undefined) !== (req.agent.worktree ?? undefined))
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
   * Move the run record's `conversationOwner` to the agent whose turn honors a handoff — the
   * observers' answer to "who is driving". A read-modify-write CAS preserving every driver-owned
   * status field; contended against the driver's own activation writes, so it retries on a lost
   * CAS and refuses loudly when the record stays contended — never a silent skip.
   */
  private async moveConversationOwner(name: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const record = await readRunRecord(this.kv, this.binding.endpoint, this.binding.runId);
      if (record?.status === undefined) return; // no status yet — nothing is observing this run
      const current = record.status.value;
      if (current.conversationOwner === name) return;
      const { v: _v, ...rest } = current;
      try {
        await writeRunStatus(this.kv, this.binding.endpoint, this.binding.runId, { ...rest, conversationOwner: name }, record.status.revision);
        return;
      } catch (e) {
        if (e instanceof EpEnvelopeError && e.code === "conflict") continue;
        throw e;
      }
    }
    throw new Error(`the conversation-owner move to "${name}" lost the run-status CAS five times; the run record is under active contention`);
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
   * pause forever. The deadline elapsing with no conforming answer is L4003, the deadline-elapsed
   * class of the agent-addressed effects.
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
    const resume = askResume(ctx.resume);
    const deadlineAt = resume?.deadlineAt
      ?? this.now() + parseDuration(req.deadline ?? this.binding.defaultCheckpointTimeout);
    let attempt = resume?.attempt ?? 1;
    // The resumed attempt is already bound; every attempt this call opens binds before it arms.
    let bindOwed = resume === undefined;
    let refused: string | undefined;
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
      const ref: CheckpointRef = { endpoint: this.binding.endpoint, token };
      await this.arm(ref, deadlineAt);
      const settled = await this.settle(ref, ctx.signal);
      if (settled.settle === "expired") {
        throw new EffectError(
          "L4003",
          "ask-deadline",
          `ask(${stepKeyString(ctx.key)}) deadline elapsed before a conforming reply: attempt ${attempt} of ${attempts} was still open when the recorded deadline passed`,
        );
      }
      const answer = settled.answerId === undefined
        ? undefined
        : await readCheckpointAnswer(this.kv, this.binding.endpoint, token, settled.answerId);
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
   * `monitor` registers interest: after it, `down(agent)` is an event a branch can await (§5.9).
   *
   * THE REGISTRATION IS THE JOURNAL ENTRY, and that is the whole mechanism. Death is a STATE on
   * this mesh — the monitored incarnation's presence row gone (see `waitDown`) — not a message
   * that must find a standing mailbox, so there is no subscription to create, nothing to arm, and
   * nothing for a discharge or a migration to release: `wait(down(...))` reads the same fact
   * whenever it is asked, and the migration table's row for `monitor` ("nothing outlives it")
   * stays true. What the step performs is the validation a registration owes: the value must BE
   * an agent handle, refused loudly when it is not, because a wait parked on a malformed handle
   * would poll for a death nothing can ever report.
   *
   * Monitoring an agent that is ALREADY dead succeeds — Erlang's monitor of a dead process
   * delivers its DOWN rather than failing, and the rescue idiom (race work against
   * `wait(down(...))`) needs exactly that: the death is observed by the wait, immediately.
   */
  async monitor(req: MonitorRequest, ctx: EffectContext): Promise<null> {
    if (ctx.signal.cancelled) throw new Cancelled(ctx.signal.reason ?? "cancelled");
    parseAgentHandle(req.agent.agent);
    return null;
  }

  /**
   * `conclave` open: mint (or take) the channel and join the members as durable membership rows.
   *
   * **The plan is the recovery identity.** Everything the close and the discharge need — the
   * channel, whether this open minted its registry row, and per member the resolved principal,
   * incarnation, generation and whether THIS conclave created the row — is computed first, bound
   * as the entry's external state, and only then executed. A crash before the bind created
   * nothing (rows are written after it); a crash after it re-enters with `ctx.resume` carrying
   * the plan, and the execute converges idempotently without re-resolving anything: the members
   * may have died since, and the recorded plan — not the world's current shape — is what a
   * release answers to.
   *
   * **The channel is handler-derived** when the program names none: `conclave-` plus a digest of
   * the step's own request id, so a resumed run re-derives the same room instead of opening a
   * second one. A program-named channel is taken as-is (validated concrete) and its registry row
   * is left alone — naming a room is not creating one, and the close must not tear down a channel
   * the run merely borrowed.
   *
   * **Members resolve through presence.** A handle carries `<name>#<lifecycleUid>`; the row that
   * maps it to the principal a membership record needs is the seat's own self-published presence —
   * the same source DM name-resolution reads, and the witness the manager's readiness gate
   * requires before a spawn reports `succeeded`. A member with no matching row is down or gone,
   * which is the effect's own catchable failure (L4002), not a handler fault.
   *
   * A member already durably in the channel (a pinned pre-existing room) is planned `joined:
   * false`: the conclave neither re-joins nor — at close — evicts a membership it did not create.
   */
  async openConclave(req: ConclaveRequest, ctx: EffectContext): Promise<ChannelHandleValue> {
    if (ctx.signal.cancelled) throw new Cancelled(ctx.signal.reason ?? "cancelled");
    let plan: ConclavePlan;
    if (isConclavePlan(ctx.resume)) {
      plan = ctx.resume;
    } else {
      plan = await this.planConclave(req, ctx);
      await ctx.bind({ ...plan });
    }
    await this.executeConclavePlan(plan);
    this.conclaves.set(ctx.requestId, plan);
    return { channel: plan.channel };
  }

  /**
   * `conclave` close: release exactly what the recorded plan says the open created — tombstone
   * the memberships planned `joined: true`, delete the registry row when this conclave minted the
   * channel. A member that left and rejoined on its own since carries a newer generation, and the
   * stale-write guard makes this leave a no-op for it: the membership is theirs now.
   *
   * Idempotent by the plane (a tombstone at or below an existing leave cursor is a no-op), so the
   * re-entry that retries an unacknowledged close converges. The failure mode is the interpreter's
   * `CloseOwed`: a close that throws leaves the entry pending, which IS the durable "a close is
   * still owed".
   */
  async closeConclave(_req: ConclaveRequest, ctx: EffectContext): Promise<null> {
    const plan = this.conclaves.get(ctx.requestId) ?? (isConclavePlan(ctx.resume) ? ctx.resume : undefined);
    if (plan === undefined)
      throw new Error(`conclave close for "${ctx.requestId}" has no recorded plan: the open that owes this close bound none`);
    await this.releaseConclave(plan);
    this.conclaves.delete(ctx.requestId);
    return null;
  }

  /** Compute the conclave plan from the world: derive or validate the channel, resolve every
   *  member handle to its principal, and read each existing membership row so the join generation
   *  and the created-by-us fact are decided BEFORE anything is written. Duplicate handles collapse
   *  to one planned member — one identity is one membership row. */
  private async planConclave(req: ConclaveRequest, ctx: EffectContext): Promise<ConclavePlan> {
    const derived = req.channel === undefined;
    const channel = derived
      ? `conclave-${createHash("sha256").update(ctx.requestId).digest("hex").slice(0, 12)}`
      : assertConclaveChannel(req.channel!);
    const members: ConclavePlanMember[] = [];
    if (req.members.length > 0) {
      const presence = await this.presenceRows();
      const membersKv = await this.membersRegistry();
      const seen = new Set<string>();
      for (const m of req.members) {
        const { name, uid } = parseAgentHandle(m.agent);
        if (seen.has(`${name}#${uid}`)) continue;
        seen.add(`${name}#${uid}`);
        const principal = resolveMemberPrincipal(presence, m.agent, name, uid);
        const existing = await readMember(membersKv, channel, principal, uid);
        const open = existing !== undefined && existing.record.state === "durable-active" && existing.record.leaveCursor === undefined;
        members.push({
          agent: m.agent,
          principal,
          uid,
          generation: open ? existing.record.generation : (existing?.record.generation ?? 0) + 1,
          joined: !open,
        });
      }
    }
    return { channel, registered: derived, members };
  }

  /** Execute a conclave plan against the registries, idempotently: the registry row is a merge
   *  the re-entry rewrites byte-identical, and a member row is committed only where the plan's
   *  generation is NEWER than what is stored — a re-entry must not roll a landed row's join
   *  cursor forward (the members were mid-conversation when the host died), and a row the world
   *  moved past (an independent leave or rejoin) is theirs, not this conclave's. */
  private async executeConclavePlan(plan: ConclavePlan): Promise<void> {
    if (plan.registered) {
      await writeChannelConfig(await this.channelRegistry(), plan.channel, {
        description: `a workflow conclave of run ${this.binding.runId}`,
      });
    }
    const joins = plan.members.filter((m) => m.joined);
    if (joins.length === 0) return;
    const membersKv = await this.membersRegistry();
    const joinCursor = await this.chatFrontier();
    for (const m of joins) {
      const existing = await readMember(membersKv, plan.channel, m.principal, m.uid);
      if (existing !== undefined && existing.record.generation >= m.generation) continue;
      try {
        await commitMember(membersKv, {
          channel: plan.channel,
          owner: m.principal,
          lifecycleUid: m.uid,
          state: "durable-active",
          joinCursor,
          generation: m.generation,
          // No activation catch-up is owed: eligibility starts at the join cursor captured here,
          // so the completeness the flag reports holds by construction — nothing before the join
          // is in this membership's interval.
          activated: true,
          writerIdentity: `${this.binding.caller.owner}.${this.binding.caller.actor}`,
          updatedAt: this.now(),
        });
      } catch (e) {
        // A concurrent newer write won between the read and the commit — same verdict as the
        // read-side skip above: the membership is the newer writer's now.
        if (!(e instanceof StaleMembershipWrite)) throw e;
      }
    }
  }

  /** The world half of ending a conclave, shared by the close and the discharge: tombstone the
   *  memberships this conclave created, then delete the registry row it minted. Idempotent, and
   *  tolerant of exactly one foreign move — a NEWER generation on a row (the member left and
   *  rejoined on its own), which the stale-write guard reports and this leave must not evict. */
  private async releaseConclave(plan: ConclavePlan): Promise<void> {
    const joined = plan.members.filter((m) => m.joined);
    if (joined.length > 0) {
      const membersKv = await this.membersRegistry();
      const leaveCursor = await this.chatFrontier();
      const writer = `${this.binding.caller.owner}.${this.binding.caller.actor}`;
      for (const m of joined) {
        try {
          await tombstoneMember(membersKv, plan.channel, m.principal, m.uid, leaveCursor, writer, m.generation);
        } catch (e) {
          if (!(e instanceof StaleMembershipWrite)) throw e;
        }
      }
    }
    if (plan.registered) {
      await (await this.channelRegistry()).delete(plan.channel);
    }
  }

  /** Every live presence row that decodes. Foreign bytes in the bucket are skipped — a peer's
   *  malformed self-publish must not break another agent's name resolution — and what an ABSENT
   *  row means belongs to the caller: `resolveMemberPrincipal` refuses the join loudly, and
   *  `waitDown` reads it as the death it is waiting for. */
  private async presenceRows(): Promise<Presence[]> {
    const rows: Presence[] = [];
    for (const e of await liveKvEntries(await this.presenceRegistry())) {
      try {
        rows.push(e.json<Presence>());
      } catch {
        // not a presence row
      }
    }
    return rows;
  }

  /**
   * Arm this pause, or ATTACH to the one already recorded under the same token.
   *
   * A mint is idempotent only if the whole spec is identical, so the recorded spec is the
   * authority for BOTH halves of the mint's identity and a resume may not recompute either. The
   * deadline, because `now() + duration` is a different deadline a second later, and the plane
   * reads a different deadline as a different intent. And the HOLDER, because a resumed run does
   * not necessarily arrive under the principal that minted its pause: the CLI mints a fresh holder
   * per invocation, and a cross-host adoption is a different principal by definition. Only the
   * recorded holder itself may mint again — completing its own crash between the spec and the
   * status, where the identical spec is exactly what makes the retry idempotent. Everyone else
   * attaches. Measured before the repair, through the CLI: one `resume` of a checkpoint-parked
   * run re-minted under its own fresh holder, the plane refused ("a token is minted once"), and
   * the interpreter recorded that infrastructure refusal as the step's own failure (L4000) — a
   * stranded run whose journal blames the program.
   *
   * An already-passed deadline cannot be minted at all, correctly, because a due pause is not being
   * armed. It needs its schedule re-emitted at the status's current generation, which is the
   * reconciler's job — the same operation an attaching successor needs, so the two share the exit.
   * A spec with no status that this holder cannot complete is unrepairable from here, so it is
   * raised rather than waited on.
   */
  private async arm(ref: CheckpointRef, deadline: number): Promise<void> {
    // Over already: an expiry or an answer landed while this host was away. Nothing to arm, and the
    // caller reads the fact next.
    if ((await readCheckpointSettle(this.jsm, this.binding.space, ref)) !== undefined) return;
    const prior = await readCheckpointSpec(this.kv, ref);
    const now = this.now();
    if (prior === undefined) {
      // The first arm: this driver's own mint, under its own holder, at the deadline the caller
      // computed from the duration it was just handed.
      await mintCheckpoint(this.kv, this.js, this.binding.space, {
        ref,
        instanceId: this.binding.instanceId,
        epoch: this.binding.epoch,
        holder: this.binding.holder,
        deadline,
        now,
      });
      return;
    }
    const mine = prior.holder.id === this.binding.holder.id
      && prior.holder.lifecycleUid === this.binding.holder.lifecycleUid;
    if (mine && prior.initialDeadline > now) {
      // A retry of this holder's own mint: idempotent-if-identical, and the one path that can
      // repair a crash between the spec and the status, because only an identical spec completes.
      await mintCheckpoint(this.kv, this.js, this.binding.space, {
        ref,
        instanceId: this.binding.instanceId,
        epoch: this.binding.epoch,
        holder: this.binding.holder,
        deadline: prior.initialDeadline,
        now,
      });
      return;
    }
    // ATTACH: the pause exists and is not this attempt's to mint — another holder's pause, or this
    // holder's own come back overdue (a due pause is being collected, not armed). Both need the
    // same thing: the schedule re-emitted at THIS instance's coordinates, so the fire lands where
    // this driver is listening. The settle the caller waits on next is coordinate-free.
    const status = await readCheckpointStatus(this.kv, ref);
    if (status === undefined) {
      throw new Error(
        `checkpoint "${ref.token}" carries a spec with no status`
        + `${mine ? "" : ` held by ${prior.holder.id}, and only its own holder's identical re-mint can repair a half-minted pause`}; `
        + `this pause has to be reconciled on the plane before the run can go on`,
      );
    }
    await reconcileCheckpointSchedule(this.kv, this.js, this.jsm, this.binding.space, {
      ref,
      instanceId: this.binding.instanceId,
      epoch: this.binding.epoch,
    });
  }

  /** Push a live deadline out — the idle window restarting. The heartbeat CAS-advances the
   *  generation before replacing the timer, so a fire from the old one no-ops rather than racing. */
  private async push(ref: CheckpointRef, deadline: number): Promise<void> {
    await heartbeatCheckpoint(this.kv, this.js, this.jsm, this.binding.space, {
      ref,
      instanceId: this.binding.instanceId,
      epoch: this.binding.epoch,
      deadline,
      now: this.now(),
    });
  }

  /**
   * Take the broker's `.fire` for this deadline, if it has published one, and let the checkpoint
   * plane judge it. Answers whether the fire SETTLED the pause.
   *
   * A fire is a MESSAGE and a settlement is a FACT; `handleCheckpointFire` is what turns one into
   * the other, and a pause nobody answers ends no other way.
   *
   * READ BY SUBJECT rather than by a subscription, because the fire is a record of a deadline
   * passing and callers here are already polling: `last_by_subj` gives the current one whether it
   * arrived a moment ago or while this host was down, and a resume lands in the second case.
   *
   * IDEMPOTENT BY THE PLANE rather than by bookkeeping here: a fire handed over twice finds the
   * pause settled and declines. The one repeated verdict with a side effect is `re-armed` under
   * owner-behind clock skew, and over-emission is idempotent at the timer writer.
   */
  private async takeFire(ref: CheckpointRef): Promise<boolean> {
    const subject = eptSubject(
      this.binding.space, ref.endpoint,
      this.binding.instanceId, this.binding.epoch, ref.token, "fire",
    );
    const fired = await this.jsm.streams
      .getMessage(eptStreamName(this.binding.space), { last_by_subj: subject })
      .catch(() => null);
    if (fired === null || fired === undefined) return false;
    const verdict = await handleCheckpointFire(this.kv, this.js, this.jsm, this.binding.space, {
      ref,
      instanceId: this.binding.instanceId,
      epoch: this.binding.epoch,
      msg: { subject, ...(fired.header !== undefined ? { headers: fired.header } : {}), data: fired.data },
      now: this.now(),
    });
    return verdict.acted;
  }

  /** Has this deadline settled? `undefined` for "no deadline" and for "not yet".
   *
   *  A `wait` observes its deadlines by polling this, so the fire is taken on the same poll: the
   *  settle fact a `wait` is reading for is one this process has to produce, and reading for it
   *  without ever producing it is how a `wait` with a timeout waited past its timeout forever. */
  private async expired(ref: CheckpointRef | undefined): Promise<CheckpointSettleFact | undefined> {
    if (ref === undefined) return undefined;
    const settled = await readCheckpointSettle(this.jsm, this.binding.space, ref);
    if (settled !== undefined) return settled;
    if (!(await this.takeFire(ref))) return undefined;
    return await readCheckpointSettle(this.jsm, this.binding.space, ref);
  }

  /** End a deadline that is no longer waited on, by claiming its one-use settlement with no answer.
   *  A timer left armed would fire into a run that has moved on; claiming it is how the plane says
   *  "this pause is over" without a second mechanism for cancellation. */
  private async cancelTimer(ref: CheckpointRef): Promise<void> {
    const st = await readCheckpointStatus(this.kv, ref);
    if (st?.value.state !== "waiting") return;
    try {
      // The presenter is the ARMING holder read off the pause's own record, as everywhere on this
      // plane: a timer minted by a predecessor is still this run's to end after a takeover, and a
      // successor presenting its own identity would be refused (resume is holder-bound, SPEC
      // 13.10). A spec that cannot be read leaves the timer to its own deadline, which the catch
      // below already tolerates: it fires, settles expired, and nobody is reading that token.
      const spec = await readCheckpointSpec(this.kv, ref);
      if (spec === undefined) return;
      await resumeCheckpoint(this.kv, this.js, this.jsm, this.binding.space, {
        ref,
        presenter: spec.holder,
        now: this.now(),
      });
    } catch {
      // It settled underneath us — the deadline won a race it was already allowed to win. The
      // caller has its answer either way, and a cancelled timer is not a fact anyone reads.
    }
  }

  /** The message at a recorded stream sequence — the re-bind path after a crash. */
  private async messageAt(seq: number): Promise<unknown> {
    const m = await this.jsm.streams.getMessage(chatStream(this.binding.space), { seq });
    if (m === null || m === undefined) {
      throw new Error(`the message this wait matched (sequence ${seq}) is no longer on the channel's stream; a recorded match cannot be re-read`);
    }
    const msg = decodeMessage(m.data);
    if (msg === undefined) throw new Error(`the message at sequence ${seq} did not decode; a recorded match cannot be re-read`);
    return msg;
  }

  /**
   * Wait for this token's one-use settlement.
   *
   * A settle that ALREADY landed is the ordinary case on a resume: the run crashed while paused and
   * the timer fired, or somebody answered, without it. Reading before waiting is not an
   * optimization, it is the difference between resuming and waiting forever for an event that is
   * already in the past.
   */
  private async settle(ref: CheckpointRef, signal?: CancelSignal): Promise<CheckpointSettleFact> {
    const already = await readCheckpointSettle(this.jsm, this.binding.space, ref);
    if (already !== undefined) return already;
    // The watcher waits for the FACT. For a pause with an answer the fact arrives because somebody
    // answered; for a pause nobody answers - a `sleep`, or a `checkpoint` whose timeout wins - it
    // arrives only because this process took the fire and the plane wrote it. So the two run
    // together for the life of one wait, and the pump ends when the wait does.
    const wait = { over: false };
    const pump = this.pumpFires(ref, wait);
    try {
      return await Promise.race([
        this.watcher.awaitSettle(ref),
        // A pump that ENDED is not an answer, only one that FAILED is: a failure means this process
        // cannot expire the pause, so it is raised rather than absorbed and the step stays pending.
        pump.then<CheckpointSettleFact>(() => new Promise<never>(() => {})),
        // A cancelled branch stops parking NOW (§7.6): the rejection decides the race first, so a
        // `checkpoint` cannot mistake its own claim below for an answer, and then the claim ends
        // the pause in the world. The claim is not awaited here — a claim that loses its own race
        // is tolerated by `cancelTimer`, and the discharge sweep at the run's completion re-claims
        // idempotently for the case where this process died before the claim landed.
        ...(signal === undefined ? [] : [this.settleCancelled(ref, signal)]),
      ]);
    } finally {
      wait.over = true;
    }
  }

  /** Reject with `Cancelled` the moment this branch's signal fires, then claim the pause so its
   *  armed schedule cannot fire into a run that has moved on. The claim also writes the one-use
   *  settle, which is what lets an abandoned `awaitSettle` poll loop see a fact and end. */
  private settleCancelled(ref: CheckpointRef, signal: CancelSignal): Promise<never> {
    return new Promise<never>((_, reject) => {
      let fired = false;
      const fire = (reason?: string): void => {
        if (fired) return;
        fired = true;
        reject(new Cancelled(reason ?? "cancelled"));
        void this.cancelTimer(ref).catch(() => undefined);
      };
      if (signal.cancelled) {
        fire(signal.reason);
        return;
      }
      signal.onCancel(fire);
    });
  }

  /** Take this deadline's fire for as long as somebody is waiting on it. */
  private async pumpFires(ref: CheckpointRef, wait: { over: boolean }): Promise<void> {
    while (!wait.over) {
      await this.takeFire(ref);
      // Unrefed: the loop is ended by the flag, not by this timer, and a wait that is already over
      // must not hold the process open for one more poll on its way out.
      await new Promise((r) => setTimeout(r, FIRE_POLL_MS).unref());
    }
  }
}

/** The durable that holds one wait's position on a channel. Derived from the step's own request id,
 *  which is why a resumed run finds the consumer its earlier attempt created rather than starting
 *  again from "now" — and why nothing about the wait has to be remembered across a crash. */
export function waitConsumerName(requestId: string): string {
  return `wfw_${requestId}`;
}

/**
 * The one definition of a wait's consumer, shared by the handler and by anything that has to
 * recreate it — so the name a resume looks for and the name a wait creates cannot drift apart.
 *
 * `deliver_policy: "new"` applies only to the FIRST create: an existing durable keeps its own
 * position, which is exactly what a resume needs, and events from before the program asked are not
 * this wait's to see.
 */
export function waitConsumerConfig(space: string, requestId: string, channel: string): Record<string, unknown> {
  return {
    durable_name: waitConsumerName(requestId),
    filter_subject: chatSubject(space, "*", "*", channel),
    ack_policy: "explicit",
    deliver_policy: "new",
  };
}

/** How long one poll of a wait's consumer blocks. The deadline itself is durable; this is only how
 *  late its observation can be, and a shorter poll buys latency at the cost of fetch traffic. */
const WAIT_POLL_MS = 2_000;

/** How often an action's durable terminal fact is looked for. Same argument as `WAIT_POLL_MS`. */
const GOAL_POLL_MS = 2_000;

/** How long one acceptance round-trip may take. The ACCEPT is synchronous and cheap on the far
 *  side (the manager replies at identity mint, before any provision), so this bounds a lost
 *  broker, not the spawn itself — the spawn's own outcome rides the goal terminal. */
const SPAWN_ACCEPT_DEADLINE_MS = 30_000;
/** Bound on the manager's synchronous `turn` ACCEPT reply (the relay registration, not the yield). */
const TURN_ACCEPT_DEADLINE_MS = 30_000;
/** A step key's enclosing scope: the journal's own rendering (`entry.scope`), re-derived so the
 *  live path and the adoption rebuild key the handoff memos identically. */
function scopeOf(key: Parameters<typeof stepKeyString>[0]): string {
  const k = stepKeyString(key);
  return k.slice(0, k.lastIndexOf("/"));
}

/** The terminal wait a discharge grants a goal whose entry recorded no readiness window (the
 *  crash-before-bind case). Matches the manager's default readiness budget. */
const DISCHARGE_TERMINAL_BOUND_MS = 30_000;

/** The manager `spawn` args a {@link SpawnRequest} submits: persona names the persona file
 *  (`name`), `join` becomes the seat's channel subscriptions. Policy fields do not travel. */
function spawnArgs(req: SpawnRequest): Record<string, unknown> {
  return {
    name: req.persona,
    ...(req.model !== undefined ? { model: req.model } : {}),
    ...(req.variant !== undefined ? { variant: req.variant } : {}),
    ...(req.role !== undefined ? { role: req.role } : {}),
    ...(req.join !== undefined && req.join.length > 0 ? { subscribe: req.join.map((c) => c.channel) } : {}),
  };
}

/** The acceptance-floor fields worth binding: the allocated identity a discharge despawns by, and
 *  the readiness window that bounds its wait for a terminal. Copied field-by-field so a widened
 *  acceptance never smuggles unknown keys into the journal. */
function pickAcceptanceFloor(floor: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["name", "owner", "actor", "uid", "readinessDeadlineMs"] as const) {
    if (floor[k] !== undefined) out[k] = floor[k];
  }
  return out;
}

/** The despawn target for a discharged spawn: the bound acceptance floor when the entry carries
 *  one, else the identity the SUCCEEDED terminal itself records (`id` is the `owner.actor`
 *  principal, `lifecycleUid` the incarnation). `undefined` when neither names an agent. */
function spawnDespawnTarget(
  external: Readonly<Record<string, unknown>> | undefined,
  fact: GoalResultFact,
): { owner: string; actor: string; lifecycleUid: string } | undefined {
  if (typeof external?.owner === "string" && typeof external.actor === "string" && typeof external.uid === "string")
    return { owner: external.owner, actor: external.actor, lifecycleUid: external.uid };
  const d = fact.data as { id?: unknown; lifecycleUid?: unknown } | undefined;
  if (typeof d?.id !== "string" || typeof d.lifecycleUid !== "string") return undefined;
  const dot = d.id.indexOf(".");
  if (dot <= 0 || dot === d.id.length - 1) return undefined;
  return { owner: d.id.slice(0, dot), actor: d.id.slice(dot + 1), lifecycleUid: d.lifecycleUid };
}

/**
 * The program's value from a spawn terminal. `succeeded` yields the agent handle — `agent` is the
 * `<name>#<lifecycleUid>` composite, one string that addresses the NAME the mesh knows the seat by
 * while pinning WHICH incarnation this run spawned (a respawned namesake is not this handle).
 * Every other state throws the catchable spawn failure (L4002) carrying the terminal's own reason:
 * `failed` and `uncertain` are the manager's readiness verdicts, `cancelled` means a despawn ended
 * the launch under it, and each replays identically because the fact is durable.
 */
function spawnHandleOf(req: SpawnRequest, fact: GoalResultFact, endpoint: string): AgentHandleValue {
  if (fact.state !== "succeeded") {
    const d = fact.data as { error?: unknown; reason?: unknown; cancelledBy?: unknown } | undefined;
    const why =
      typeof d?.error === "string" ? d.error
      : typeof d?.reason === "string" ? d.reason
      : d?.cancelledBy !== undefined ? `cancelled by ${JSON.stringify(d.cancelledBy)}`
      : `the ${endpoint} endpoint recorded no reason`;
    throw new EffectError("L4002", "spawn", `spawn(${req.persona}) ${fact.state}: ${why}`, { state: fact.state });
  }
  const d = fact.data as { name?: unknown; lifecycleUid?: unknown; role?: unknown } | undefined;
  if (typeof d?.name !== "string" || typeof d.lifecycleUid !== "string")
    throw new Error(`the spawn goal's succeeded terminal carries no readable agent identity (${JSON.stringify(fact.data)}); a garbled terminal never yields a handle (SPEC 13.6)`);
  return {
    agent: `${d.name}#${d.lifecycleUid}`,
    persona: req.persona,
    ...(typeof d.role === "string" ? { role: d.role } : {}),
  };
}

/**
 * A conclave's recovery identity: everything the execute, the close and the discharge act on,
 * decided before anything was written and bound as the entry's external state. `registered` is
 * whether THIS conclave minted the channel's registry row (a program-named channel is borrowed,
 * never torn down); per member, `joined` is whether this conclave created the membership row.
 */
interface ConclavePlanMember {
  readonly agent: string;
  /** The member's owner+actor dot-form principal, resolved from its presence row. */
  readonly principal: string;
  readonly uid: string;
  readonly generation: number;
  readonly joined: boolean;
}
interface ConclavePlan {
  readonly channel: string;
  readonly registered: boolean;
  readonly members: readonly ConclavePlanMember[];
}

/** Whether a recorded external is a conclave plan. A journal is bytes from an earlier process, so
 *  the shape is checked rather than trusted — a malformed external reads as "nothing was bound". */
function isConclavePlan(v: unknown): v is ConclavePlan {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  if (typeof p.channel !== "string" || typeof p.registered !== "boolean" || !Array.isArray(p.members)) return false;
  return p.members.every((m) => {
    if (typeof m !== "object" || m === null) return false;
    const r = m as Record<string, unknown>;
    return typeof r.agent === "string" && typeof r.principal === "string" && typeof r.uid === "string"
      && typeof r.generation === "number" && typeof r.joined === "boolean";
  });
}

/** Split an agent handle `<name>#<lifecycleUid>` on its LAST `#` — the uid alphabet
 *  (`[a-z0-9]{26,32}`) cannot carry one, a name could. */
function parseAgentHandle(agent: string): { name: string; uid: string } {
  const i = agent.lastIndexOf("#");
  if (i <= 0 || i === agent.length - 1)
    throw new Error(`"${agent}" is not an agent handle of the form <name>#<lifecycleUid>`);
  return { name: agent.slice(0, i), uid: agent.slice(i + 1) };
}

/** The one presence row that carries the handle's name AND incarnation, as a principal. None is
 *  the effect's own catchable failure — the agent is down or gone (L4002) — and more than one is
 *  an ambiguity no membership row may be written under. */
function resolveMemberPrincipal(rows: readonly Presence[], agent: string, name: string, uid: string): string {
  const matches = rows.filter((p) => p.card?.name === name && p.lifecycleUid === uid && typeof p.card?.id === "string");
  if (matches.length === 1) return matches[0]!.card.id;
  if (matches.length === 0)
    throw new EffectError("L4002", "conclave",
      `conclave member "${agent}" is not present on the mesh: no live presence row carries that name and incarnation, so the agent is down or gone`);
  throw new Error(`conclave member "${agent}" is ambiguous: ${matches.length} presence rows claim that name and incarnation`);
}

/** A program-named conclave channel: valid channel grammar AND concrete — membership rows and a
 *  room to talk in are per-channel things a wildcard cannot name. */
function assertConclaveChannel(channel: string): string {
  assertValidChannel(channel);
  if (!isConcreteChannel(channel))
    throw new Error(`conclave channel "${channel}" is a wildcard; a conclave joins its members to one concrete channel`);
  return channel;
}

/** How often a pause that nobody will answer looks for the broker's fire. Same argument as
 *  `WAIT_POLL_MS`: the deadline is durable and this is only how late its observation can be. */
const FIRE_POLL_MS = 2_000;

/** A second deadline for one step, derived so a resume re-derives it instead of remembering it.
 *  Same shape and alphabet as a request id, so it is a valid `<token>` by construction. */
function derivedToken(requestId: string, purpose: string): string {
  return createHash("sha256").update(`${requestId}:${purpose}`, "utf8").digest("base64url").slice(0, 43);
}

/** An ask attempt's pause token: attempt 1 IS the step's request id; a re-ask derives its own. */
function askAttemptToken(requestId: string, attempt: number): string {
  return attempt === 1 ? requestId : derivedToken(requestId, `ask-attempt-${attempt}`);
}

/** The recorded ask progress a resume re-enters at, or undefined for a fresh first attempt. The
 *  external is bytes from an earlier process, so the shape is checked rather than trusted. */
function askResume(v: Readonly<Record<string, unknown>> | undefined): { attempt: number; deadlineAt: number } | undefined {
  if (v === undefined) return undefined;
  return typeof v.attempt === "number" && v.attempt >= 1 && typeof v.deadlineAt === "number"
    ? { attempt: v.attempt, deadlineAt: v.deadlineAt }
    : undefined;
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

/**
 * A `matches` pattern, admitted through the repo's bounded-regex subset before it is compiled.
 *
 * A workflow is other people's text and a channel can be busy, so an exponential pattern here is a
 * run that stalls with nothing to show for it. The subset is the same one the schema profile
 * admits, which means the same rule applies: a pattern is ANCHORED (`^…`), and an author who wants
 * "somewhere in the message" writes `^.*…` themselves. Wrapping it for them was the alternative and
 * it is worse — the wrapper turns patterns that are safe as written into refusals about a `.*` the
 * author never typed.
 */
function compileMatch(pattern: string): RegExp {
  try {
    assertSafePattern(pattern, 256);
  } catch (e) {
    throw new Error(`wait()'s \`matches\` is a bounded regular expression, anchored like every pattern in this repo: ${(e as Error).message}`);
  }
  return new RegExp(pattern);
}

function decodeMessage(data: Uint8Array): CotalMessage | undefined {
  try {
    const v = JSON.parse(new TextDecoder().decode(data)) as CotalMessage;
    return v !== null && typeof v === "object" ? v : undefined;
  } catch {
    // Someone else's malformed publish is not this run's failure. It does not match, and the wait
    // goes on waiting — which is what would happen if the message had never been sent.
    return undefined;
  }
}

/** Does this message answer the await? `from` is matched on the SENDER'S NAME as the mesh records
 *  it, never on the subject: the subject carries a principal, and a program names an agent. */
function matchesEvent(msg: CotalMessage, from: string | undefined, matcher: RegExp | undefined): boolean {
  if (from !== undefined && msg.from?.name?.toLowerCase() !== from.toLowerCase()) return false;
  if (matcher === undefined) return true;
  const text = (msg.parts ?? [])
    .filter((p): p is { kind: "text"; text: string } => p.kind === "text" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("\n");
  return matcher.test(text);
}

/**
 * An effect whose durable substrate has not landed on this host.
 *
 * An honest two-exit, and deliberately not a fake success: the simulator implements these, so a
 * program that uses them can be written, validated and dry-run today — but a DURABLE run refuses
 * rather than performing them on a plane that could not recover them. A run that "succeeded" at an
 * effect nothing can replay would be a lie the journal then carries forever.
 */
export class NotYetDurable extends EffectRefused {
  constructor(readonly effect: string, readonly needs: string) {
    super(
      // L5016, and it is load-bearing rather than decorative: the interpreter settles the entry
      // `refused` under the code the refusal carries, so the journal says which thing happened —
      // "no substrate on this host" rather than "the handler broke".
      "L5016",
      `${effect} is not durable on this host yet: it rides ${needs}, which has not landed. ` +
        `The simulator performs it, so the program can be tested and dry-run; a durable run refuses ` +
        `rather than performing an effect it could not recover after a crash.`,
    );
    this.name = "NotYetDurable";
  }
}

/**
 * RE-ARM the timers of every pause this run is still holding, under THIS driver's coordinates.
 *
 * A checkpoint's armed schedule fires onto `ept.<space>.<e>.<instanceId>.<epoch>.<token>.fire`,
 * derived from the coordinates of the instance that armed it. A run adopted by another host — or by
 * the same host at a new epoch — therefore has live timers firing at a subject nobody is reading,
 * and its pauses would sit until something else swept them. Nothing about that is repaired by
 * resuming the program: the effect is a replayed pending step that goes straight back to waiting.
 *
 * So the driver re-emits a schedule request for each outstanding token at the CURRENT generation,
 * which the timer writer arms onto this instance's own fire subject. Over-emission is harmless by
 * construction (same `(timerId, generation)` re-derives the same `.armed`, a no-op replacement), so
 * this is safe to run on every takeover and needs no record of what it did last time.
 *
 * Called AFTER the barrier activated, never before: arming timers for a run this process turned out
 * not to hold would point another driver's fires at this one.
 */
export async function rearmOutstandingPauses(
  deps: { kv: KV; js: JetStreamClient; jsm: JetStreamManager },
  binding: Pick<MeshHandlerBinding, "space" | "endpoint" | "instanceId" | "epoch">,
  entries: readonly JournalEntry[],
): Promise<string[]> {
  const rearmed: string[] = [];
  for (const token of outstandingPauseTokens(entries)) {
    const r = await reconcileCheckpointSchedule(deps.kv, deps.js, deps.jsm, binding.space, {
      ref: { endpoint: binding.endpoint, token },
      instanceId: binding.instanceId,
      epoch: binding.epoch,
    });
    if (r.reEmitted) rearmed.push(token);
  }
  return rearmed;
}

/**
 * The checkpoint tokens a replayed prefix leaves open.
 *
 * An entry is open when its LAST record is `pending`, so the map is built in append order and the
 * later record wins — a step that settled has a settled entry after its pending one, and reading
 * only the first would re-arm timers for pauses that are already over.
 *
 * THE KINDS ARE THE FOUR THAT ARM A TIMER, and `wait` and `ask` are two of them. Neither mints a
 * pause that looks like its own, but a wait's idle window and timeout, and an ask attempt's
 * deadline, are mediated deadlines exactly as `sleep`'s is, and one adopted at a new epoch would
 * otherwise wait on a deadline no live epoch fires.
 *
 * An idle wait with a timeout arms TWO, and the second is DERIVED rather than recorded, so it is
 * re-derived here for the same reason the live path derives it: a resume that had to remember it
 * would be carrying state the key already determines. Emitting it for a wait that never minted one
 * is harmless by construction — the reconciler reads the checkpoint's status first and re-emits
 * nothing when there is none — and the alternative, reading the request shape back out of the
 * entry to decide, would make the repair depend on a field a replay is not guaranteed to carry.
 * An ask's armed pause is its CURRENT attempt's, whose token is bound as `askToken`; before the
 * first bind it is attempt 1, which is the request id itself.
 */
export function outstandingPauseTokens(entries: readonly JournalEntry[]): string[] {
  const last = new Map<string, JournalEntry>();
  for (const e of entries) last.set(journalEntryKeyString(e), e);
  const tokens: string[] = [];
  for (const e of last.values()) {
    if (e.state !== "pending" || e.requestId === undefined) continue;
    if (e.kind === "sleep" || e.kind === "checkpoint") tokens.push(e.requestId);
    else if (e.kind === "ask") tokens.push(typeof e.external?.askToken === "string" ? e.external.askToken : e.requestId);
    else if (e.kind === "wait") tokens.push(e.requestId, derivedToken(e.requestId, "wait-timeout"));
  }
  return tokens;
}

/**
 * The settle watcher over EPF, which is where the one-use settle fact lives.
 *
 * An EPHEMERAL consumer filtered to this token's settle subject, created for one wait and removed
 * after it: the fact is written once and read once, so a durable would be a name to collide on and
 * a thing to clean up, for a subscription that outlives nothing. `deliver_policy: all` because the
 * fact may already be there — a settle is a record, not a notification, and a watcher that only saw
 * new messages would wait forever for one that already happened.
 */
export class EpfSettleWatcher implements SettleWatcher {
  constructor(
    private readonly js: JetStreamClient,
    private readonly jsm: JetStreamManager,
    private readonly space: string,
    private readonly pollMs = 30_000,
  ) {}

  async awaitSettle(ref: CheckpointRef): Promise<CheckpointSettleFact> {
    const stream = epfStreamName(this.space);
    const filter = checkpointSettleSubject(this.space, ref);
    const created = await this.jsm.consumers.add(stream, {
      filter_subject: filter,
      ack_policy: "explicit" as never,
      deliver_policy: "all" as never,
      inactive_threshold: 300_000 * 1_000_000,
    });
    const name = created.name;
    try {
      const consumer = await this.js.consumers.get(stream, name);
      for (;;) {
        const batch = await consumer.fetch({ max_messages: 1, expires: this.pollMs });
        for await (const m of batch) {
          m.ack();
          const settled = await readCheckpointSettle(this.jsm, this.space, ref);
          // Read the fact back through the plane's own parser rather than trusting these bytes: the
          // subject is one-use, so whatever is on it IS the answer, and the parser is what says the
          // answer is well formed.
          if (settled !== undefined) return settled;
        }
      }
    } finally {
      try {
        await this.jsm.consumers.delete(stream, name);
      } catch {
        // The consumer carries its own inactivity threshold, so a failed delete is reaped rather
        // than leaked — the case `run-journal` had to learn the hard way.
      }
    }
  }
}
