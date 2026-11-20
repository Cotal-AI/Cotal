/** A run's seat watch: the checkpoint relay that tells a seat about an escalated pause and
 *  withdraws that relay, and the presence watch that reads whether a seat's incarnation is still
 *  live, superseded or lapsed. The mesh handler composes it; every input, the handler's own
 *  members included, is read through the handler at its use. */
import {
  EpEnvelopeError, IncompleteKvScan, isPresenceRow, liveKvEntries, readGoalIndex, readGoalResult, readGoalSpec, readGoalStatus,
  replyRefusedBeforeEffect, unansweredRequest,
  type ActionContext, type EpAttributedReply, type EpErrorCode, type EpVerbTarget, type GoalRef, type Presence, type ResolvedService,
} from "@cotal-ai/core";
import { EffectError, stepKeyString, type CheckpointRequest, type EffectContext } from "@cotal-ai/lang";
import type { KV } from "@nats-io/kv";
import { delay } from "./delay.js";
import {
  MANAGER_ROUTE_ATTEMPTS, TURN_ACCEPT_DEADLINE_MS, WAIT_POLL_MS, seatDownReading,
} from "./mesh-handler-shared.js";
import type { MeshHandlerBinding, SeatAddress } from "./mesh-handler.js";
import { renderRunContext } from "./run-context.js";

/**
 * How long an incarnation's presence row must stay absent before `turn` and `wait(down)` read it as
 * `lapsed`. A row is gone 6s after its last heartbeat, and a live seat whose connector stalls for
 * longer (host load, a reconnect) comes back under the same lifecycle uid on its next heartbeat. One
 * absent read failed a turn L4002 while the seat went on working (#2344). Five liveness windows lets
 * a stalled seat renew, and stays short against a turn's deadline. A `superseded` read needs no
 * wait: a different incarnation already holds the name. The window is measured from the end of the
 * read that opened it to the start of the read that closes it, over reads {@link lapseWindow} chains.
 */
const LAPSE_CONFIRM_MS = 30_000;
/**
 * The longest span from the start of one presence read to the end of the next across which an
 * absent row still counts as continuously absent: the presence bucket's 6s TTL. A heartbeat keeps
 * the row live at least that long, so a renewal cannot fall between two reads that close. A slower
 * read or a run of failed scans leaves the gap unobserved, and the lapse window starts over.
 */
const PRESENCE_GAP_MS = 6_000;
/** The start of the lapse window after an absent read that ended at `now`: kept when the previous
 *  read began within {@link PRESENCE_GAP_MS}, otherwise this read opens a new one. */
const lapseWindow = (lapsedSince: number | undefined, lastReadAt: number, now: number): number =>
  lapsedSince === undefined || now - lastReadAt > PRESENCE_GAP_MS ? now : lapsedSince;
/** One caller's window across polls of the presence death watch. */
export interface DeathWatch { lapsedSince?: number; lastReadAt?: number }

/** The handler members the moved code calls on itself, so a patched handler member is the one used. */
interface SeatWatchHandler {
  relayEscalation(req: CheckpointRequest, ctx: EffectContext, token: string, deadlineAt: number): Promise<void>;
  relayToSeat(seat: SeatAddress, goalId: string, payload: string, deadlineAt: number, kind: "ask" | "checkpoint", step: string): Promise<void>;
  withdrawRelay(goalId: string): Promise<void>;
  withdrawCancelledRelay(goalId: string, deadlineAt?: number): Promise<void>;
  presenceRows(): Promise<Presence[]>;
  presenceDeath(name: string, uid: string, watch: DeathWatch, decided: () => Promise<boolean>): Promise<"superseded" | "lapsed" | undefined>;
}

/** What the seat watch reads from the handler that composes it, each at its use. */
export interface SeatWatchDeps {
  self(): unknown;
  binding(): MeshHandlerBinding;
  roster(): ReadonlyMap<string, { uid: string; owner?: string; actor?: string; goalId?: string; host?: string }>;
  managerServices(): Map<string, Promise<ResolvedService>>;
  now(): number;
  actionCtx(): Promise<ActionContext>;
  presenceRegistry(): Promise<KV>;
  seatAddress(name: string, uid?: string): { address: SeatAddress; why?: undefined } | { address?: undefined; why: "not-in-roster" | "no-floor" };
  manager(command: string, instanceId?: string): Promise<ResolvedService>;
  invokeManager(service: ResolvedService, command: string, args: Record<string, unknown> | undefined, opts: { target?: EpVerbTarget; deadlineMs?: number; id?: string }): Promise<EpAttributedReply>;
  relayManagerBeforeSubmit(host: string | undefined, command: string, ref: GoalRef, kind: "turn" | "ask" | "checkpoint", label: string): Promise<ResolvedService>;
}

/** The checkpoint relay and presence watch members of a mesh handler, over the handler's own inputs. */
export class SeatWatch {
  constructor(private readonly deps: SeatWatchDeps) {}

  private get handler(): SeatWatchHandler { return this.deps.self() as SeatWatchHandler; }
  private get binding(): MeshHandlerBinding { return this.deps.binding(); }
  private get roster() { return this.deps.roster(); }
  private get managerServices() { return this.deps.managerServices(); }
  private now(): number { return this.deps.now(); }
  private actionCtx(): Promise<ActionContext> { return this.deps.actionCtx(); }
  private presenceRegistry(): Promise<KV> { return this.deps.presenceRegistry(); }
  private seatAddress(name: string, uid?: string) { return this.deps.seatAddress(name, uid); }
  private manager(command: string, instanceId?: string) { return this.deps.manager(command, instanceId); }
  private invokeManager(service: ResolvedService, command: string, args: Record<string, unknown> | undefined, opts: { target?: EpVerbTarget; deadlineMs?: number; id?: string }) {
    return this.deps.invokeManager(service, command, args, opts);
  }
  private relayManagerBeforeSubmit(host: string | undefined, command: string, ref: GoalRef, kind: "turn" | "ask" | "checkpoint", label: string) {
    return this.deps.relayManagerBeforeSubmit(host, command, ref, kind, label);
  }

  /**
   * An escalated checkpoint, delivered to the agent it names.
   *
   * `to` is legal only with `onExpiry: "escalate"` and the escalation is the SECOND mint, so this
   * runs once per chain at most. The addressee is resolved through the run's own roster: a name
   * this run spawned is a seat and is told, and anything else is a person — the pause is
   * answerable from anywhere by design, its addressee is on the entry, and refusing a program
   * that escalates to a human would be this host narrowing an option the reference leaves open.
   *
   * The relay is the ask's, because the two are the same act: one turn on the seat, carrying what
   * is asked and the token to answer under, settling on the checkpoint plane rather than on the
   * relay's own terminal.
   */
  async relayEscalation(req: CheckpointRequest, ctx: EffectContext, token: string, deadlineAt: number): Promise<void> {
    const to = req.to as string;
    const step = stepKeyString(ctx.key);
    // A seat is a roster entry whose acceptance floor was served: that is what carries the
    // owner/actor coordinates a relay is addressed by. Anything else — a name this run never
    // spawned, or one whose floor never landed — is not a seat, and the escalation stays the
    // durable pause it already is, addressed on its entry and answerable from anywhere.
    const seat = this.seatAddress(to);
    if (seat.address === undefined) return;
    const context = renderRunContext({ run: this.binding.runId, step, notices: [] });
    const payload = JSON.stringify({
      run: this.binding.runId, step, context, noticeIds: [],
      checkpoint: { token, prompt: req.prompt, schema: req.schema ?? null, deadlineAt, escalatedTo: to },
    });
    try {
      await this.handler.relayToSeat(seat.address, token, payload, deadlineAt, "checkpoint", step);
    } catch (e) {
      // THE PAUSE OUTLIVES ITS ADDRESSEE. The reference defines no failure for an escalation whose
      // addressee cannot be reached: it "mints exactly one further checkpoint addressed to `to`",
      // and a checkpoint is "a durable pause a human or an agent resolves from anywhere". A seat
      // the endpoint reports gone is therefore the same case as a `to` that names a person: nobody
      // is told, the addressee is on the entry, and anyone may still answer. L4002 is the turn's
      // vocabulary, and this is not a turn the program asked for. Said once, not swallowed.
      if (!(e instanceof EffectError && e.code === "L4002")) throw e;
      console.error(`run ${this.binding.runId}: the escalation at ${step} could not be told to ${to} (${e.message}); the pause stands, answerable from anywhere`);
    }
  }

  /**
   * Submit one relay to a seat as a `turn` goal, and read its acceptance.
   *
   * IDEMPOTENT BY THE GOAL RECORD, which is also the arbiter when the invoke does not come back:
   * a relay that landed and lost its reply is a relay that landed, and re-submitting it would put
   * a second turn on the seat for one request. A seat the serve boundary reports gone is the
   * agent-down failure (L4002); every other refusal is this endpoint's and is uncatchable.
   *
   * The relay carries the pause's own `deadlineAt` and the manager holds it to that instant: a
   * duration counted from the manager's acceptance would outlive the pause by the submit's trip
   * plus skew and show the seat an attempt whose answer is refused. A relay the manager refuses as
   * already past, and that is past on this clock too, has nobody left to tell, because the pause
   * denies at that same instant; the arm that follows meets the passed deadline and decides the
   * outcome.
   */
  async relayToSeat(
    seat: SeatAddress,
    goalId: string,
    payload: string,
    deadlineAt: number,
    kind: "ask" | "checkpoint",
    step: string,
  ): Promise<void> {
    const { name, uid } = seat;
    const ref: GoalRef = { endpoint: this.binding.endpoint, caller: this.binding.caller, goalId };
    const actx = await this.actionCtx();
    if ((await readGoalStatus(actx, ref)) !== undefined) return;
    const service = await this.relayManagerBeforeSubmit(seat.host, "turn", ref, kind, `${kind}(${step})`);
    let reply: EpAttributedReply;
    try {
      reply = await this.invokeManager(service, "turn",
        { payload, deadlineAt }, {
          id: goalId,
          deadlineMs: TURN_ACCEPT_DEADLINE_MS,
          target: { mode: "owner", owner: seat.owner, actor: seat.actor, lifecycleUid: uid },
        });
    } catch (err) {
      // The invoke did not come back — the goal record is the arbiter, exactly as in `turn`.
      if ((await readGoalStatus(actx, ref)) === undefined) throw err;
      return;
    }
    if (reply.reply.ok === false) {
      const err = reply.reply.error;
      if (err.code === "expired")
        throw new EffectError("L4002", kind, `${kind}(${step}): ${name}#${uid} ${seatDownReading(err, seat.host)} before its relay began: ${err.message}`);
      if (err.code === "deadline-exceeded" && this.now() >= deadlineAt) return;
      throw new Error(`${kind}(${step}) was refused by the ${this.binding.endpoint} endpoint: ${err.message}`);
    }
  }

  /**
   * Withdraw the relay a cancelled step sent to a seat, through the manager's reserved `cancel`
   * (SPEC 13.6 item 4), so the seat is not shown it again. A token no relay rode has no goal and
   * nothing to withdraw, and a relay that already ended is the outcome either way: the manager
   * refuses it with the cached terminal, so a repeated withdrawal is a no-op. Any other refusal
   * throws under the code it was refused with, which leaves a discharge open to retry.
   *
   * Only the manager that accepted the relay holds it, and the class rail reaches any member, so a
   * refusal is final only from the accepter its index entry names. One from another member is
   * re-issued on the class rail, as the spawn discharge's despawn is.
   */
  async withdrawRelay(goalId: string): Promise<void> {
    const ref: GoalRef = { endpoint: this.binding.endpoint, caller: this.binding.caller, goalId };
    const actx = await this.actionCtx();
    if ((await readGoalStatus(actx, ref)) === undefined) return;
    const accepter = (await readGoalIndex(actx, ref))?.iid;
    for (let attempt = 0; ; attempt += 1) {
      const reply = await this.invokeManager(await this.manager("cancel"), "cancel", { goalId }, { deadlineMs: TURN_ACCEPT_DEADLINE_MS });
      if (reply.reply.ok !== false || (await readGoalResult(actx, ref)) !== undefined) return;
      if (accepter === undefined || reply.responder.instanceId === accepter) {
        const err = reply.reply.error;
        throw new EpEnvelopeError(err.code as EpErrorCode, `the relay "${goalId}" could not be withdrawn from its seat: ${err.message}`);
      }
      if (attempt === MANAGER_ROUTE_ATTEMPTS)
        throw new Error(`the relay "${goalId}" was accepted by manager instance ${accepter}, but none of ${attempt + 1} cancels was answered by it; the discharge stays open to retry`);
      this.managerServices.delete("cancel");
    }
  }

  /**
   * Withdraw a cancelled step's relay before the cancellation leaves the step, so the scope it
   * settles shows the seat nothing the run withdrew. A withdrawal that fails is tried again rather
   * than left to the discharge, which runs only when the run ends: until then the relay would stay
   * first on the seat and hold back the run's next turn to it. The retries stop when the relay's
   * deadline passes, because the manager no longer serves it then, and a failure that outlasts it
   * is the step's error. A refusal no retry can change is the step's error at once, since retrying
   * it would only hold the cancelled step in its scope until that deadline: of the refusals, only
   * `unavailable` (a manager still reconciling at boot) and `deadline-exceeded` (a lost reply) are
   * tried again.
   *
   * That deadline is read from the relay's goal, where the accepting manager recorded the instant
   * it stops serving the relay; a withdrawal holds only the goal id. No deadline is known until that
   * goal is read, and the relay may be served until then, so a failed read is tried again as well.
   * A goal record that can never yield a deadline is thrown.
   */
  async withdrawCancelledRelay(goalId: string, deadlineAt?: number): Promise<void> {
    for (;;) {
      try {
        if (deadlineAt === undefined) {
          const spec = (await readGoalSpec(await this.actionCtx(), { endpoint: this.binding.endpoint, caller: this.binding.caller, goalId }))?.value;
          if (spec === undefined) return;
          if (spec.readinessDeadlineMs === undefined)
            throw new EpEnvelopeError("internal", `the relay "${goalId}" was accepted with no deadline on its goal; a garbled acceptance never authorizes (SPEC 13.6)`);
          deadlineAt = spec.acceptedAt + spec.readinessDeadlineMs;
        }
        return await this.handler.withdrawRelay(goalId);
      } catch (e) {
        const final = e instanceof EpEnvelopeError && e.code !== "unavailable" && e.code !== "deadline-exceeded";
        if (deadlineAt === undefined ? e instanceof EpEnvelopeError : final || this.now() >= deadlineAt) throw e;
      }
      await delay(WAIT_POLL_MS);
    }
  }

  /** Every live presence row {@link isPresenceRow} accepts under its KV key. Foreign bytes in
   *  the bucket are skipped — a peer's malformed self-publish must not break another agent's name
   *  resolution — and what an ABSENT row means belongs to the caller: `resolveMemberPrincipal`
   *  refuses the join loudly, and `waitDown` reads it as the death it is waiting for. */
  async presenceRows(): Promise<Presence[]> {
    const rows: Presence[] = [];
    for (const e of await liveKvEntries(await this.presenceRegistry())) {
      let row: unknown;
      try {
        row = e.json<unknown>();
      } catch {
        continue;
      }
      if (isPresenceRow(row, e.key)) rows.push(row);
    }
    return rows;
  }

  /** One poll of the presence death watch `wait(down)` and `turn` share. `undefined` means this
   *  incarnation is still live, or a lapse has not yet stood for {@link LAPSE_CONFIRM_MS}. A missing
   *  incarnation is `"superseded"` when a live row holds the name and `"lapsed"` when nothing does.
   *  `watch` is the caller's own window, written here and read on the next poll. An incomplete scan
   *  decides nothing and returns `undefined`; every other read failure is raised. */
  async presenceDeath(
    name: string,
    uid: string,
    watch: DeathWatch,
    decided: () => Promise<boolean>,
  ): Promise<"superseded" | "lapsed" | undefined> {
    let rows: readonly Presence[];
    const readAt = this.now();
    try {
      rows = await this.handler.presenceRows();
    } catch (e) {
      // `liveKvEntries` REFUSES a pass cut short mid-scan instead of returning a partial view —
      // and a partial view is exactly what must not decide a death. Its own contract says retry,
      // so the next poll is the retry; a link that stays down keeps surfacing here rather than
      // as a false DOWN, and the caller's deadline still ends the wait.
      if (e instanceof IncompleteKvScan) return undefined;
      throw e;
    }
    if (!rows.some((p) => p.card.name === name && p.lifecycleUid === uid)) {
      const reason = rows.some((p) => p.card.name === name) ? "superseded" : "lapsed";
      watch.lapsedSince = lapseWindow(watch.lapsedSince, watch.lastReadAt ?? 0, this.now());
      if (reason === "superseded" || readAt - watch.lapsedSince >= LAPSE_CONFIRM_MS) {
        if (reason === "lapsed" && !(await this.lapseStands(name, uid, decided))) watch.lapsedSince = undefined;
        else {
          watch.lastReadAt = readAt;
          return reason;
        }
      }
    } else watch.lapsedSince = undefined;
    watch.lastReadAt = readAt;
    return undefined;
  }

  /** Whether a lapse of `name#uid` confirmed from presence stands as the death, asked of the manager
   *  first. A lapse is only the seat's heartbeats going quiet: on a loaded host a live seat's presence
   *  writer stalls past {@link LAPSE_CONFIRM_MS} while its process goes on working (#2807), and the
   *  manager owns that process. Only the manager holding the seat has a running row under its
   *  incarnation, so that row keeps it alive whoever reports it. A miss decides only from the manager
   *  that allocated it, the committer of its spawn terminal: another member of the class rail knows
   *  only its own seats, so the class rail is asked again, as a spawn's discharge asks it. An allocator
   *  that does not answer leaves presence as the only witness, which is the case presence is the
   *  authority for: the manager died with the seat. The asking can outlast the caller's own
   *  cancellation, deadline or terminal, so once `decided` holds nothing stands and no refusal is
   *  raised: that authority decides at the caller's next check. */
  private async lapseStands(name: string, uid: string, decided: () => Promise<boolean>): Promise<boolean> {
    const entry = this.roster.get(name);
    const spawned = entry?.uid === uid && entry.goalId !== undefined
      ? await readGoalResult(await this.actionCtx(), { endpoint: this.binding.endpoint, caller: this.binding.caller, goalId: entry.goalId })
      : undefined;
    const allocator = spawned?.committer?.instanceId;
    for (let attempt = 0; attempt <= MANAGER_ROUTE_ATTEMPTS; attempt += 1) {
      if (await decided()) return false;
      let answer: EpAttributedReply;
      try {
        answer = await this.invokeManager(await this.manager("inspect"), "inspect", { name }, {});
      } catch (e) {
        if (unansweredRequest(e)) break;
        if (await decided()) return false;
        throw e;
      }
      const { reply, responder } = answer;
      const row = reply.ok ? reply.data as { lifecycleUid?: unknown; status?: unknown } : undefined;
      if (row?.lifecycleUid === uid && row.status === "running") return false;
      if (responder.instanceId === allocator && !replyRefusedBeforeEffect(reply.error)) {
        if (reply.ok || reply.error?.code === "not-found") break;
        if (await decided()) return false;
        throw new Error(`inspect(${name}) was refused by manager instance ${allocator}, which allocated ${name}#${uid}: ${reply.error?.message ?? "refused with no message"}`);
      }
      this.managerServices.delete("inspect");
    }
    return !(await decided());
  }
}
