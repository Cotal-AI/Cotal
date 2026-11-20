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
import { realpathSync } from "node:fs";
import {
  readCheckpointSettle,
  readCheckpointAnswer,
  reconcileCheckpointSchedule,
  chatStream,
  waitConsumerName,
  waitConsumerConfig,
  isConcreteChannel,
  assertSafePattern,
  presenceBucket,
  parseSubject,
  isFromSubjectSender,
  runNoticeId,
  writeRunNotice,
  actionContext,
  invokeRepairingSplit,
  replyRefusedBeforeEffect,
  readGoalResult,
  readGoalStatus,
  resolveService,
  listRunMigrations,
  markRunNoticeConsumed,
  listRunNoticesForRun,
  EpEnvelopeError,
  unansweredRequest,
  type ActionContext,
  type CheckpointRef,
  type CheckpointSettleFact,
  type CotalMessage,
  type EpAttributedReply,
  type EpCaller,
  type EpVerbTarget,
  type GoalRef,
  type GoalResultFact,
  type Presence,
  type ResolvedService,
  type RunAdmissionView,
} from "@cotal-ai/core";
import { migrationSeats } from "./migrate.js";
import type { NatsConnection } from "@nats-io/transport-node";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import { Kvm, type KV } from "@nats-io/kv";
import {
  parseDuration,
  Cancelled,
  EffectError,
  Journal,
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
  type ObserveRequest,
  type ParticipantRequest,
  type SleepRequest,
  type SpawnRequest,
  type TurnRequest,
  type TurnResultValue,
  journalEntryKeyString,
  stepKeyString,
} from "@cotal-ai/lang";

import { PauseOverdue, type RunPauseHost } from "./run-pause-host.js";
import type { RunWaitHost } from "./run-wait-host.js";
import { loopLag, type LoopLagObserver } from "./host-starvation.js";
import type { RunScopeAuthority } from "./run-scope-authority.js";
import { observeToken, pauseTokens, waitTimeoutToken, waitTimers } from "./pause-tokens.js";
import { delay } from "./delay.js";
import { FIRE_POLL_MS, PauseTimers, decodeMessage } from "./mesh-pause-timers.js";
import { SeatWatch, type DeathWatch } from "./mesh-seat-watch.js";
import { TurnAsk } from "./mesh-turn-ask.js";
import {
  type AgentPermits,
  CheckpointAnswerMissing,
  GOAL_POLL_MS,
  MANAGER_ROUTE_ATTEMPTS,
  parseAgentHandle,
  readPermits,
  SPAWN_ACCEPT_DEADLINE_MS,
  spawnDespawnTarget,
  WAIT_POLL_MS,
} from "./mesh-handler-shared.js";
import { MeshSpawn } from "./mesh-spawn.js";
import { MeshConclave } from "./mesh-conclave.js";

export interface RunMeshServices {
  readonly pauses: RunPauseHost;
  readonly waits: RunWaitHost;
  readonly authority: RunScopeAuthority;
  /**
   * The run's ADMISSION (SPEC 14.8), re-read leader-served at every channel effect this handler
   * performs on its own connection: a conclave's registration and membership writes, checked
   * AFTER a generated channel name is derived. The wait host holds the same reader for the
   * channel reads it mediates. A mediated run with no reader admits no channel effect.
   */
  readonly admission: () => Promise<RunAdmissionView>;
  readonly cancellationObserved?: () => string | undefined;
}

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

export class MeshHandler {
  constructor(
    private readonly nc: NatsConnection,
    private readonly kv: KV,
    private readonly js: JetStreamClient,
    private readonly jsm: JetStreamManager,
    private readonly binding: MeshHandlerBinding,
    private readonly watcher: SettleWatcher,
    private readonly clock: () => number = () => Date.now(),
    private readonly services?: RunMeshServices,
    /**
     * How this handler learns whether its own process was scheduled (#1508). Injected so a suite
     * can drive a starved loop deterministically; the default is the process-wide observer, which
     * is the only honest source outside a test.
     */
    private readonly lag: LoopLagObserver = loopLag(),
    /**
     * Where the operator notice for an absorbed starvation goes (#1508). A daemon routes it to its
     * own log rather than stderr, and a suite counts it: an absorbed starvation is otherwise
     * INVISIBLE, and a cell asserting "the sleep completed" cannot tell a completion that survived
     * starvation from one that was never starved at all.
     */
    private readonly onStarved: (note: string) => void = (note) => console.error(note),
  ) {}

  /**
   * Resolved manager commands, each memoized as a PROMISE so concurrent branches asking for the
   * same command share one describe round-trip. A failed resolve is dropped, so a manager restart
   * does not poison later effects. Different commands stay separate and never fetch one another's
   * contract closures.
   */
  private readonly managerServices = new Map<string, Promise<ResolvedService>>();
  private manager(command: string, instanceId?: string): Promise<ResolvedService> {
    // #1616 ITEM 3 — PINNED DISPATCH. An explicit placement target resolves through the EXISTING
    // instance-dispatch API: `resolveService`'s `instanceId` opt becomes
    // `EpRoute { mode: "inst", instanceId }`, and the handle it returns carries
    // `pinnedInstanceId` so `invokeCommand` addresses that instance and never the class
    // queue. It is deliberately NOT served from `managerServices`: those memos hold class-anycast
    // resolution, and handing a pinned caller the anycast handle would reinstate the exact fallback
    // this item removes. A wrong, unavailable or replaced instance therefore fails to resolve —
    // before a child exists — instead of quietly succeeding somewhere else.
    if (instanceId !== undefined)
      return resolveService(this.nc, this.binding.space, this.binding.endpoint, this.binding.caller, { instanceId, commands: [command] });
    let service = this.managerServices.get(command);
    if (service === undefined) {
      service = resolveService(this.nc, this.binding.space, this.binding.endpoint, this.binding.caller, { commands: [command] })
        .catch((e) => {
          this.managerServices.delete(command);
          throw e;
        });
      this.managerServices.set(command, service);
    }
    return service;
  }

  /** A silent pinned describe before submission is host reachability evidence, not seat death. */
  private async relayManagerBeforeSubmit(host: string | undefined, command: string, ref: GoalRef, kind: "turn" | "ask" | "checkpoint", label: string): Promise<ResolvedService> {
    try { return await this.manager(command, host); }
    catch (err) {
      if (host !== undefined && unansweredRequest(err) && (await readGoalStatus(await this.actionCtx(), ref)) === undefined)
        throw new EffectError("L4002", kind, `${label}: placed host ${host} unreachable`);
      throw err;
    }
  }

  /**
   * One manager call, with a SPEC 13.2 bind refusal REPAIRED rather than raised
   * ({@link invokeRepairingSplit}).
   *
   * A run resolves the manager on the class rail, so in a space with more than one manager its
   * invoke routinely reaches a member other than the one that answered the describe, and that
   * member refuses before dispatching. Raised as the effect's own failure, that refusal ends the
   * run and consumes the run id and its journal (#1638), although it says the command did not run.
   * The class memo is dropped before each re-describe, so later calls do not start from the bind
   * that was just refused. After the shared bound the refusal surfaces unchanged; what removes that
   * residual is addressing one instance, and the run's caller holds no instance-rail grant for a
   * command its program did not place (SPEC 13.9, `run-driver-grants.ts`).
   */
  private async invokeManager(
    service: ResolvedService,
    command: string,
    args: Record<string, unknown> | undefined,
    opts: { target?: EpVerbTarget; deadlineMs?: number; id?: string },
  ): Promise<EpAttributedReply> {
    return invokeRepairingSplit(this.nc, this.binding.space, service, command, args, opts, () => {
      this.managerServices.delete(command);
      return this.manager(command);
    });
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

  /** The run's roster: every agent this run spawned, by name — the handle a handoff resolves to,
   *  the owner/actor address a `turn` targets (absent when the spawn's acceptance floor was
   *  never served; a `turn` on such an agent refuses loudly rather than guessing an address), and
   *  the spawn goal whose terminal names the manager that allocated it, and, for a placed spawn,
   *  the `host` instance it was placed on, which is where its turns are addressed.
   *  Seeded live by `spawn`, rebuilt at adoption from the journal's settled spawn entries. */
  private readonly roster = new Map<string, { handle: AgentHandleValue; owner?: string; actor?: string; uid: string; goalId?: string; permits?: AgentPermits; spawnedAt?: number; host?: string }>();
  /** Turns this run has dispatched per handle composite, live and seeded — what a `turns` permit is spent against. */
  private readonly turnsTaken = new Map<string, number>();
  /** Handle composites a `monitor` registered, live and seeded — what makes `down(agent)` observable. */
  private readonly monitored = new Set<string>();

  /** The most recent unhonored handoff yield per SCOPE (lang §5.3): the goal-chain linkage memo.
   *  `"ambiguous"` when two pending handoffs in one scope named the same agent — ambiguity records
   *  no linkage at all. Spent (deleted) by the next `turn` in the scope, honored or not: honoring
   *  is immediate-only. Rebuilt at adoption by replaying the same two rules over the journal. */
  private readonly handoffMemos = new Map<string, { to: string; fromGoalId: string } | "ambiguous">();

  /** This run's turn goals per handle composite ("name#uid") — the observable `wait(replied)`
   *  rides. Fed by `turn` at submission and adoption, reseeded from journal turn entries. */
  private readonly turnGoals = new Map<string, Set<string>>();

  /** The last agent this run spawned into each logical worktree — what the L4008 guard reads.
   *  Fed by `spawn` and reseeded from journal spawn results at adoption. */
  private readonly worktreeHolders = new Map<string, WorktreeHolder>();

  /** Seats a committed migration handed to this program under `--adopt`, keyed by persona and
   *  handed out in journal order: the next `spawn` of that persona receives the recorded seat
   *  instead of minting one. Fed by {@link adoptMigratedSeats}; spent by `spawn`. */
  private readonly adoptable = new Map<string, JournalEntry[]>();

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
    const folded = foldEntries(this.services ? await this.services.authority.journal() : entries);
    this.seedRunMemos(folded);
    if (this.services) return [...await this.services.pauses.rearm()];
    return await rearmOutstandingPauses(
      { kv: this.kv, js: this.js, jsm: this.jsm },
      this.binding,
      folded,
    );
  }

  /**
   * Hand this program the seats a committed migration kept for it under `--adopt` (spec §11.2).
   * The orphaned spawn's settled entry is the whole hand-over: the next `spawn` of its persona
   * returns that entry's handle, binds that entry's floor, and submits nothing, so the seat keeps
   * its identity, its worktree and its turn history across the edit. Called by the driver on the
   * migrated run before the program runs; a map with no entry for a persona changes nothing.
   */
  async restoreMigratedSeats(entries: readonly JournalEntry[]): Promise<void> {
    const source = this.services ? await this.services.authority.journal() : entries;
    const kept = new Map<string, JournalEntry[]>();
    for (const migration of await listRunMigrations(this.kv, this.binding.endpoint, this.binding.runId)) {
      if (migration.applied === undefined) continue;
      for (const [persona, seats] of migrationSeats(source, migration.spec).adopt)
        kept.set(persona, [...(kept.get(persona) ?? []), ...seats]);
    }
    if (kept.size > 0) this.adoptMigratedSeats(kept);
  }

  adoptMigratedSeats(seats: ReadonlyMap<string, readonly JournalEntry[]>): void {
    for (const [persona, entries] of seats)
      this.adoptable.set(persona, [...(this.adoptable.get(persona) ?? []), ...entries]);
  }

  /**
   * Rebuild the in-memory run memos an adopted run needs to keep performing `turn`: the roster
   * (from every settled ok `spawn`, its result the handle and its bound floor the address), the
   * worktree holders (a settled spawn holds its tree by identity, a spawn still in flight by the
   * reservation its bound request took) and the handoff memos (replaying, in journal order, the
   * same two rules the live path applies — a turn's begin spends its scope's memo, a settled
   * handoff yield writes one, a second pending handoff to the same name in one scope makes it
   * ambiguous). Deterministic from the journal alone.
   */
  private seedRunMemos(entries: readonly JournalEntry[]): void {
    for (const e of entries) {
      if (e.kind === "participant" && e.state === "settled" && e.status === "ok" && e.result !== undefined) {
        const handle = e.result as AgentHandleValue;
        if (handle.kind !== "participant" || typeof handle.agent !== "string") continue;
        const { name, uid } = parseAgentHandle(handle.agent);
        const ext = e.external as { owner?: unknown; actor?: unknown; uid?: unknown; name?: unknown; host?: unknown } | undefined;
        if (ext?.uid !== uid || ext?.name !== name || typeof ext.owner !== "string" || typeof ext.actor !== "string") continue;
        this.roster.set(name, { handle, owner: ext.owner, actor: ext.actor, uid,
          ...(typeof ext.host === "string" ? { host: ext.host } : {}) });
        continue;
      }
      if (e.kind === "spawn" && e.state === "pending") {
        const x = e.external as { goalId?: unknown; worktree?: unknown } | undefined;
        if (typeof x?.goalId === "string" && typeof x?.worktree === "string")
          this.worktreeHolders.set(x.worktree, { pending: x.goalId });
        continue;
      }
      if (e.kind === "spawn" && e.state === "settled" && e.status === "ok" && e.result !== undefined) {
        const handle = e.result as AgentHandleValue;
        if (typeof handle.agent !== "string") continue; // a garbled result seeds nothing; the turn that needs it refuses loudly
        const { name, uid } = parseAgentHandle(handle.agent);
        const ext = e.external as { goalId?: unknown; owner?: unknown; actor?: unknown; permits?: unknown; spawnedAt?: unknown; host?: unknown } | undefined;
        this.roster.set(name, {
          handle,
          uid,
          ...(typeof ext?.goalId === "string" ? { goalId: ext.goalId } : {}),
          ...(typeof ext?.owner === "string" ? { owner: ext.owner } : {}),
          ...(typeof ext?.actor === "string" ? { actor: ext.actor } : {}),
          ...(ext?.permits !== undefined ? { permits: readPermits(ext.permits, handle.persona) } : {}),
          ...(typeof ext?.spawnedAt === "number" ? { spawnedAt: ext.spawnedAt } : {}),
          ...(typeof ext?.host === "string" ? { host: ext.host } : {}),
        });
        if (typeof handle.worktree === "string") this.worktreeHolders.set(handle.worktree, { name, uid });
        continue;
      }
      if (e.kind === "monitor" && e.state === "settled" && e.status === "ok") {
        const m = e.external as { agent?: unknown } | undefined;
        if (typeof m?.agent === "string") this.monitored.add(m.agent);
        continue;
      }
      if (e.kind !== "turn") continue;
      const x = e.external as { name?: unknown; uid?: unknown; goalId?: unknown } | undefined;
      // Every relayed turn spent one of its agent's turns, whatever it came to.
      if (typeof x?.name === "string" && typeof x?.uid === "string")
        this.turnsTaken.set(`${x.name}#${x.uid}`, (this.turnsTaken.get(`${x.name}#${x.uid}`) ?? 0) + 1);
      if (typeof x?.name === "string" && typeof x?.uid === "string" && typeof x?.goalId === "string" && (e.state === "pending" || e.status === "ok"))
        this.recordTurnGoal(`${x.name}#${x.uid}`, x.goalId);
      this.handoffMemos.delete(e.scope); // its begin spent whatever was pending, honored or not
      if (e.state !== "settled" || e.status !== "ok" || e.result === undefined) continue;
      const r = e.result as TurnResultValue;
      if (r.status !== "handoff" || r.to === undefined || typeof r.to.agent !== "string") continue;
      this.recordHandoffMemo(e.scope, parseAgentHandle(r.to.agent).name, e.requestId ?? "");
    }
  }

  /** One turn goal registered under its handle composite — what `wait(replied)` observes. */
  private recordTurnGoal(handle: string, goalId: string): void {
    const set = this.turnGoals.get(handle);
    if (set === undefined) this.turnGoals.set(handle, new Set([goalId]));
    else set.add(goalId);
  }

  /** One handoff yield's memo write: most-recent-wins across different names, ambiguous when a
   *  pending handoff to the SAME name is already waiting (lang §5.3 — ambiguity records nothing). */
  private recordHandoffMemo(scope: string, to: string, fromGoalId: string): void {
    const prev = this.handoffMemos.get(scope);
    this.handoffMemos.set(scope, prev !== undefined && (prev === "ambiguous" || prev.to === to) ? "ambiguous" : { to, fromGoalId });
  }

  /**
   * Despawn the seats of a run that completed (the driver's `releaseSeats` is the caller). On the
   * mediated path the run's own journal decides which seats those are, never the entries handed in.
   */
  async release(entries: readonly JournalEntry[]): Promise<void> {
    const owed = this.services ? await this.services.authority.releaseEntries() : entries;
    for (const e of owed) {
      if (e.kind !== "spawn" || e.requestId === undefined) continue;
      try {
        await this.dischargeSpawn(e);
      } catch (err) {
        // The program finished. A cleanup failure neither changes its outcome nor excuses
        // skipping the remaining seats. Cancellation discharge still throws and stays owed.
        const handle = (e.result as Partial<AgentHandleValue> | undefined)?.agent;
        const seat = typeof handle === "string" ? handle : e.external?.name ?? journalEntryKeyString(e);
        console.error(`run ${this.binding.runId}: completion could not confirm release of ${seat} (spawn goal "${e.external?.goalId ?? e.requestId}"): ${String(err)}; inspect it with \`cotal ps\` and stop any remaining seat with \`cotal stop\``);
      }
    }
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
    const owed = this.services ? await this.services.authority.cleanupEntries() : entries;
    for (const e of owed) {
      if (e.requestId === undefined) continue;
      await this.endPause(e);
      // A relay to a seat rides its step's pause token (a turn's goal, an ask's attempt, an
      // escalation), and a decision the run withdrew must not reach the seat afterwards.
      if (e.kind === "turn" || e.kind === "ask" || e.kind === "checkpoint")
        for (const token of pauseTokens(e)) await this.withdrawRelay(token);
      if (e.kind === "spawn") {
        await this.dischargeSpawn(e);
        continue;
      }
      if (e.kind === "conclave") {
        await this.dischargeConclave(e);
        continue;
      }
      if (e.kind === "notify") {
        await this.dischargeNotify(e);
        continue;
      }
      if (e.kind === "turn") {
        // A cancelled turn is never a reply, whatever the seat yields to the relay later.
        const x = e.external as { name?: unknown; uid?: unknown; goalId?: unknown } | undefined;
        if (typeof x?.name === "string" && typeof x?.uid === "string" && typeof x?.goalId === "string")
          this.turnGoals.get(`${x.name}#${x.uid}`)?.delete(x.goalId);
      }
    }
  }

  /**
   * End the pauses a step armed: claim every token {@link pauseTokens} says it owns and, for a
   * `wait`, close its consumer. A cancelled loser's discharge calls it, and so does a hold before
   * its first bind (spec/cotal-lang.md §7.8), which claims the held step's open attempt. The relay
   * an `ask` attempt rode is the discharge's to withdraw, not this.
   */
  async endPause(e: JournalEntry): Promise<void> {
    if (e.requestId === undefined) return;
    for (const token of pauseTokens(e)) await this.cancelTimer({ endpoint: this.binding.endpoint, token });
    if (e.kind !== "wait") return;
    if (this.services) {
      await this.services.waits.close(e.requestId);
      return;
    }
    try {
      await this.jsm.consumers.delete(chatStream(this.binding.space), waitConsumerName(e.requestId));
    } catch { /* never created, or already deleted — nothing is held either way */ }
  }

  /**
   * Withdraw a cancelled `notify`'s undelivered notices.
   *
   * A notice is world state exactly as a live seat or an armed timer is: it sits on the run
   * waiting to be rendered ahead of its addressee's next turn. A branch the run cancelled decided
   * nothing, and a decision the run withdrew must not arrive at an agent afterwards — which is
   * what happened, because the discharge released seats, memberships and timers and walked past
   * this one kind.
   *
   * Withdrawn is spelled as CONSUMED, by the discharge rather than by a turn. The notice's status
   * is a closed record with one meaning — this notice will not be delivered again — and that is
   * the fact being recorded; `by` says which cancelled step withdrew it, so a reader tracing a
   * notice finds the withdrawal instead of a delivery that never happened. It also puts the
   * migration verdict where it belongs: an orphaned `notify` is rejected only while its notice is
   * still owed to somebody, and this one is not owed to anybody any more.
   *
   * IDEMPOTENT BY THE PLANE, like the rest of the discharge: the consumption write is create-only,
   * so a notice a turn already carried, or that an earlier discharge pass already withdrew, is
   * left exactly as it is.
   */
  private async dischargeNotify(e: JournalEntry): Promise<void> {
    const step = journalEntryKeyString(e);
    const notices = await listRunNoticesForRun(this.kv, this.binding.endpoint, this.binding.runId);
    for (const n of notices) {
      if (n.spec.step !== step || n.consumed !== undefined) continue;
      try {
        await markRunNoticeConsumed(
          this.kv, this.binding.endpoint, this.binding.runId,
          n.spec.addressee, n.noticeId, `discharge:${step}`, this.now(),
        );
      } catch (err) {
        // A turn carried it between the read and the write: the create-only status is the arbiter
        // and it has spoken. Anything else is the store, and a discharge that could not finish
        // must not be flipped to `issued`.
        if (!(err instanceof EpEnvelopeError && err.code === "conflict")) throw err;
      }
    }
  }

  /**
   * Release a cancelled spawn's AGENT (§8.6.4): the world half a loser `spawn` leaves behind is a
   * seat the run will never address, so the discharge despawns it. The goal's identity re-derives
   * from the entry alone — the request id IS the goalId (the pinned envelope id) unless the entry
   * bound another (an adopted seat's), and the caller triple is run-stable — so a crash before the
   * acceptance was even bound still finds its goal.
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
    // The bound goal when the entry carries one (a spawn a migration handed a seat binds the
    // ORPHANED spawn's goal, under which its terminal and its seat live); the request id otherwise.
    const goalId = typeof e.external?.goalId === "string" ? e.external.goalId : e.requestId as string;
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
          throw new Error(`the spawn goal "${goalId}" is accepted but reached no terminal within its ${window}ms readiness window; its agent cannot be released yet, and the discharge stays open to retry`);
        await delay(GOAL_POLL_MS);
      }
    }
    if (fact.state !== "succeeded" && fact.state !== "uncertain") return;
    const target = spawnDespawnTarget(e.external, fact);
    if (target === undefined) {
      // An `uncertain` terminal carries no identity, and this entry bound none (the crash landed
      // between the acceptance and the bind). The seat — if one came up — is not addressable from
      // here, and no retry will ever learn more, so throwing would wedge every future sweep of
      // this run behind an answer that cannot arrive. Name the leak for the operator instead.
      console.error(`! discharge: the spawn goal "${goalId}" settled ${fact.state} with no readable agent identity; if its seat is up it must be despawned by hand (\`cotal ps\`)`);
      return;
    }
    // The manager that committed the terminal allocated the seat, and a manager's target resolver
    // knows only its own seats: any other member answers `expired` for this one while it runs. So a
    // miss says "already gone" only from the allocator. One from another member is re-issued on the
    // class rail, and so is a split refusal `invokeManager` gave up repairing, since it states that
    // nothing ran. A bounded run of them leaves the discharge open rather than claiming it gone.
    const allocator = fact.committer?.instanceId;
    let unanswered = 0;
    for (let attempt = 0; ; attempt += 1) {
      let reply: EpAttributedReply;
      try {
        reply = await this.invokeManager(await this.manager("despawn"), "despawn", { graceful: true }, {
          target: { mode: "owner", ...target },
          deadlineMs: SPAWN_ACCEPT_DEADLINE_MS,
        });
      } catch (err) {
        // Silence leaves the outcome unknown. Repeating this despawn is safe only because every
        // attempt pins the same lifecycle, including when the first one already retired it.
        if (!unansweredRequest(err) || ++unanswered >= SPAWN_DISCHARGE_UNANSWERED_ATTEMPTS
          || attempt === MANAGER_ROUTE_ATTEMPTS) throw err;
        this.managerServices.delete("despawn");
        await delay(GOAL_POLL_MS);
        continue;
      }
      // Tolerated refusals are the two "already gone" shapes: `not-found` (no such agent), and
      // `expired` (the target's lifecycle mapping is gone or rotated — this despawn pins one
      // incarnation, and an incarnation the mapping no longer names is not running).
      if (reply.reply.ok) return;
      const code = reply.reply.error.code;
      const unrun = replyRefusedBeforeEffect(reply.reply.error);
      if (!unrun && code !== "not-found" && code !== "expired")
        throw new Error(`the spawn's agent could not be despawned: ${reply.reply.error.message}`);
      if (!unrun && (allocator === undefined || reply.responder.instanceId === allocator)) return;
      if (attempt === MANAGER_ROUTE_ATTEMPTS)
        throw new Error(`the spawn goal "${goalId}" was allocated by manager instance ${allocator ?? "(unrecorded)"}, but none of ${attempt + 1} despawns was answered by it, and neither another manager's miss nor a refusal that ran nothing means it is gone; the discharge stays open to retry`);
      this.managerServices.delete("despawn");
    }
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
    try {
      await this.arm(ref, deadline);
    } catch (error) {
      // Only a relative sleep has finished when its authorized first arm finds no pause
      // and its duration has already elapsed. Existing pauses still settle on their facts.
      if (!(error instanceof PauseOverdue)) throw error;
      if (ctx.signal.cancelled) throw new Cancelled(ctx.signal.reason ?? "cancelled");
      return null;
    }

    await this.settle(ref, ctx.signal);
    return null;
  }

  /**
   * `waitUntil`'s cadence, as a durable pause nobody answers.
   *
   * THE SAME PLANE AS `sleep`, for the reason `sleep` gives for reusing the checkpoint plane: a
   * durable pause with a deadline, a token that survives a crash and a one-use settle is what this
   * needs, and a second timer mechanism would be a second thing to get wrong. What differs is that
   * a `waitUntil` parks MANY times under one step, so each observation's pause takes its own
   * DERIVED token (`observeToken`), exactly as an ask's re-attempts and a wait's second deadline do.
   * Deriving rather than remembering is what makes it recoverable: a resumed run re-derives the
   * same token from the request id and the attempt index, and re-attaches to the pause the crashed
   * attempt armed instead of arming a second one.
   *
   * THIS HANDLER NEVER OBSERVES ANYTHING. The probe is the program's and the interpreter calls it;
   * all that happens here is the waiting. So there is nothing to bind and nothing to read back:
   * the observations are the journal's, written by the interpreter, and this returns only whether
   * there was time left.
   */
  async observe(req: ObserveRequest, ctx: EffectContext): Promise<boolean> {
    if (ctx.signal.cancelled) throw new Cancelled(ctx.signal.reason ?? "cancelled");
    // OUT OF TIME IS ANSWERED BEFORE ANYTHING IS ARMED. A pause armed at an instant that has
    // already passed is a timer that fires immediately and a record nobody needs, and the caller's
    // next act on `false` is to fail the step.
    if (this.now() >= req.deadlineAt) return false;
    // ATTEMPT 0 LOOKS IMMEDIATELY: a wait that sleeps before it has ever looked cannot notice a
    // predicate that already holds, and "are the checks finished" is often already true.
    if (req.attempt === 0) return true;

    // The cadence, CLAMPED to the deadline. Parking past it would hold the run beyond the instant
    // the program said to give up at, and then report a lateness the wait never agreed to.
    const wake = Math.min(this.now() + parseDuration(req.every), req.deadlineAt);
    const ref: CheckpointRef = {
      endpoint: this.binding.endpoint,
      token: observeToken(ctx.requestId, req.attempt),
    };
    if (!(await this.armUnlessDue(ref, wake, ctx.signal))) await this.settle(ref, ctx.signal);
    // Re-read the clock rather than trusting the arithmetic: the pause may have been settled by a
    // heartbeat-advanced deadline or by this host being away, and what decides whether there is
    // still time is where the clock actually is now.
    return this.now() < req.deadlineAt;
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
   *
   * WHAT IT ASKS IS BOUND ON THE ENTRY, and that is not decoration. A pause the reference calls
   * "a durable pause a human or an agent resolves from anywhere" is answered by address (`run`
   * plus step key), and the prompt lived only in the source: everything durable held the input
   * HASH, so whoever was asked saw a token and had to go find the program to learn the question.
   * `to` rides with it for the same reason — an escalation names an addressee, and an addressee
   * nothing records is an addressee nobody can be shown.
   */
  async checkpoint(req: CheckpointRequest, ctx: EffectContext): Promise<CheckpointRaw> {
    if (ctx.signal.cancelled) throw new Cancelled(ctx.signal.reason ?? "cancelled");
    const ref: CheckpointRef = { endpoint: this.binding.endpoint, token: ctx.requestId };
    // ONE deadline per attempt, decided when the attempt is first bound and read back from the
    // entry on every re-entry, exactly as `ask` does. Recomputing `now + timeout` on a resume
    // handed the relay an instant the pause did not have: `arm` attaches to the recorded spec and
    // keeps ITS deadline, so the seat's hold and the checkpoint plane denied at different times.
    // The binding is this attempt's only if this attempt wrote it: an escalation reissues the entry
    // with attempt 0's binding still on it, and read as attempt 1's it handed the hop a deadline
    // that had already passed and skipped the hop's own bind. A binding with no index predates the
    // index and is attempt 0's, as an entry with no `attempt` is.
    const bound = (ctx.resume?.attempt ?? 0) === ctx.attempt ? ctx.resume : undefined;
    const recorded = bound?.deadlineAt;
    const deadline = typeof recorded === "number"
      ? recorded
      : this.now() + parseDuration(req.timeout ?? this.binding.defaultCheckpointTimeout);

    // Once per attempt, before the pause exists: a crash between the bind and the mint leaves a
    // pending entry that says what it was going to ask, which is the harmless direction.
    // `onExpiry` rides beside them for the operator view, as this attempt was armed (`fail` when the
    // program sets none). What an expiry does is still decided from the source, never read from here.
    if (bound?.asks === undefined)
      await ctx.bind({ attempt: ctx.attempt, asks: req.prompt, ...(req.schema !== undefined ? { schema: req.schema } : {}), deadlineAt: deadline, onExpiry: req.onExpiry ?? "fail", ...(req.to !== undefined ? { addressee: req.to } : {}) });

    // AN ESCALATION IS ADDRESSED, so where the addressee is an agent of this run it is TOLD.
    // Attempt 0 has no addressee (the reference allows `to` only with `onExpiry: "escalate"`,
    // and the escalation is the second mint), and a `to` that names no agent of this run is a
    // person: nothing to relay to, and the pause is answerable from anywhere by design. Both
    // are visible at the operator surface, which is what the bind above is for. Told BEFORE the
    // pause is armed, the order `ask` uses: a relay this endpoint refuses outright then fails the
    // step with nothing armed behind it, instead of leaving a timer to fire into a failed step.
    if (ctx.attempt > 0 && req.to !== undefined) await this.relayEscalation(req, ctx, ref.token, deadline);

    if (await this.armUnlessDue(ref, deadline, ctx.signal)) return { outcome: "expired", at: this.now() };

    const settled = await this.settle(ref, ctx.signal, true);
    if (settled.settle === "expired") return { outcome: "expired", at: settled.ts };
    // The settle NAMES its answer, and the record is read under that name rather than by looking
    // for "the answer to this token": two resolvers can have filed answers and only one of them
    // was accepted, so an answer found by token alone could be the loser's.
    const answer = settled.answerId === undefined
      ? undefined
      : this.services ? await this.services.pauses.readAnswer(ref.token) : await readCheckpointAnswer(this.kv, this.binding.endpoint, ref.token, settled.answerId);
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
   * `down(agent)` and `replied(agent)` are agent-addressed events with no channel, so they branch
   * to `waitDown` and `waitReplied` before any of the channel machinery. The binding comes first
   * because a hosted run mints only the timers its entry records, whichever branch arms them.
   */
  async wait(req: WaitRequest, ctx: EffectContext): Promise<unknown | null> {
    if (ctx.signal.cancelled) throw new Cancelled(ctx.signal.reason ?? "cancelled");
    const ev = req.event;
    if (!isWaitEvent(ev))
      throw new Error(`wait() takes an event built by message(channel("<name>")), idle(channel("<name>"), duration), replied(agent) or down(agent), and was given ${JSON.stringify(ev) ?? String(ev)}`);
    const channel = ev.event === "replied" || ev.event === "down" ? undefined : ev.channel;
    if (channel !== undefined && !isConcreteChannel(channel)) {
      throw new Error(`wait() cannot await a wildcard channel ("${channel}"); an await names one channel`);
    }
    const timers = waitTimers(req, ctx.requestId);
    const waitBinding = {
      ...ctx.resume,
      ...(channel !== undefined ? { waitChannel: channel } : {}),
      waitTimers: [timers.primary, timers.outer].filter((token) => token !== undefined),
    };
    if (this.services) {
      if (ctx.resume?.waitChannel !== undefined && ctx.resume.waitChannel !== channel)
        throw new Error(`wait ${ctx.requestId} recorded a different channel`);
      await ctx.bind(waitBinding);
    }
    if (ev.event === "replied") return await this.waitReplied(ev, req, ctx);
    if (ev.event === "down") return await this.waitDown(ev, req, ctx);
    // A recorded seq is a previous attempt's MATCH, taken before the crash. Return that message
    // rather than looking again: the consumer has already acked it, so looking again would wait for
    // a second event the program never asked for.
    const bound = ctx.resume?.chatSeq;
    if (typeof bound === "number") {
      // The match is recorded, so this wait is over — and the deadlines the PREVIOUS attempt armed
      // are still live, because the crash came before it could claim them. Claim them here for the
      // same reason the live match path does: this is the ending, it just happened last time.
      await this.cancelTimer({ endpoint: this.binding.endpoint, token: ctx.requestId });
      await this.cancelTimer({ endpoint: this.binding.endpoint, token: waitTimeoutToken(ctx.requestId) });
      return await this.messageAt(bound, ctx.requestId);
    }

    const timeoutAt = req.timeout === undefined ? undefined : this.now() + parseDuration(req.timeout);
    const idleFor = ev.event === "idle" ? parseDuration(ev.duration) : undefined;
    const matcher = ev.event === "message" && ev.matches !== undefined ? compileMatch(ev.matches) : undefined;
    const sender = ev.event === "message" && ev.from !== undefined ? this.waitSender(ev.from) : undefined;

    // ONE token per deadline, both derived, so a resume re-derives them instead of remembering. The
    // arm takes the tokens the binding recorded above, so it can never mint one the binding did not.
    const primary = timers.primary === undefined ? undefined : { endpoint: this.binding.endpoint, token: timers.primary };
    const outer = timers.outer === undefined ? undefined : { endpoint: this.binding.endpoint, token: timers.outer };
    // A deadline that passed before its pause was minted has nothing to settle. It ends the wait in
    // the loop, once the channel is open under the run's read admission and after cancellation.
    const primaryDue = primary !== undefined && await this.armUnlessDue(primary, idleFor !== undefined ? this.now() + idleFor : timeoutAt!, ctx.signal);
    const outerDue = outer !== undefined && await this.armUnlessDue(outer, timeoutAt!, ctx.signal);
    const timedOut = outer !== undefined ? outerDue : idleFor === undefined && primaryDue;

    const durable = waitConsumerName(ctx.requestId);
    const stream = chatStream(this.binding.space);
    if (this.services) await this.services.waits.open(ctx.requestId, ev.channel);
    else await this.jsm.consumers.add(stream, waitConsumerConfig(this.binding.space, ctx.requestId, ev.channel));
    const consumer = this.services ? undefined : await this.js.consumers.get(stream, durable);
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
        // A deadline that passed before its pause was minted, the timeout ahead of the idle window.
        if (timedOut || idleFor !== undefined && primaryDue) {
          if (outer !== undefined) await this.cancelTimer(timedOut ? primary! : outer);
          over = true;
          return timedOut ? null : { channel: ev.channel, at: this.now() };
        }
        // The deadline is durable and authoritative — a checkpoint's settle fact — and this is only
        // the OBSERVATION of it, so the cost of polling is lateness bounded by one poll rather than
        // a wait that outlives its deadline.
        // A WAIT THAT IS OVER CLAIMS BOTH OF ITS DEADLINES, on every path that ends it. An idle
        // wait with a timeout arms two, and each expiry used to claim only the one it read: the
        // sibling stayed armed, fired into a run that had moved on, and sat there as an unclaimed
        // settle until the run's own discharge swept it. The match path below already did this.
        const ended = await this.expired(outer ?? (idleFor === undefined ? primary : undefined));
        if (ended !== undefined) {
          if (outer !== undefined && primary !== undefined) await this.cancelTimer(primary);
          over = true;
          return null;
        }
        if (idleFor !== undefined && (await this.expired(primary)) !== undefined) {
          if (outer !== undefined) await this.cancelTimer(outer);
          over = true;
          return { channel: ev.channel, at: this.now() };
        }
        const batch = this.services
          ? (await this.services.waits.fetch(ctx.requestId)).map((message) => ({
              seq: message.sequence, subject: message.subject, data: message.data,
              ack: () => this.services!.waits.ack(ctx.requestId, message.receipt),
            }))
          : await consumer!.fetch({ max_messages: 16, expires: WAIT_POLL_MS });
        for await (const m of batch) {
          const msg = decodeMessage(m.data);
          if (idleFor !== undefined) {
            // ANY traffic resets an idle window, matched or not: "idle" is a fact about the
            // channel, not about the messages this program finds interesting.
            await m.ack();
            await this.push(primary!, this.now() + idleFor);
            continue;
          }
          if (msg === undefined || !matchesEvent(msg, m.subject, sender, matcher)) { await m.ack(); continue; }
          // BIND BEFORE ACK. The bind is durable; the ack is what makes the message unrecoverable.
          // In this order a crash in between redelivers it, and a crash after it is answered from
          // the recorded sequence — in the other order the match is simply lost.
          await ctx.bind(this.services ? { ...waitBinding, chatSeq: m.seq } : { chatSeq: m.seq });
          await m.ack();
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
      if (over && this.services) await this.services.waits.close(ctx.requestId);
      else if (over) {
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
   * under a DIFFERENT incarnation — this incarnation dead with a successor already up. A lapse is
   * read as the death only once the row has stayed absent for {@link LAPSE_CONFIRM_MS} and its manager
   * no longer runs the seat: a seat whose connector stalled past the row's TTL renews it under the same
   * uid, and that seat is not down.
   *
   * THE DEATH NEVER BINDS, because a death is re-observable where a matched message is not: a dead
   * incarnation's uid never heartbeats again, so a crash between the observation and the settle
   * re-observes the same death on resume (after a fresh confirmation window) — at worst
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
    // `down(agent)` is an event AFTER `monitor` registered interest (cotal-lang 6.5); a wait on an
    // agent nobody monitored would be a registration this run never recorded.
    if (!this.monitored.has(`${name}#${uid}`))
      throw new Error(`wait(down(${name}#${uid})) observes a monitored agent, and this run never performed monitor() on that handle; register interest first (cotal-lang 6.5)`);
    const { primary: token } = waitTimers(req, ctx.requestId);
    const primary = token === undefined ? undefined : { endpoint: this.binding.endpoint, token };
    if (primary !== undefined) await this.arm(primary, this.now() + parseDuration(req.timeout!));
    const watch: DeathWatch = {};
    const decided = async (): Promise<boolean> => ctx.signal.cancelled || (await this.expired(primary)) !== undefined;
    for (;;) {
      if (ctx.signal.cancelled) {
        if (primary !== undefined) await this.cancelTimer(primary);
        throw new Cancelled(ctx.signal.reason ?? "cancelled");
      }
      const ended = await this.expired(primary);
      if (ended !== undefined) return null;
      const reason = await this.presenceDeath(name, uid, watch, decided);
      if (reason !== undefined) {
        if (primary !== undefined) await this.cancelTimer(primary);
        return { agent: ev.agent, reason, at: this.now() };
      }
      await delay(WAIT_POLL_MS);
    }
  }

  /**
   * `wait(replied(agent))` — the agent finished a reply, observed over THIS RUN's turn terminals.
   *
   * The honest observable a run holds for "finished a reply" is the terminal fact of a turn it
   * relayed itself: a `succeeded` turn goal IS a completed reply, durable on the goal plane. The
   * wait resolves off the run's turn-goal registry for the handle — fed by `turn` at submission
   * and reseeded from the journal on adoption — and REPLIED IS A LEVEL, exactly as `down` is: a
   * reply that already exists resolves the wait at once (the latest, by the yield's own `at`
   * stamp), and a wait that begins before any reply parks for the next terminal. A denied or
   * cancelled turn is not a reply — the agent never finished one — so it leaves the wait parked.
   * A handle outside the run's roster with no recorded turn can never be observed (only this
   * run's turns are), so it refuses loudly instead of parking on nothing.
   *
   * THE REPLY NEVER BINDS, for `down`'s reason: goal terminals are durable facts, so a crash between
   * the observation and the settle re-observes the same reply on resume — at worst a NEWER reply
   * completed in between. The value is the observation record, `down`-shaped:
   * `{ agent, status, note?, at }`, where `at` is the yield's own stamp. The TIMEOUT is the same
   * mediated pause every wait arms, resolving `null`, never a throw.
   */
  private async waitReplied(
    ev: { readonly agent: string },
    req: WaitRequest,
    ctx: EffectContext,
  ): Promise<unknown | null> {
    const { name, uid } = parseAgentHandle(ev.agent);
    const handle = `${name}#${uid}`;
    if (this.turnGoals.get(handle) === undefined) {
      const entry = this.roster.get(name);
      if (entry === undefined || entry.uid !== uid)
        throw new Error(`wait(replied(${handle})) addresses an agent that is not in this run's roster; a reply is observed on a turn this run relayed`);
    }
    const { primary: token } = waitTimers(req, ctx.requestId);
    const primary = token === undefined ? undefined : { endpoint: this.binding.endpoint, token };
    if (primary !== undefined) await this.arm(primary, this.now() + parseDuration(req.timeout!));
    const actx = await this.actionCtx();
    for (;;) {
      if (ctx.signal.cancelled) {
        if (primary !== undefined) await this.cancelTimer(primary);
        throw new Cancelled(ctx.signal.reason ?? "cancelled");
      }
      const ended = await this.expired(primary);
      if (ended !== undefined) return null;
      const goals = this.turnGoals.get(handle);
      let latest: { status: string; note?: string; at: number } | undefined;
      for (const goalId of goals ?? []) {
        const fact = await readGoalResult(actx, { endpoint: this.binding.endpoint, caller: this.binding.caller, goalId });
        if (fact === undefined) continue;
        // Denied (deadline) or cancelled: the agent never finished a reply. Stop reading it.
        if (fact.state !== "succeeded") { goals!.delete(goalId); continue; }
        const d = fact.data as { status?: unknown; note?: unknown; at?: unknown } | undefined;
        if ((d?.status !== "done" && d?.status !== "blocked" && d?.status !== "handoff") || typeof d.at !== "number")
          throw new Error(`wait(replied(${handle})) observed a malformed turn terminal (${JSON.stringify(fact.data)}); a garbled yield never resolves a wait`);
        // A handoff the turn refuses (an addressee outside the run, or across worktrees) is the
        // turn's own failure, so it is not a reply here either: both observers read one verdict.
        if (d.status === "handoff" && this.handoffRefusal(this.roster.get(name)?.handle.worktree, (d as { to?: unknown }).to) !== undefined) {
          goals!.delete(goalId);
          continue;
        }
        if (latest === undefined || d.at > latest.at)
          latest = { status: d.status, ...(typeof d.note === "string" ? { note: d.note } : {}), at: d.at };
      }
      if (latest !== undefined) {
        if (primary !== undefined) await this.cancelTimer(primary);
        return { agent: ev.agent, ...latest };
      }
      await delay(WAIT_POLL_MS);
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
   * happens. Nothing is written twice and nothing needs a memo of how far it got. That holds only
   * because the instant every notice carries is bound with the step rather than read from the
   * clock again, which is the one field a second pass could otherwise change.
   *
   * The fact's bound is the language's and is enforced BEFORE this is reached (L3043 at the effect
   * boundary), so a fact that could not be rendered as one table row cannot arrive here.
   */
  async notify(req: NotifyRequest, ctx: EffectContext): Promise<null> {
    // THE INSTANT IS BOUND, never re-read. `writeRunNotice` is create-only and compares canonical
    // bytes, so a second pass carrying a fresh clock reading hits `conflict` on the notice the
    // first pass already wrote, and every retry after that hits it identically: the run wedges on
    // the one effect whose whole design is that re-running it is safe. A crash between the write
    // and the settling append is ordinary, so the retry has to rewrite the same bytes.
    const recorded = ctx.resume?.at;
    const at = typeof recorded === "number" ? recorded : this.now();
    if (typeof recorded !== "number") await ctx.bind({ at });
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

  /** Poll the goal's durable terminal fact, observing cancellation on the poll cadence — the same
   *  discipline as `wait`: a race decided against this branch stops parking within one poll, and
   *  the seat its acceptance may have produced is the DISCHARGE's to release, not this branch's. */
  private async goalTerminal(ref: GoalRef, signal: CancelSignal): Promise<GoalResultFact> {
    const actx = await this.actionCtx();
    for (;;) {
      if (signal.cancelled) throw new Cancelled(signal.reason ?? "cancelled");
      const fact = await readGoalResult(actx, ref);
      if (fact !== undefined) return fact;
      await delay(GOAL_POLL_MS);
    }
  }

  /** Resolve the native personal session whose exact issued caller admitted this run. Its identity
   * comes only from the immutable admission, never from program text. The manager separately requires
   * a current finite participation lease when a turn is dispatched. */
  async participant(_req: ParticipantRequest, ctx: EffectContext): Promise<AgentHandleValue> {
    if (!this.services)
      throw new EffectError("L4000", "participant", "participant() requires a hosted run with an admission reader");
    const view = await this.services.admission();
    if (view.revoked)
      throw new EffectError("L4000", "participant", `participant() refused because run ${this.binding.runId} is revoked`);
    const admitted = view.admission;
    const caller = admitted.caller;
    if (admitted.provenance.kind !== "issued" || !/^pa_[a-z2-7]{26}$/.test(caller.actor))
      throw new EffectError("L4000", "participant", "participant() binds only an issued personal conversation that admitted this run");
    const principal = `${caller.owner}.${caller.actor}`;
    const rows = (await this.presenceRows()).filter((p) =>
      p.card.id === principal && p.lifecycleUid === caller.uid && p.status !== "offline");
    if (rows.length !== 1)
      throw new EffectError("L4002", "participant", rows.length === 0
        ? `participant() found no live exact presence for ${principal}#${caller.uid}`
        : `participant() found multiple exact presence rows for ${principal}#${caller.uid}; no row was selected`);
    const name = rows[0]!.card.name;
    const handle: AgentHandleValue = { kind: "participant", agent: `${name}#${caller.uid}`, persona: "participant" };
    await ctx.bind({ owner: caller.owner, actor: caller.actor, uid: caller.uid, name, host: admitted.instanceId });
    this.roster.set(name, { handle, owner: caller.owner, actor: caller.actor, uid: caller.uid, host: admitted.instanceId });
    return handle;
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
    const { name, uid } = parseAgentHandle(req.agent.agent);
    // The entry carries the handle it registered, so an adopted run rebuilds the same registry.
    await ctx.bind({ agent: `${name}#${uid}` });
    this.monitored.add(`${name}#${uid}`);
    return null;
  }

  /** The pause timers own no handler state: each input is read through the handler at its use. */
  private readonly pauseTimers = new PauseTimers({
    binding: () => this.binding, kv: () => this.kv, js: () => this.js, jsm: () => this.jsm, watcher: () => this.watcher,
    services: () => this.services, lag: () => this.lag, onStarved: (note) => this.onStarved(note), now: () => this.now(),
    withdrawCancelledRelay: (goalId, deadlineAt) => this.withdrawCancelledRelay(goalId, deadlineAt),
  });

  private async arm(ref: CheckpointRef, deadline: number): Promise<void> { return this.pauseTimers.arm(ref, deadline); }
  private async armUnlessDue(ref: CheckpointRef, deadline: number, signal: CancelSignal): Promise<boolean> { return this.pauseTimers.armUnlessDue(ref, deadline, signal); }
  private async push(ref: CheckpointRef, deadline: number): Promise<void> { return this.pauseTimers.push(ref, deadline); }
  private async expired(ref: CheckpointRef | undefined): Promise<CheckpointSettleFact | undefined> { return this.pauseTimers.expired(ref); }
  private async cancelTimer(ref: CheckpointRef): Promise<void> { return this.pauseTimers.cancelTimer(ref); }
  private async messageAt(seq: number, requestId: string): Promise<unknown> { return this.pauseTimers.messageAt(seq, requestId); }
  private async settle(ref: CheckpointRef, signal?: CancelSignal, relayed = false): Promise<CheckpointSettleFact> { return this.pauseTimers.settle(ref, signal, relayed); }

  /** The relay and presence watch own no handler state: each input, the handler's own members
   *  included, is read through the handler at its use. */
  private readonly seatWatch = new SeatWatch({
    self: () => this,
    binding: () => this.binding,
    roster: () => this.roster,
    managerServices: () => this.managerServices,
    now: () => this.now(),
    actionCtx: () => this.actionCtx(),
    presenceRegistry: () => this.presenceRegistry(),
    seatAddress: (name, uid) => this.seatAddress(name, uid),
    manager: (command, instanceId) => this.manager(command, instanceId),
    invokeManager: (service, command, args, opts) => this.invokeManager(service, command, args, opts),
    relayManagerBeforeSubmit: (host, command, ref, kind, label) => this.relayManagerBeforeSubmit(host, command, ref, kind, label),
  });

  private async relayEscalation(req: CheckpointRequest, ctx: EffectContext, token: string, deadlineAt: number): Promise<void> { return this.seatWatch.relayEscalation(req, ctx, token, deadlineAt); }
  private async relayToSeat(seat: SeatAddress, goalId: string, payload: string, deadlineAt: number, kind: "ask" | "checkpoint", step: string): Promise<void> { return this.seatWatch.relayToSeat(seat, goalId, payload, deadlineAt, kind, step); }
  private async withdrawRelay(goalId: string): Promise<void> { return this.seatWatch.withdrawRelay(goalId); }
  private async withdrawCancelledRelay(goalId: string, deadlineAt?: number): Promise<void> { return this.seatWatch.withdrawCancelledRelay(goalId, deadlineAt); }
  private async presenceRows(): Promise<Presence[]> { return this.seatWatch.presenceRows(); }
  private async presenceDeath(name: string, uid: string, watch: DeathWatch, decided: () => Promise<boolean>): Promise<"superseded" | "lapsed" | undefined> { return this.seatWatch.presenceDeath(name, uid, watch, decided); }

  /** The turn and ask clients own no handler state: the run-memory maps they write are mutated in
   *  place through getters, and each input, the handler's own members included, is read through
   *  the handler at its use. */
  private readonly turnAsk = new TurnAsk({
    self: () => this,
    binding: () => this.binding,
    kv: () => this.kv,
    services: () => this.services,
    lag: () => this.lag,
    onStarved: () => this.onStarved,
    roster: () => this.roster,
    turnsTaken: () => this.turnsTaken,
    handoffMemos: () => this.handoffMemos,
    turnGoals: () => this.turnGoals,
    now: () => this.now(),
    actionCtx: () => this.actionCtx(),
    manager: (command, instanceId) => this.manager(command, instanceId),
    invokeManager: (service, command, args, opts) => this.invokeManager(service, command, args, opts),
    relayManagerBeforeSubmit: (host, command, ref, kind, label) => this.relayManagerBeforeSubmit(host, command, ref, kind, label),
    arm: (ref, deadline) => this.arm(ref, deadline),
    expired: (ref) => this.expired(ref),
    cancelTimer: (ref) => this.cancelTimer(ref),
    settle: (ref, signal, relayed) => this.settle(ref, signal, relayed),
    presenceDeath: (name, uid, watch, decided) => this.presenceDeath(name, uid, watch, decided),
    relayToSeat: (seat, goalId, payload, deadlineAt, kind, step) => this.relayToSeat(seat, goalId, payload, deadlineAt, kind, step),
    withdrawCancelledRelay: (goalId, deadlineAt) => this.withdrawCancelledRelay(goalId, deadlineAt),
    recordTurnGoal: (handle, goalId) => this.recordTurnGoal(handle, goalId),
    recordHandoffMemo: (scope, to, fromGoalId) => this.recordHandoffMemo(scope, to, fromGoalId),
  });

  async turn(req: TurnRequest, ctx: EffectContext): Promise<TurnResultValue> { return this.turnAsk.turn(req, ctx); }
  async ask(req: AskRequest, ctx: EffectContext): Promise<unknown> { return this.turnAsk.ask(req, ctx); }
  private handoffRefusal(fromWorktree: string | undefined, to: unknown): "L4005" | "L4004" | undefined { return this.turnAsk.handoffRefusal(fromWorktree, to); }
  private seatAddress(name: string, uid?: string): { address: SeatAddress; why?: undefined } | { address?: undefined; why: "not-in-roster" | "no-floor" } { return this.turnAsk.seatAddress(name, uid); }
  private waitSender(agent: string): string { return this.turnAsk.waitSender(agent); }

  /** The spawn action and its worktree guard. Every dependency reads through at its use. */
  private readonly spawnComponent = new MeshSpawn({
    actionCtx: (...args) => this.actionCtx(...args),
    adoptable: () => this.adoptable,
    binding: () => this.binding,
    goalTerminal: (...args) => this.goalTerminal(...args),
    invokeManager: (...args) => this.invokeManager(...args),
    manager: (...args) => this.manager(...args),
    nc: () => this.nc,
    now: (...args) => this.now(...args),
    presenceRows: (...args) => this.presenceRows(...args),
    roster: () => this.roster,
    worktreeHolders: () => this.worktreeHolders,
  });

  async spawn(req: SpawnRequest, ctx: EffectContext): Promise<AgentHandleValue> { return this.spawnComponent.spawn(req, ctx); }

  /** The conclave lifecycle and the registries it opens. It owns the open conclave plans and the lazy registry handles; every other dependency reads through at its use. */
  private readonly conclaveComponent = new MeshConclave({
    binding: () => this.binding,
    jsm: () => this.jsm,
    nc: () => this.nc,
    now: (...args) => this.now(...args),
    presenceRows: (...args) => this.presenceRows(...args),
    services: () => this.services,
  });

  /** Reached by run-driver-auth.smoke through a cast: the members handle the conclave component holds. */
  membersRegistry(): Promise<KV> { return this.conclaveComponent.membersRegistry(); }
  private async dischargeConclave(e: JournalEntry): Promise<void> { return this.conclaveComponent.dischargeConclave(e); }
  async openConclave(req: ConclaveRequest, ctx: EffectContext): Promise<ChannelHandleValue> { return this.conclaveComponent.openConclave(req, ctx); }
  async closeConclave(_req: ConclaveRequest, ctx: EffectContext): Promise<null> { return this.conclaveComponent.closeConclave(_req, ctx); }
}

export { waitConsumerName, waitConsumerConfig } from "@cotal-ai/core";
/** The seat an ask is told to: its roster identity and address.
 *  `host` pins a placed seat's turns to its placement instance; unplaced seats use the class rail. */
export type SeatAddress = { name: string; uid: string; owner: string; actor: string; host?: string };
/** A worktree's holder: the live seat spawned into it, or the spawn goal still bringing one up. */
type WorktreeHolder = { name: string; uid: string } | { pending: string };
/**
 * The keyed view of an append log: the last record written for each step, in the order the run
 * first reached it.
 *
 * A DRIVER HANDS OVER AN APPEND LOG, never a keyed journal. Settling appends a second record rather
 * than editing the first, so every completed step is in the list twice and a retried one is in it
 * more times still. Seeding from the raw list charged one turn to `permits.turns` once per RECORD,
 * so an agent with two turns was refused its second the moment its run recovered; it also left a
 * failed spawn holding a worktree reservation forever, and re-registered turn goals for turns the
 * run had cancelled. `fork.ts` carries the same warning about the same list, from the same defect.
 *
 * The fold is the journal's own, so "the state of this step" has one definition here and there.
 */
function foldEntries(entries: readonly JournalEntry[]): readonly JournalEntry[] {
  const first = entries[0];
  if (first === undefined) return entries;
  return new Journal({ run: first.run, entries, readOnly: true }).entries();
}
/** Total unanswered attempts per seat. Separate from class routing so an outage is bounded. */
const SPAWN_DISCHARGE_UNANSWERED_ATTEMPTS = 3;
/** The terminal wait a discharge grants a goal whose entry recorded no readiness window (the
 *  crash-before-bind case). Matches the manager's default readiness budget. */
const DISCHARGE_TERMINAL_BOUND_MS = 30_000;

/**
 * #1616 proof item 5 — ALIAS NORMALIZATION POLICY. One clone reached through a symlink and through
 * its realpath is ONE writable directory, and the single-writer rule keys on identity, so the two
 * forms must collapse before any claim is taken. THE CANONICAL FORM IS THE REALPATH: it is the form
 * the kernel and the child's own `process.cwd()` report, so a claim keyed on it matches what any
 * concurrent run or imperative spawn path observes, whichever alias that caller typed. The symlink
 * path is NOT canonical — normalizing toward it would require resolving every other alias to it,
 * which has no unique answer. Resolution is done ONCE, on the serving host, before the claim and
 * before launch; an unresolvable path is a refusal, never a pass-through of the raw string.
 */
export function canonicalCwd(cwd: string): string {
  return realpathSync(cwd);
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

/** Is `ev` an event descriptor `wait` can observe? The program passes it as a value, so a string or
 *  a constructor given the wrong argument arrives here unbuilt, and the channel and agent paths
 *  below would fail on it with a host TypeError that names nothing the program wrote. */
function isWaitEvent(ev: unknown): ev is WaitRequest["event"] {
  if (ev === null || typeof ev !== "object") return false;
  const e = ev as { event?: unknown; channel?: unknown; agent?: unknown };
  if (e.event === "message" || e.event === "idle") return typeof e.channel === "string";
  return (e.event === "replied" || e.event === "down") && typeof e.agent === "string";
}

/** Does this message answer the await? It must come from the principal its subject names (SPEC
 *  §5), and when the wait names a `sender` principal, the subject's sender must be that principal.
 *  The payload's `from.name` is whatever the sender wrote, so it is never compared. */
function matchesEvent(msg: CotalMessage, subject: string, sender: string | undefined, matcher: RegExp | undefined): boolean {
  const parsed = parseSubject(subject);
  if (parsed === null || !isFromSubjectSender(msg, parsed)) return false;
  if (sender !== undefined && parsed.sender !== sender) return false;
  if (matcher === undefined) return true;
  const text = (msg.parts ?? [])
    .filter((p): p is { kind: "text"; text: string } => p.kind === "text" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("\n");
  return matcher.test(text);
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
 * only the first would re-arm timers for pauses that are already over. What each open step owns is
 * {@link pauseTokens}: a held step's attempt token is still listed after its hold binds and
 * re-arms nothing, because the reconciler re-emits a schedule only for a waiting pause.
 */
export function outstandingPauseTokens(entries: readonly JournalEntry[]): string[] {
  const last = new Map<string, JournalEntry>();
  for (const e of entries) last.set(journalEntryKeyString(e), e);
  return [...last.values()].filter((e) => e.state === "pending").flatMap(pauseTokens);
}

/**
 * The settle watcher over EPF, which is where the one-use settle fact lives.
 *
 * It POLLS the fact's subject through the plane's own leader-served read rather than binding a
 * consumer to it. The earlier shape created an ephemeral consumer per wait, and an ephemeral create
 * rides the bare `CONSUMER.CREATE.<stream>` form, whose request body is not subject-ACL confinable
 * and which no minted profile may hold (SPEC 13.9). The run driver's credential holds the
 * `STREAM.MSG.GET` read on EPF already, for the same fact, so the watcher reads what the driver can
 * read and nothing more. A settle is a record, not a notification: the fact may already be there
 * when the wait begins, and the first read answers at once.
 *
 * The cadence is the same one the handler already takes its fires on: the deadline is durable and
 * authoritative, and a poll only bounds how late its observation can be.
 */
export class EpfSettleWatcher implements SettleWatcher {
  private readonly read: (ref: CheckpointRef) => Promise<CheckpointSettleFact | undefined>;
  private readonly pollMs: number;

  constructor(jsm: JetStreamManager, space: string, pollMs?: number);
  constructor(read: (ref: CheckpointRef) => Promise<CheckpointSettleFact | undefined>, pollMs?: number);
  constructor(
    jsmOrRead: JetStreamManager | ((ref: CheckpointRef) => Promise<CheckpointSettleFact | undefined>),
    spaceOrPollMs?: string | number,
    pollMs?: number,
  ) {
    const space = spaceOrPollMs as string;
    this.read = typeof jsmOrRead === "function"
      ? jsmOrRead
      : (ref) => readCheckpointSettle(jsmOrRead, space, ref);
    this.pollMs = (typeof jsmOrRead === "function" ? (spaceOrPollMs as number | undefined) : pollMs) ?? FIRE_POLL_MS;
  }

  async awaitSettle(ref: CheckpointRef): Promise<CheckpointSettleFact> {
    for (;;) {
      const settled = await this.read(ref);
      if (settled !== undefined) return settled;
      await delay(this.pollMs);
    }
  }
}
