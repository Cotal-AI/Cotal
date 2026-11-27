import { bindGoal, canonicalJson, clearGoalIndex, commitGoalResult, createGoal, DEV_OWNER, EpEnvelopeError, firstCommandId, goalAlreadyTerminal, goalRefOf, oneLine, parsePrincipalKey, readGoalIndex, readGoalResult, readGoalSpec, recordGoalIndex, rejectionText, settleGoalUncertain, submissionFingerprint } from "@cotal-ai/core";
import { setTimeout as delay } from "node:timers/promises";
import type { ControlReply, EpErrorCode, EpServeContext, GoalIndexEntry, GoalRef } from "@cotal-ai/core";
import type { Manager } from "./manager.js";
import type { SpawnAcceptance, SpawnHooks } from "./seat-types.js";
import { caughtEnvelope, goalKey } from "./turn-relay.js";
import type { ManagerConfig } from "./manager-config.js";
import type { ManagerStartState } from "./manager-start-state.js";
import type { ManagerParts } from "./manager-parts.js";

/** The failed terminal a post-accept fallback commits for `error` and `source`'s optional details.
 *  `commitGoalResult` refuses a payload that is not interchangeable JSON, and this terminal must commit
 *  whatever failed, so a lone surrogate in the text becomes U+FFFD and details it cannot read or carry
 *  (a Proxy's throwing getter, an accessor, a cycle) are dropped. A Proxy can answer the check and the
 *  serializer differently, so the detached copy is checked again before it commits. */
function failedTerminal(error: string, source: { details?: unknown } | undefined): { error: string; details?: EpEnvelopeError["details"] } {
  const text = error.replace(/\p{Cs}/gu, "\uFFFD");
  try {
    const details = source?.details;
    if (details) {
      const copy = JSON.parse(canonicalJson(details));
      canonicalJson(copy);
      return { error: text, details: copy };
    }
  } catch { /* unreadable or not interchangeable */ }
  return { error: text };
}

/** What {@link SpawnGoal} reads from the Manager. Every entry is read at use, so a field the Manager
 *  assigns after construction is always current, and a Manager method a test replaces is the one that runs. */
export interface SpawnGoalDeps {
  agentGoals: () => Manager["agentGoals"];
  onceWatched: () => Manager["onceWatched"];
  acceptOnceTurn: (...args: Parameters<Manager["acceptOnceTurn"]>) => ReturnType<Manager["acceptOnceTurn"]>;
  assertGoalWriterEpochCurrent: (...args: Parameters<Manager["assertGoalWriterEpochCurrent"]>) => ReturnType<Manager["assertGoalWriterEpochCurrent"]>;
  commitOnceCancel: (...args: Parameters<Manager["commitOnceCancel"]>) => ReturnType<Manager["commitOnceCancel"]>;
  emitGoalProgress: (...args: Parameters<Manager["emitGoalProgress"]>) => ReturnType<Manager["emitGoalProgress"]>;
  executionRefusal: (...args: Parameters<Manager["executionRefusal"]>) => ReturnType<Manager["executionRefusal"]>;
  settleOnceTurn: (...args: Parameters<Manager["settleOnceTurn"]>) => ReturnType<Manager["settleOnceTurn"]>;
}

/** Builds the {@link SpawnGoalDeps} for a Manager. It reads Manager members by name at each use, so a
 *  field the Manager assigns later is current and a member a test replaces on the instance is the one that runs. */
export function spawnGoalDeps(m: Manager): SpawnGoalDeps {
  return {
    agentGoals: () => m["agentGoals"],
    onceWatched: () => m["onceWatched"],
    acceptOnceTurn: (...args) => m["acceptOnceTurn"](...args),
    assertGoalWriterEpochCurrent: (...args) => m["assertGoalWriterEpochCurrent"](...args),
    commitOnceCancel: (...args) => m["commitOnceCancel"](...args),
    emitGoalProgress: (...args) => m["emitGoalProgress"](...args),
    executionRefusal: (...args) => m["executionRefusal"](...args),
    settleOnceTurn: (...args) => m["settleOnceTurn"](...args),
  };
}

/** Serving `spawn` and `launch` as goals: acceptance, the cached acceptance a retry reads, and its expiry. */
export class SpawnGoal {
  constructor(private readonly config: Readonly<ManagerConfig>, private readonly deps: SpawnGoalDeps, private readonly parts: Pick<ManagerParts, "goalWriter" | "servePlane">, private readonly state: ManagerStartState) {}

  // The Manager members these bodies read, under their Manager names. Each reads through its dep at
  // use, so a field the Manager assigns later is current and a method a test replaces on the Manager
  // is the one that runs.
  private get agentGoals() { return this.deps.agentGoals(); }
  private get managerInstanceId() { return this.state.managerInstanceId!; }
  private get onceWatched() { return this.deps.onceWatched(); }
  private get userMode() { return this.state.userMode; }
  private acceptOnceTurn(...args: Parameters<Manager["acceptOnceTurn"]>): ReturnType<Manager["acceptOnceTurn"]> { return this.deps.acceptOnceTurn(...args); }
  private assertGoalWriterEpochCurrent(...args: Parameters<Manager["assertGoalWriterEpochCurrent"]>): ReturnType<Manager["assertGoalWriterEpochCurrent"]> { return this.deps.assertGoalWriterEpochCurrent(...args); }
  private commitOnceCancel(...args: Parameters<Manager["commitOnceCancel"]>): ReturnType<Manager["commitOnceCancel"]> { return this.deps.commitOnceCancel(...args); }
  private emitGoalProgress(...args: Parameters<Manager["emitGoalProgress"]>): ReturnType<Manager["emitGoalProgress"]> { return this.deps.emitGoalProgress(...args); }
  private executionRefusal(...args: Parameters<Manager["executionRefusal"]>): ReturnType<Manager["executionRefusal"]> { return this.deps.executionRefusal(...args); }
  private settleOnceTurn(...args: Parameters<Manager["settleOnceTurn"]>): ReturnType<Manager["settleOnceTurn"]> { return this.deps.settleOnceTurn(...args); }

  /** A spawn's refusal reaches only its caller's terminal, so the manager also writes one line for it
   *  to its own log, naming the request ID the caller printed, the persona and the reason. */
  async loggedSpawnRefusal<T>(ctx: EpServeContext, serve: () => Promise<T>): Promise<T> {
    try { return await serve(); }
    catch (e) {
      const persona = (ctx.request.args as { name?: unknown } | undefined)?.name;
      console.error(oneLine(`! spawn request ${ctx.request.id} for persona "${String(persona ?? "")}" refused (${e instanceof EpEnvelopeError ? e.code : "error"}): ${rejectionText(e)}`));
      throw e;
    }
  }

  /** Serve `spawn`/`launch` as an ACTION. Authz already ran in {@link serveGated}. The
   *  accept path runs INLINE on the handler ({@link startAgent} with hooks): the goal binds + the
   *  acceptance replies the moment the identity is minted, BEFORE any provision, or on the
   *  hosted enrollment arm once the host has enrolled the agent; progress and the terminal are driven
   *  OFF-handler, so the ~30s readiness wait no longer blocks the reply.
   *  Returns the acceptance floor payload {name, owner, actor, uid, goalId, fingerprint, executor}
   *  (the ALLOCATED identity). goalId = the request id (env.id). */
  async serveSpawnGoal(ctx: EpServeContext, run: (hooks: SpawnHooks) => Promise<ControlReply>): Promise<SpawnAcceptance> {
    // These four refuse before anything is accepted or allocated, so they state it (SPEC 13.3).
    if (this.config.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal(), undefined, "not-executed");
    const gw = this.parts.goalWriter.goalWriter;
    if (!gw) throw new EpEnvelopeError("unavailable", "the manager goal-writer connection is not standing; spawn-as-action cannot accept (SPEC 13.6)", undefined, "not-executed");
    // Refuse to accept until the boot reconcile of inherited goals completes, so a fresh
    // acceptance never races the sweep (settling a live goal mid-flight would steal its real terminal).
    if (!this.parts.goalWriter.goalReconcileDone)
      throw new EpEnvelopeError("unavailable", "the manager is still reconciling accepted goals at boot; retry shortly (SPEC 13.6)", undefined, "not-executed");
    const goalId = ctx.request.id;
    // Derived from the goal id, as the spawn door named it, so a retried spawn answers the same id.
    const first = (ctx.request.args as { firstCommand?: unknown } | undefined)?.firstCommand !== undefined ? { firstCommand: { id: firstCommandId(goalId) } } : {};
    const { fingerprint } = submissionFingerprint(ctx.request as unknown, ctx.subject);
    const ref = goalRefOf(ctx.subject, goalId);
    const key = goalKey(ref);
    const executor = { lifecycleUid: this.managerInstanceId, epoch: this.parts.servePlane.serviceServe?.grant.epoch ?? 0 };
    const epoch = executor.epoch;
    const acceptedAt = Date.now();

    // Idempotent same-goalId retry (a client re-send): serve the IDENTICAL acceptance without
    // re-running the accept path — so a HARD-PINNED retry does not trip the same-name refuse and no
    // name is re-allocated. Same-incarnation rides the live map; the create-only bindGoal in onAccepted
    // still fences a CONCURRENT same-goalId race (the loser aborts and serves the winner's acceptance).
    const prior = this.parts.goalWriter.goalAcceptances.get(key);
    // A goal that already ENDED is answered from its committed terminal and never accepted again.
    // Running the accept for it allocates a fresh name and identity, then refuses at the index
    // CAS, because the entry its terminal cleared cannot be created twice, and that refusal tells
    // the caller to reconcile the store. A retry that outlived its entry above must not reach it.
    const ended = prior === undefined ? await readGoalResult(gw.ctx, ref) : undefined;
    const accepted = prior ?? ended;
    if (accepted !== undefined) {
      if (accepted.fingerprint !== fingerprint)
        throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" was accepted under a different submission; one goalId never carries two specs (SPEC 13.6)`, undefined, "not-executed");
      return { ...(prior ?? await this.cachedSpawnAcceptance(ref, goalId, fingerprint, executor)), ...first };
    }

    let resolveAccept!: (a: SpawnAcceptance) => void;
    let rejectAccept!: (e: unknown) => void;
    const acceptP = new Promise<SpawnAcceptance>((res, rej) => { resolveAccept = res; rejectAccept = rej; });
    let acceptance: SpawnAcceptance | undefined;
    let readinessTimeoutMs = this.config.readinessTimeoutMs;
    // H1: set the instant the terminal path is ENTERED, not when it succeeds — the post-accept
    // fallback below must fire only when `onOutcome` never ran at all, never as a second attempt
    // behind a commit that threw.
    let terminalEntered = false;
    // TWO DIFFERENT QUESTIONS, DELIBERATELY NOT ONE FLAG.
    //
    //   `terminalEntered`  HAS this goal already been settled (or claimed) by someone?
    //   `ownsGoal`         MAY THIS ATTEMPT settle it at all?
    //
    // The second is the authority, and it is default-CLOSED: an attempt earns it by WINNING the
    // create-only `bindGoal` CAS below, and nothing else grants it. That matters because the
    // post-accept fallback exists to settle a goal nobody answered, so every new way of leaving
    // this function is opted INTO committing a terminal unless something stops it. Deriving the
    // right from the claim instead of from a running record means a losing attempt CANNOT commit
    // down any unwind path, including ones added later that never thought about this. Collapsing
    // the two into one boolean is what let a duplicate-goal loser steal the winner's terminal
    // (#357): it had entered no terminal, so the fallback wrote one for it, using its own abort
    // message as the caller-visible outcome.
    let ownsGoal = false;
    // Set by onEffect. A refusal that arrives with it still false changed nothing.
    let effectStarted = false;
    // Set by onUndone: the host's code for a later refusal that left nothing behind.
    let undone: EpErrorCode | undefined;
    // The task of a once spawn, once accepted.
    let onceRef: GoalRef | undefined;

    // The terminal commits OFF-handler on the goal-writer connection (manager-only authority; a
    // caller cannot publish it). TWO COMPOSED FENCES (defense in depth): (a) reads THIS
    // incarnation's OWN gate epoch and REFUSES a superseded commit (the currency belt), and (b)
    // barrier-revoke evicts this connection on takeover. The terminal lands on the ONE subject
    // SPEC §13.2 (reserved subjects) reserves; first-terminal-fact-wins is global, so a committed outcome is visible
    // to every reader in every incarnation. On success the reconcile-index entry is cleared.
    //
    // Named rather than inlined into the hooks below so the H1 post-accept fallback drives THIS
    // path — one commit site, so the progress event, the index clear and the `agentGoals` cleanup
    // cannot drift between a normal outcome and a recovered one.
    const onOutcome = async (o: Parameters<NonNullable<SpawnHooks["onOutcome"]>>[0]): Promise<boolean> => {
      // THE AUTHORITY CHECK, and the only one. An attempt that never won the bind provisioned
      // nothing and has no outcome to report: the goal belongs to whoever won it, in this
      // incarnation or a sibling. Refusing here rather than at each unwind site is the point --
      // there is exactly one commit path, so this fences every route into it, present and future.
      if (!ownsGoal) return false;
      terminalEntered = true; // entered, not succeeded — see the catch below
      // A once spawn that did not succeed never served its task (delivery opens only with a
      // succeeded verdict), so the task is cancelled now rather than at the seat's exit. A launched
      // seat's debt is still settled by its exit, which proves the seat gone first; a spawn that
      // never launched one owes nothing more.
      if (o.kind !== "succeeded" && onceRef !== undefined) {
        const reason = o.kind === "uncertain" ? "readiness-timeout" : "launch-failed";
        if (this.onceWatched.has(goalKey(onceRef))) void this.commitOnceCancel(onceRef, reason).catch((e: unknown) => console.error(`! once task ${onceRef!.goalId} (${reason}): ${rejectionText(e)}; its seat's exit cancels it`));
        else void this.settleOnceTurn(onceRef, reason);
      }
      try {
        // A held launch releases the Manager operation before the goal's readiness window ends.
        // Its unknown terminal still needs the persisted acceptance's deadline.
        if (o.atReadinessDeadline && acceptance) await delay(Math.max(0, acceptedAt + acceptance.readinessDeadlineMs - Date.now()) + 1, undefined, { ref: false });
        await this.assertGoalWriterEpochCurrent(epoch); // a superseded corpse never commits
        let fact;
        if (o.kind === "succeeded") {
          this.emitGoalProgress(ref, epoch, { phase: "presence" });
          ({ fact } = await commitGoalResult(gw.ctx, { ref, now: Date.now(), cause: "complete", state: "succeeded", data: o.data, committer: { instanceId: this.managerInstanceId, epoch } }));
        } else if (o.kind === "failed") {
          ({ fact } = await commitGoalResult(gw.ctx, { ref, now: Date.now(), cause: "complete", state: "failed", data: o.data, committer: { instanceId: this.managerInstanceId, epoch } }));
        } else {
          // Forward the readiness detail as the terminal's reason: this manager owns the deadline,
          // so it owns what elapsing it MEANS. Absent, core commits its own generic line (#605).
          const { reason: why, running } = (o.data ?? {}) as { reason?: unknown; running?: unknown };
          ({ fact } = await settleGoalUncertain(gw.ctx, { ref, now: Date.now(), committer: { instanceId: this.managerInstanceId, epoch }, ...(typeof why === "string" && why.length > 0 ? { reason: why } : {}), ...(running === true ? { running: true } : {}) }));
        }
        this.expireGoalAcceptance(ref);
        this.emitGoalProgress(ref, epoch, { phase: "terminal", state: fact.state, ...(fact.data !== undefined ? { data: fact.data } : {}) });
        await clearGoalIndex(gw.ctx, ref); // terminal reached - the successor never reconciles it
        if (acceptance) this.agentGoals.delete(acceptance.name); // goal terminal - no cancel path left
        return true;
      } catch (e) {
        // THE NARROWER LEG, LEFT OPEN DELIBERATELY. If the COMMIT ITSELF throws (the currency belt
        // refused a superseded commit, or the broker failed) there is genuinely no terminal, and the
        // H1 fallback must NOT retry it: a retry either loses the same way or overwrites a real
        // supersession refusal with a manufactured outcome. That is why `terminalEntered` is set on
        // ENTRY. This leg is infrastructure-class and converges through the reconcile index at the
        // next boot, which is why the index is NOT cleared above on this path. Do not "close" it
        // here with a retry loop.
        console.error(`! goal terminal commit for ${goalId} failed: ${rejectionText(e)}`);
        return false;
      }
    };

    const bg = run({
      onAccepted: async ({ name, agentTriple }) => {
        // Record the goal in the reconcile index BEFORE the bind (index-CAS-before-bind),
        // so a successor incarnation finds + settles this goal if we crash before its terminal. A
        // crash between this write and the bind leaves an index entry whose goal status is absent —
        // the sweep clears it as a no-goal; a crash before it leaves no entry (never durable). A
        // Carry THIS incarnation's instanceId (the executor coord) so a multi-instance sweep can skip a live sibling's goal.
        //
        // H2, THE ACCEPTANCE FLOOR: the allocated identity is written HERE, before the bind and so
        // before the acceptance is acked, because this entry is the only durable record of it that
        // exists that early — the goal spec does not carry it and the terminal does not exist yet.
        // A same-goalId attempt that loses the bind while the winner is still in flight can then
        // serve what the winner actually allocated instead of inventing an empty identity.
        const idx = await recordGoalIndex(gw.ctx, ref, executor.lifecycleUid, { name, owner: agentTriple.owner, actor: agentTriple.actor, uid: agentTriple.uid, readinessDeadlineMs: readinessTimeoutMs });
        // A create loss is an idempotent retry ONLY for the same incarnation. A FOREIGN iid means a
        // sibling instance accepted this goalId (the live vector is a client retry over ANYCAST, not
        // a journal consumer): this attempt provisions nothing and answers with the winner's floor,
        // or refuses if that instance never persisted one.
        if (!idx.recorded && idx.existing.iid !== executor.lifecycleUid) {
          acceptance = await this.acceptanceFromIndex(idx.existing, ref, goalId, fingerprint, executor);
          resolveAccept(acceptance);
          // No claim needed here: `ownsGoal` is still false, so the commit path refuses this attempt.
          throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" was accepted by instance "${idx.existing.iid}"; that instance's acceptance is served and this attempt provisions nothing (SPEC 13.6)`);
        }
        // Bind AFTER the accept-path checks (name/capacity/persona) + identity mint, BEFORE any provision:
        // a create-only CAS per goalId (a refused accept above left zero bind, zero reserve).
        const b = await bindGoal(gw.ctx, ref, fingerprint);
        if (!b.bound) {
          if (b.existing.fingerprint !== fingerprint)
            throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" is already bound to a different submission; one goalId never carries two specs (SPEC 13.6)`);
          // Lost a concurrent same-goalId race: serve the winner's acceptance and abort THIS provision
          // (no second spawn). The throw unwinds to the finally, which releases this attempt's reserve.
          acceptance = this.parts.goalWriter.goalAcceptances.get(key) ?? await this.cachedSpawnAcceptance(ref, goalId, fingerprint, executor);
          resolveAccept(acceptance);
          // No claim needed here either. This attempt lost the CAS, so `ownsGoal` is still false and
          // the single check in `onOutcome` refuses it. Before that check existed this site had to
          // remember to claim the terminal by hand, and the one place that forgot is how a loser
          // came to commit `failed` on the winner's goal, using its own abort text as the outcome.
          // Unwind the provision (the acceptance is already served); the code is discarded by the
          // caller (acceptance !== undefined), so it just aborts this attempt's side-effects.
          throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" is already accepted; the cached acceptance is served`);
        }
        // WON the claim: this attempt, and only this attempt, may settle this goal.
        ownsGoal = true;
        await createGoal(gw.ctx, ref, {
          fingerprint,
          command: ctx.subject.command,
          caller: { id: `${ctx.subject.caller.owner}.${ctx.subject.caller.actor}`, lifecycleUid: ctx.subject.caller.uid },
          // The ACCEPTING incarnation's epoch: half of the terminal's attribution pair (§13.6).
          acceptedEpoch: epoch,
          requestId: goalId,
          sourceSeq: 0,
          acceptedAt,
          readinessDeadlineMs: readinessTimeoutMs,
        });
        acceptance = { name, owner: agentTriple.owner, actor: agentTriple.actor, uid: agentTriple.uid, goalId, fingerprint, readinessDeadlineMs: readinessTimeoutMs, executor };
        this.parts.goalWriter.goalAcceptances.set(key, acceptance);
        this.agentGoals.set(name, ref); // A despawn of this name mid-goal drives the cancel path
        resolveAccept(acceptance);
        this.emitGoalProgress(ref, epoch, { phase: "handoff" });
      },
      onLaunched: () => this.emitGoalProgress(ref, epoch, { phase: "launched" }),
      onReadinessWindow: (value) => { readinessTimeoutMs = value; },
      onOutcome,
      // Claim the terminal WITHOUT committing one: the despawn/stop that ended this launch owns
      // it and commits `cancel`. This only stops the non-ok reply below from manufacturing a
      // `failed` that would race that `cancel` (first-terminal-fact-wins).
      onTerminalDeferred: () => { terminalEntered = true; },
      onEffect: () => { effectStarted = true; },
      onUndone: (code) => { undone = code; },
      onOnce: async (task) => {
        try {
          const accepted = await this.acceptOnceTurn({ spawnRef: ref, fingerprint, command: ctx.subject.command, executor, acceptedAt, ...task });
          onceRef = accepted.ref;
          return accepted;
        } catch (e) {
          // The spawn goal is already bound, so its refusal is a terminal: nothing has launched.
          await onOutcome({ kind: "failed", data: { error: `the once task was not accepted: ${rejectionText(e)}` } });
          throw e;
        }
      },
    });
    bg.then((reply) => {
      // Refused BEFORE onAccepted (hard-pin collision, capacity, persona-not-found) — no goal bound.
      // Only a refusal before the first effect, or one whose effects were all removed, states
      // `not-executed`; a later one, such as the alias gate that re-drives a teardown, leaves the
      // outcome unknown.
      if (acceptance === undefined) {
        const details = reply.details;
        const code = undone ?? reply.code ?? "failed-precondition";
        rejectAccept(new EpEnvelopeError(code as EpErrorCode, reply.error ?? "spawn refused at accept", details, effectStarted && undone === undefined ? undefined : "not-executed"));
        return;
      }
      // H1: `run` CATCHES its own body (a throw in buildLaunch/runtime.spawn) and RESOLVES `{ok:false}`
      // rather than rejecting, so a post-accept failure arrives here, not in the catch below, and
      // reaches none of the onOutcome sites. Without this the goal stays accepted-but-unanswered:
      // the caller follows epe to a terminal that never comes, and the reconcile index that would
      // settle it is only swept at BOOT, so a manager that stays up never converges it.
      if (reply.ok === false && !terminalEntered)
        return onOutcome({ kind: "failed", data: failedTerminal(reply.error ?? "spawn failed after accept", reply) });
    }).catch((e) => {
      if (acceptance === undefined) { rejectAccept(e); return; }
      // Same obligation for a genuine rejection (one that escaped `run`'s own catch).
      if (!terminalEntered)
        return onOutcome({ kind: "failed", data: failedTerminal(rejectionText(e), caughtEnvelope(e)) });
      console.error(`! spawn-as-action async body for ${goalId}: ${rejectionText(e)}`);
    }).catch((e) => console.error(`! goal terminal fallback for ${goalId}: ${rejectionText(e)}`));
    return acceptP.then((a) => ({ ...a, ...first }));
  }

  /** H2: an acceptance served from a WINNER'S durable acceptance floor (the goal-index entry it
   *  wrote before its own ack). Refuses `unavailable` rather than inventing one — see
   *  {@link cachedSpawnAcceptance} for why an empty identity is never an acceptable answer. */
  private async acceptanceFromIndex(entry: GoalIndexEntry, ref: GoalRef, goalId: string, fingerprint: string, executor: { lifecycleUid: string; epoch: number }): Promise<SpawnAcceptance> {
    if (entry.allocated?.owner === undefined)
      throw new EpEnvelopeError("unavailable", `goal "${goalId}" was accepted by instance "${entry.iid}", which persisted no acceptance floor naming its owner; its allocated identity is not readable from here (SPEC 13.6)`);
    const readinessDeadlineMs = entry.allocated.readinessDeadlineMs ?? (await readGoalSpec(this.parts.goalWriter.goalWriter!.ctx, ref))?.value.readinessDeadlineMs;
    if (readinessDeadlineMs === undefined)
      throw new EpEnvelopeError("unavailable", `goal "${goalId}" is accepted but its readiness deadline is not readable; a synchronous follower cannot bound its wait honestly (SPEC 13.6)`);
    return { name: entry.allocated.name, owner: entry.allocated.owner, actor: entry.allocated.actor, uid: entry.allocated.uid, goalId, fingerprint, readinessDeadlineMs, executor };
  }

  /** Reconstruct a cached acceptance for a same-goalId retry NOT in the live map (a prior incarnation
   *  accepted it, or a concurrent winner whose map write this reader has not yet observed).
   *
   *  H2 — WHY THIS PREFERS THE INDEX OVER THE TERMINAL. It used to read only the committed terminal
   *  and fall back to `{name:"", actor:"", uid:""}` when there was none. That is the common case,
   *  not a corner: a client retry over ANYCAST reaches a sibling while the winner is still
   *  provisioning, so no terminal exists yet, and the caller was handed an ACCEPTED reply naming an
   *  empty agent it can never address. The acceptance floor in the goal index exists from the moment
   *  of acceptance, so it answers precisely the window the terminal cannot. Where neither is
   *  readable the honest answer is a REFUSAL: an accepted goal whose identity nobody can name is
   *  `unavailable` while it runs and its cached outcome once it has ended, never a hollow success. */
  private async cachedSpawnAcceptance(ref: GoalRef, goalId: string, fingerprint: string, executor: { lifecycleUid: string; epoch: number }): Promise<SpawnAcceptance> {
    const entry = await readGoalIndex(this.parts.goalWriter.goalWriter!.ctx, ref);
    if (entry?.allocated !== undefined) return this.acceptanceFromIndex(entry, ref, goalId, fingerprint, executor);
    // The index is CLEARED at terminal, so a settled goal legitimately has no entry: fall back to
    // the terminal's data, which carries the same identity for exactly that case.
    const result = await readGoalResult(this.parts.goalWriter.goalWriter!.ctx, ref);
    const d = (result?.data ?? {}) as { name?: string; id?: string; lifecycleUid?: string };
    const spec = await readGoalSpec(this.parts.goalWriter.goalWriter!.ctx, ref);
    const readinessDeadlineMs = spec?.value.readinessDeadlineMs;
    // The terminal names the agent by its slot id: the `owner.actor` principal in user mode, the
    // bare nkey under DEV_OWNER on a static mesh.
    const principal = typeof d.id !== "string" || d.id.length === 0 ? null : this.userMode ? parsePrincipalKey(d.id) : { owner: DEV_OWNER, actor: d.id };
    if (typeof d.name === "string" && d.name.length > 0 && principal !== null && typeof d.lifecycleUid === "string" && d.lifecycleUid.length > 0 && readinessDeadlineMs !== undefined)
      return { name: d.name, owner: principal.owner, actor: principal.actor, uid: d.lifecycleUid, goalId, fingerprint, readinessDeadlineMs, executor };
    // Only a `succeeded` terminal names the agent. Any other ended goal has its outcome as its
    // whole durable answer, and no retry will make an identity readable (SPEC 13.6 item 5).
    if (result !== undefined) throw goalAlreadyTerminal(goalId, result);
    throw new EpEnvelopeError("unavailable", `goal "${goalId}" is already accepted but its allocated identity is not readable (no acceptance floor, and no terminal carrying one); retry (SPEC 13.6)`);
  }

  /** Drop a goal's acceptance {@link ManagerConfig.goalAcceptanceRetentionMs} after its terminal committed. A
   *  retry after that reads the terminal, so only a goal that has one may be passed here. */
  expireGoalAcceptance(ref: GoalRef): void {
    const key = goalKey(ref);
    setTimeout(() => this.parts.goalWriter.goalAcceptances.delete(key), this.config.goalAcceptanceRetentionMs).unref?.();
  }
}
