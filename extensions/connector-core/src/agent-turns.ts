/** A mesh agent's run turns: the native participation lease, the launching manager's turn relay
 *  and the pull that reconciles against it, surfacing pending turns to the seat, once-task claims
 *  and their unconfirmed reports, and the yield that settles a turn. The mesh agent keeps the turn
 *  state a suite reaches into, and one forwarder per member called from outside the family. */
import {
  assertLifecycleToken,
  type EpCaller,
  type ControlReply,
  turnNoticeFilter,
  renderOnceTask,
} from "@cotal-ai/core";
import { TURN_PULL_RETRY_MS } from "./turn-poll.js";
import {
  ONCE_HANDOFF_MS,
  confirmOnceHandoff,
  endOnceHandoff,
  exitOnceSeat,
  onOnceHandoffTimeout,
  onceHandoffState,
  sealOnceHandoff,
  stopOnceHandoffTimer,
} from "./once.js";
import type { MeshAgent, NativeTurnParticipationLease } from "./agent.js";

/** How many settled turns one session remembers. The manager serves a seat one turn at a time, so
 *  a short memory covers every late yield. */
const MAX_SETTLED_TURNS = 32;

/** A turn that left this seat: the run settled it (its deadline, or its manager for a once task),
 *  or this seat yielded it. */
export type SettledTurn = { deadlineAt?: number; once?: true; yielded?: "done" | "blocked" | "handoff" };

/** The refusal for a yield on a turn that already settled, so a seat that was shown the turn
 *  learns why the run will not take this result instead of being told no turn exists. */
function settledTurnError(goalId: string, t: { deadlineAt?: number; once?: unknown; yielded?: SettledTurn["yielded"] }): string {
  if (t.yielded !== undefined)
    return `turn "${goalId}" was already yielded ${t.yielded} by this seat${t.yielded === "done" ? " (ending a session turn yields done)" : ""}, so this yield was not recorded`;
  const deadline = t.deadlineAt !== undefined ? ` (deadline ${new Date(t.deadlineAt).toISOString()})` : "";
  return `turn "${goalId}" was already settled ${t.once !== undefined ? "by its manager" : "by the run"}${deadline}, so this yield was not recorded`;
}

/** One relayed run turn this seat has pulled and not yet yielded. `surfaced` flips when the
 *  payload has been handed to the host session as context — only a surfaced turn auto-yields
 *  `done` at the turn boundary (an unseen payload was never worked on). */
export interface ActiveTurn {
  goalId: string;
  payload: string;
  acceptedAt: number;
  /** Absent only on a `once` task with no deadline, which never expires. */
  deadlineAt?: number;
  /** Set on this seat's `once` task, which the manager marks on its row: it is handed to the
   *  harness at most once (see once.ts), and `spawner` is who it came from. */
  once?: { spawner?: string };
  surfaced: boolean;
}

/** Largest epoch-ms a `Date` can hold; past it `toISOString()` throws. */
const MAX_DATE_MS = 8.64e15;

/** A `turn-pending` row as the manager contract declares it, with a deadline a `Date` can format.
 *  Only a once task's row may omit its deadline. */
function isPendingTurn(t: unknown): t is { goalId: string; payload: string; acceptedAt: number; deadlineAt?: number; once?: true } {
  const r = t as { goalId?: unknown; payload?: unknown; acceptedAt?: unknown; deadlineAt?: unknown; once?: unknown } | null;
  if (typeof r !== "object" || r === null || typeof r.goalId !== "string" || typeof r.payload !== "string") return false;
  if (!Number.isSafeInteger(r.acceptedAt) || (r.acceptedAt as number) < 0) return false;
  if (r.once !== undefined && r.once !== true) return false;
  if (r.deadlineAt === undefined) return r.once === true;
  return Number.isSafeInteger(r.deadlineAt) && (r.deadlineAt as number) >= 1 && (r.deadlineAt as number) <= MAX_DATE_MS;
}

/** Who a once task came from, as the manager wrote it beside the prompt. */
function onceSpawner(payload: string): string | undefined {
  try {
    const spawner = (JSON.parse(payload) as { once?: { spawner?: unknown } }).once?.spawner;
    return typeof spawner === "string" && spawner.length > 0 ? spawner : undefined;
  } catch { return undefined; }
}

/** An `ask` relayed as a turn: the record the run needs, the attempt it is on, the previous
 *  refusal when there was one, and the native command that answers it (the same door
 *  a checkpoint is answered through). Empty when the payload carries no ask. */
function renderAskRequest(p: { run?: unknown; step?: unknown; ask?: unknown; checkpoint?: unknown }): string {
  const escalation = renderEscalation(p);
  if (escalation !== "") return escalation;
  const ask = p.ask;
  if (ask === null || typeof ask !== "object") return "";
  const a = ask as { schema?: unknown; attempt?: unknown; attempts?: unknown; deadlineAt?: unknown; refused?: unknown };
  const entries = a.schema !== null && typeof a.schema === "object" ? Object.entries(a.schema as Record<string, unknown>) : [];
  const fields = entries.length === 0 ? "any record" : entries.map(([k, v]) => `${k}: ${String(v)}`).join(", ");
  const by = typeof a.deadlineAt === "number" ? `, by ${new Date(a.deadlineAt).toISOString()}` : "";
  const refused = typeof a.refused === "string" ? `\nYour last answer was refused: ${a.refused}` : "";
  return `\nThis turn is an ask: the run needs a record from you at step ${String(p.step)} with fields ${fields}`
    + ` (attempt ${String(a.attempt)} of ${String(a.attempts)}${by}).${refused}`
    + renderPauseAnswer(p, "<json record>");
}

/** The seat's native connection holds its identity even when its shell has no mesh environment. */
function renderPauseAnswer(p: { run?: unknown; step?: unknown }, value: string): string {
  return `\nAnswer through your native Cotal tools: call cotal_describe for endpoint "manager", then cotal_invoke`
    + ` with endpoint="manager", command="run-answer", self=true and args=`
    + `{"runId":${JSON.stringify(p.run)},"stepKey":${JSON.stringify(p.step)},"value":${value}}.`
    + `\nReplace ${value} with your answer. This route uses your own seat identity and needs no run grant or run-status read.`
    + ` Do not use cotal_yield to answer this request: yielding or ending your host turn submits no value and can withdraw your answer authorization.`;
}

/** An escalated `checkpoint` relayed as a turn: the question, the record wanted when the pause
 *  carries a schema, and the same answer command an ask uses. The runtime submitted this shape from
 *  the day escalations were relayed, and the seat read `ask` alone: the addressee was woken with a
 *  context block and no question, auto-yielded `done`, and the pause ran to its own expiry. */
function renderEscalation(p: { run?: unknown; step?: unknown; checkpoint?: unknown }): string {
  const cp = p.checkpoint;
  if (cp === null || typeof cp !== "object") return "";
  const c = cp as { prompt?: unknown; schema?: unknown; deadlineAt?: unknown };
  const entries = c.schema !== null && typeof c.schema === "object" ? Object.entries(c.schema as Record<string, unknown>) : [];
  const wanted = entries.length === 0 ? "" : `\nAnswer with a record with fields ${entries.map(([k, v]) => `${k}: ${String(v)}`).join(", ")}.`;
  const by = typeof c.deadlineAt === "number" ? ` It expires at ${new Date(c.deadlineAt).toISOString()}.` : "";
  return `\nThis turn is a checkpoint escalated to you at step ${String(p.step)}: ${String(c.prompt)}${by}${wanted}`
    + `\nAnswer with: \`cotal run answer ${String(p.run)} ${String(p.step)} --value '<json>'\``;
}

/** What {@link AgentTurns} reads from the MeshAgent. Every entry is read at use, so a field the handler
 *  assigns after construction is always current, and a handler method a suite replaces is the one that runs. */
export interface AgentTurnsDeps {
  _connected: () => MeshAgent["_connected"];
  _stopping: () => MeshAgent["_stopping"];
  activeTurns: () => MeshAgent["activeTurns"];
  claimTurns: (...args: Parameters<MeshAgent["claimTurns"]>) => ReturnType<MeshAgent["claimTurns"]>;
  config: () => MeshAgent["config"];
  ep: () => MeshAgent["ep"];
  hasTurnRelay: (...args: Parameters<MeshAgent["hasTurnRelay"]>) => ReturnType<MeshAgent["hasTurnRelay"]>;
  legacyTurnPoll: () => MeshAgent["legacyTurnPoll"];
  setLegacyTurnPoll: (value: MeshAgent["legacyTurnPoll"]) => void;
  log: (...args: Parameters<MeshAgent["log"]>) => ReturnType<MeshAgent["log"]>;
  managerInvoke: (...args: Parameters<MeshAgent["managerInvoke"]>) => ReturnType<MeshAgent["managerInvoke"]>;
  nativeTurnLease: () => MeshAgent["nativeTurnLease"];
  setNativeTurnLease: (value: MeshAgent["nativeTurnLease"]) => void;
  options: () => MeshAgent["options"];
  requestWake: (...args: Parameters<MeshAgent["requestWake"]>) => ReturnType<MeshAgent["requestWake"]>;
  requireConnected: (...args: Parameters<MeshAgent["requireConnected"]>) => ReturnType<MeshAgent["requireConnected"]>;
  settledTurns: () => MeshAgent["settledTurns"];
  turnNoticeArmed: () => MeshAgent["turnNoticeArmed"];
  setTurnNoticeArmed: (value: MeshAgent["turnNoticeArmed"]) => void;
  turnPollBusy: () => MeshAgent["turnPollBusy"];
  setTurnPollBusy: (value: MeshAgent["turnPollBusy"]) => void;
  turnRetryTimer: () => MeshAgent["turnRetryTimer"];
  setTurnRetryTimer: (value: MeshAgent["turnRetryTimer"]) => void;
}

/** The turn members of a mesh agent, over the agent's own inputs. */
export class AgentTurns {
  constructor(private readonly deps: AgentTurnsDeps) {}

  // The MeshAgent members these bodies read, under their agent names. Each reads through its dep at
  // use, so a field the agent assigns later is current and a method a suite replaces on the agent
  // is the one that runs.
  private get _connected() { return this.deps._connected(); }
  private get _stopping() { return this.deps._stopping(); }
  private get activeTurns() { return this.deps.activeTurns(); }
  private claimTurns(...args: Parameters<MeshAgent["claimTurns"]>): ReturnType<MeshAgent["claimTurns"]> { return this.deps.claimTurns(...args); }
  private get config() { return this.deps.config(); }
  private get ep() { return this.deps.ep(); }
  private hasTurnRelay(...args: Parameters<MeshAgent["hasTurnRelay"]>): ReturnType<MeshAgent["hasTurnRelay"]> { return this.deps.hasTurnRelay(...args); }
  private get legacyTurnPoll() { return this.deps.legacyTurnPoll(); }
  private set legacyTurnPoll(value: MeshAgent["legacyTurnPoll"]) { this.deps.setLegacyTurnPoll(value); }
  private log(...args: Parameters<MeshAgent["log"]>): ReturnType<MeshAgent["log"]> { return this.deps.log(...args); }
  private managerInvoke(...args: Parameters<MeshAgent["managerInvoke"]>): ReturnType<MeshAgent["managerInvoke"]> { return this.deps.managerInvoke(...args); }
  private get nativeTurnLease() { return this.deps.nativeTurnLease(); }
  private set nativeTurnLease(value: MeshAgent["nativeTurnLease"]) { this.deps.setNativeTurnLease(value); }
  private get options() { return this.deps.options(); }
  private requestWake(...args: Parameters<MeshAgent["requestWake"]>): ReturnType<MeshAgent["requestWake"]> { return this.deps.requestWake(...args); }
  private requireConnected(...args: Parameters<MeshAgent["requireConnected"]>): ReturnType<MeshAgent["requireConnected"]> { return this.deps.requireConnected(...args); }
  private get settledTurns() { return this.deps.settledTurns(); }
  private get turnNoticeArmed() { return this.deps.turnNoticeArmed(); }
  private set turnNoticeArmed(value: MeshAgent["turnNoticeArmed"]) { this.deps.setTurnNoticeArmed(value); }
  private get turnPollBusy() { return this.deps.turnPollBusy(); }
  private set turnPollBusy(value: MeshAgent["turnPollBusy"]) { this.deps.setTurnPollBusy(value); }
  private get turnRetryTimer() { return this.deps.turnRetryTimer(); }
  private set turnRetryTimer(value: MeshAgent["turnRetryTimer"]) { this.deps.setTurnRetryTimer(value); }
  /** Goals whose yield the manager answered since the current pull began. That pull may have
   *  snapshotted a goal before its answer; taking it back would surface the settled turn again, and
   *  the next pull would record it as the run's settlement. */
  private yieldedSincePull = new Set<string>();
  /** The last pull failure this seat reported, so one that keeps failing is said once. */
  private pullTrouble?: string;
  /** A notice or reconnect arrived while a pull was in flight, so one more pull follows it. */
  private turnPullAgain = false;

  private turnRelayAuthorized(): boolean {
    return this.config.turnRelay !== false || this.nativeTurnLeaseValid();
  }

  /** Arm or renew native personal participation. This grants only the existing self-addressed turn
   * pull/yield path. It does not make the connection a managed seat or grant stop/attach custody. */
  authorizeNativeTurnParticipation(lease: NativeTurnParticipationLease): void {
    const principal = this.ep.principal;
    const lifecycleUid = this.config.lifecycleUid;
    if (lease.owner !== principal.owner || lease.actor !== principal.actor || lease.lifecycleUid !== lifecycleUid ||
        lease.name !== this.config.name)
      throw new Error("the participation lease does not bind this connection's exact owner, actor, lifecycle and name");
    const managerInstanceId = assertLifecycleToken(lease.managerInstanceId, "participation manager instance");
    if (!Number.isFinite(lease.expiresAt) || lease.expiresAt <= Date.now())
      throw new Error("the participation lease is expired");
    if (this.nativeTurnLease && this.nativeTurnLease.managerInstanceId !== managerInstanceId)
      throw new Error("a participation renewal cannot change the launching manager instance");
    this.nativeTurnLease = { ...lease, managerInstanceId };
    this.config.managerInstanceId = managerInstanceId;
    if (this._connected) this.armTurnRelay();
  }

  /** Ask this identity's selected manager for a finite self-only participation lease, validate the
   * returned binding locally, then arm the existing turn relay. */
  async participateInTurns(): Promise<NativeTurnParticipationLease> {
    await this.requireConnected();
    if (this.config.turnRelay !== false)
      throw new Error("turn participation is already managed by this seat's launcher");
    const reply = await this.managerInvoke("turn-participate", undefined, { target: { mode: "self" } });
    if (!reply.ok) throw new Error(reply.error ?? "the manager refused workflow turn participation");
    const data = reply.data as Partial<NativeTurnParticipationLease> | undefined;
    if (!data || typeof data.owner !== "string" || typeof data.actor !== "string" ||
        typeof data.lifecycleUid !== "string" || typeof data.name !== "string" ||
        typeof data.managerInstanceId !== "string" || typeof data.expiresAt !== "number")
      throw new Error("turn-participate returned an invalid participation lease");
    const lease = data as NativeTurnParticipationLease;
    if (!reply.instanceId || lease.managerInstanceId !== reply.instanceId)
      throw new Error("turn-participate lease does not bind the manager instance that answered");
    this.authorizeNativeTurnParticipation(lease);
    // authorizeNativeTurnParticipation may see the relay already armed. A renewal is also the
    // explicit recovery path after a lost notice, so it always asks for the current self snapshot.
    this.requestTurnPull();
    return lease;
  }

  nativeTurnParticipationExpiresAt(): number | undefined {
    return this.nativeTurnLeaseValid() ? this.nativeTurnLease!.expiresAt : undefined;
  }

  /** Number of currently held workflow turns, surfaced or not. Read-only diagnostics for native
   * ingress and acceptance tests; the manager's next pull remains the settlement authority. */
  activeTurnCount(): number {
    return this.activeTurns.size;
  }

  nativeTurnLeaseValid(): boolean {
    return this.nativeTurnLease !== undefined && this.nativeTurnLease.expiresAt > Date.now();
  }

  /** Subscribe to the launching manager's turn notices (SPEC 14.3) and pull once. The manager
   *  publishes a notice whenever this seat's `turn-pending` answer changes, and repeats it until
   *  the seat pulls a new turn, so an idle seat sends nothing, across reconnects too. The pull on a
   *  notice, here at the first bind, and on a reconnect while the seat holds a turn is the only
   *  intake; the subscription exists before the first pull, so a turn accepted in between is not missed. */
  armTurnRelay(): void {
    if (!this.hasTurnRelay()) return;
    // A once task whose dispatch outlived its bound is sealed and reported by this seat's newest
    // MeshAgent, which is the one connected.
    onOnceHandoffTimeout((uid, goalId) => {
      if (uid === this.onceUid() && sealOnceHandoff(uid, goalId)) void this.reportUnconfirmed(goalId);
    });
    if (!this.turnNoticeArmed) {
      let caller: EpCaller;
      try { caller = this.ep.serviceRailCaller(); }
      catch (e) { this.log(`the run-turn relay cannot name this seat's reply rail (${(e as Error).message}); no turn will reach this seat`); return; }
      this.ep.tap(() => this.requestTurnPull(), { subject: turnNoticeFilter(this.config.space, this.config.managerInstanceId!, caller) });
      this.turnNoticeArmed = true;
    }
    this.requestTurnPull();
  }

  /** Pull now, or once more after the pull in flight, so notices that arrive together cost one pull. */
  requestTurnPull(): void {
    if (!this.turnRelayAuthorized() || this._stopping) return;
    if (this.turnPollBusy) { this.turnPullAgain = true; return; }
    void this.pollTurns().catch((e: unknown) => this.turnPullFailed((e as Error).message, undefined));
  }

  /** Pull this seat's pending run turns from its launching manager (`turn-pending`, self-mode).
   *  New turns request a wake so the payload surfaces on the next injectable frame; turns gone from
   *  the reply were settled elsewhere (deadline, agent-down, a competing yield path) and are
   *  dropped. Only a manager-launched seat (`hasTurnRelay`) pulls; any failure to reach the
   *  launching manager is passed to {@link turnPullFailed}. */
  async pollTurns(): Promise<void> {
    if (!this.turnRelayAuthorized() || !this._connected || this._stopping || this.turnPollBusy) return;
    this.turnPollBusy = true;
    this.turnPullAgain = false;
    this.yieldedSincePull.clear();
    try {
      const r = await this.managerInvoke("turn-pending", undefined, { target: { mode: "self" } });
      if (!r.ok) { this.turnPullFailed(r.error ?? "refused with no message", r.code); return; }
      const rows = (r.data as { turns?: unknown } | undefined)?.turns;
      // A reply with no turns array is no snapshot: reconciling on it would drop every accepted
      // turn, including one already shown. Keep what the seat holds until a well-formed pull.
      if (!Array.isArray(rows)) { this.turnPullFailed("turn-pending returned no turns array", "bad-reply"); return; }
      if (this.turnRetryTimer !== undefined) { clearTimeout(this.turnRetryTimer); this.turnRetryTimer = undefined; }
      this.noteTurnNotices((r.data as { notices?: unknown }).notices === true);
      // A responder off the contract must not reach the formatter: one row with no numeric
      // deadline made peekPendingTurns throw on every frame.
      const turns = rows.filter(isPendingTurn);
      if (turns.length < rows.length) this.notePullTrouble(`turn-pending returned ${rows.length - turns.length} malformed turn(s), dropped`);
      else this.pullTrouble = undefined;
      const live = new Set(turns.map((t) => t.goalId));
      for (const t of [...this.activeTurns.values()]) if (!live.has(t.goalId)) this.settleTurn(t);
      let fresh = 0;
      for (const t of turns) {
        if (this.activeTurns.has(t.goalId) || this.yieldedSincePull.has(t.goalId)) continue;
        // A once task this process already handed over stays handed over: a rebuilt MeshAgent
        // finds its state in the process registry and neither offers it again nor loses its yield.
        const once = t.once ? { spawner: onceSpawner(t.payload) } : undefined;
        const surfaced = once !== undefined && onceHandoffState(this.onceUid(), t.goalId) === "confirmed";
        this.activeTurns.set(t.goalId, { goalId: t.goalId, payload: t.payload, acceptedAt: t.acceptedAt, ...(t.deadlineAt !== undefined ? { deadlineAt: t.deadlineAt } : {}), ...(once ? { once } : {}), surfaced });
        if (!surfaced) fresh += 1;
        if (once !== undefined && !surfaced && this.options.onceClaimBound) this.boundOnceClaim(t.goalId);
      }
      if (fresh > 0) this.requestWake();
      // A manager that does not hold this once seat, and has settled its task, tells it to end itself.
      if ((r.data as { stop?: unknown }).stop === true) {
        this.log("the manager does not hold this once seat and its task has ended; ending this seat");
        void exitOnceSeat();
      }
    } finally {
      this.turnPollBusy = false;
      if (this.turnPullAgain) this.requestTurnPull();
    }
  }

  /** Follow what the launching manager says about turn notices. A manager from before them never
   *  sends one, so this seat pulls on a timer while its answers say so, and says that once. */
  private noteTurnNotices(sent: boolean): void {
    if (sent) {
      if (this.legacyTurnPoll !== undefined) { clearInterval(this.legacyTurnPoll); this.legacyTurnPoll = undefined; }
      return;
    }
    if (this.legacyTurnPoll !== undefined || this._stopping) return;
    this.log(`manager ${this.config.managerInstanceId} sends no turn notices (it predates them), so this seat pulls its turns every ${TURN_PULL_RETRY_MS}ms`);
    const t = setInterval(() => this.requestTurnPull(), TURN_PULL_RETRY_MS);
    (t as { unref?: () => void }).unref?.();
    this.legacyTurnPoll = t;
  }

  /** A pull failed. A manager that is down, still reconciling or unanswered can recover, so ONE
   *  retry is armed for {@link TURN_PULL_RETRY_MS} later and re-armed while that keeps failing. A
   *  refusal (a denied capability, a request the manager rejects) is reported and not retried:
   *  asking again on a timer would be the idle poll this relay removed, against a door that is shut.
   *  The next notice or reconnect pulls again either way. */
  private turnPullFailed(reason: string, code: string | undefined): void {
    this.notePullTrouble(reason);
    const transient = code === undefined || code === "unavailable" || code === "deadline-exceeded";
    if (!transient || this._stopping || this.turnRetryTimer !== undefined) return;
    const t = setTimeout(() => { this.turnRetryTimer = undefined; this.requestTurnPull(); }, TURN_PULL_RETRY_MS);
    (t as { unref?: () => void }).unref?.();
    this.turnRetryTimer = t;
  }

  /**
   * A pull that did not come back, said ONCE.
   *
   * Only a manager-launched seat pulls (`hasTurnRelay`), so an unanswered pull means its own
   * launching manager did not answer. Each distinct reason is reported once and saying it again
   * waits for the reason to change or for a pull to succeed. Only the manager's startup
   * reconciliation window (`still reconciling`) stays silent because it resolves itself.
   */
  private notePullTrouble(reason: string): void {
    // The boot window is a manager telling the seat to come back once startup reconciliation finishes.
    if (/still reconciling/i.test(reason)) return;
    if (this.pullTrouble === reason) return;
    this.pullTrouble = reason;
    this.log(`the run-turn pull is not answering (${reason}); the seat pulls again on its next turn notice or reconnect`);
  }

  /** Format every not-yet-surfaced turn still inside its deadline as an injectable context block,
   *  WITHOUT marking anything (undefined when none wait). Two-phase on purpose, like the inbox's
   *  format-then-verdict rail: marking at format time would let a lost frame auto-yield `done` for
   *  work the model never saw. A caller commits with {@link commitSurfacedTurns} only once the
   *  injection verifiably reached the host. The payload is opaque relay bytes; when it parses as
   *  JSON with a string `context`, that rendered context is what the model reads, else the raw
   *  payload is shown. */
  peekPendingTurns(): { text: string; goalIds: string[]; once?: true } | undefined {
    if (this.config.turnRelay === false && !this.nativeTurnLeaseValid()) return undefined;
    // A turn past its deadline is already settled at the manager, which refuses its yield, though
    // this cache holds it until the next pull settles it here.
    const now = Date.now();
    const waiting = [...this.activeTurns.values()].filter((t) => !t.surfaced && (t.deadlineAt === undefined || t.deadlineAt > now) && this.offerable(t)).sort((a, b) => a.acceptedAt - b.acceptedAt);
    if (!waiting.length) return undefined;
    // A once seat holds its task and nothing else (the manager refuses it any other turn).
    const once = waiting.find((t) => t.once !== undefined);
    if (once !== undefined) return { text: renderOnceTask({ goalId: once.goalId, payload: once.payload, spawner: once.once?.spawner, deadlineAt: once.deadlineAt }), goalIds: [once.goalId], once: true };
    let asked = false;
    const blocks = waiting.map((t) => {
      let context = t.payload;
      let ask = "";
      try {
        const p = JSON.parse(t.payload) as { run?: unknown; step?: unknown; context?: unknown; ask?: unknown; checkpoint?: unknown };
        if (typeof p.context === "string" && p.context.length > 0) context = p.context;
        ask = renderAskRequest(p);
      } catch { /* opaque payload — surface it as it came */ }
      if (ask !== "") asked = true;
      return `— turn ${t.goalId}${t.deadlineAt !== undefined ? ` (deadline ${new Date(t.deadlineAt).toISOString()})` : ""}:\n${context}${ask}`;
    });
    // The ask sentence only when a block above carries a route: a plain turn NAMED "ask"
    // (`/turn:ask#0`) has none, and a seat told to answer one went looking for a question never sent.
    const text =
      `🎯 Cotal — a run handed you ${waiting.length === 1 ? "its turn" : `${waiting.length} turns`}:\n` +
      `${blocks.join("\n")}\n` +
      `(Do the work now with your own tools. ${asked ? "An ask must be answered through its native route above before ending your host turn. " : ""}` +
      `For ordinary turns, ending your turn yields "done" automatically; call cotal_yield when blocked or handing off an ordinary turn.)`;
    return { text, goalIds: waiting.map((t) => t.goalId) };
  }

  /** Mark peeked turns as surfaced — the second phase, called once their injection verifiably
   *  reached the host. Surfacing is what arms the automatic `done` at the next turn boundary; a
   *  turn never committed re-surfaces on a later frame instead of yielding a lie. */
  commitSurfacedTurns(goalIds: readonly string[]): void {
    if (this.config.turnRelay === false && !this.nativeTurnLeaseValid()) return;
    for (const id of goalIds) {
      const t = this.activeTurns.get(id);
      // A sealed once task is not surfaced: its handoff ended unconfirmed and has been reported.
      if (t?.once !== undefined && !confirmOnceHandoff(this.onceUid(), id)) continue;
      if (t) t.surfaced = true;
    }
  }

  /** Undo {@link commitSurfacedTurns} for run turns whose dispatch the harness refused after
   *  acknowledging it. The model never saw them, so they are offered again rather than yielding
   *  `done` at the next turn boundary. A once task's confirmed handoff is never undone. */
  unsurfaceTurns(goalIds: readonly string[]): void {
    for (const id of goalIds) {
      const t = this.activeTurns.get(id);
      if (t && t.once === undefined) t.surfaced = false;
    }
  }

  /** The adapter gave up on a dispatch that carried these turns. A claimed once task is sealed and
   *  reported to the manager; it is never offered again, because the harness may have it. */
  releaseTurns(goalIds: readonly string[]): void {
    for (const id of goalIds) {
      if (this.activeTurns.get(id)?.once === undefined) continue;
      if (sealOnceHandoff(this.onceUid(), id)) void this.reportUnconfirmed(id);
    }
  }

  /** The dispatch carrying these turns left the seat, and its acceptance arrives with the model's
   *  response: stop the once task's handoff timer, which measures the dispatch only. */
  noteTurnsDispatched(goalIds: readonly string[]): void {
    for (const id of goalIds) if (this.activeTurns.get(id)?.once !== undefined) stopOnceHandoffTimer(this.onceUid(), id);
  }

  /** Seal and report a once task still unclaimed {@link ONCE_HANDOFF_MS} after this seat pulled it. */
  private boundOnceClaim(goalId: string): void {
    const timer = setTimeout(() => {
      if (!this.activeTurns.has(goalId) || onceHandoffState(this.onceUid(), goalId) !== "pending") return;
      this.log(`once task ${goalId}: pulled ${ONCE_HANDOFF_MS}ms ago and never handed to the session; reporting it unconfirmed`);
      if (this.claimTurns([goalId])) this.releaseTurns([goalId]);
    }, ONCE_HANDOFF_MS);
    (timer as { unref?: () => void }).unref?.();
  }

  /** A turn the harness may be handed: any run turn, and a once task whose handoff has not begun. */
  offerable(t: ActiveTurn): boolean {
    return t.once === undefined || onceHandoffState(this.onceUid(), t.goalId) === "pending";
  }

  /** The key a once task's handoff state is kept under in this process. */
  onceUid(): string {
    return this.config.lifecycleUid ?? this.config.name;
  }

  /** Tell the manager a once task's handoff was not confirmed (`turn-unconfirmed`), so it fails the
   *  task and stops this seat. Retried with backoff for one handoff bound while the manager cannot
   *  be reached; any answer that is not transient ends the retry. A report that has not landed by
   *  then ends this seat instead, and the manager's proof of that exit settles the task. A seat that
   *  cannot end itself keeps reporting, at most a minute apart, until a manager answers or this
   *  process ends. */
  private async reportUnconfirmed(goalId: string): Promise<void> {
    const until = Date.now() + ONCE_HANDOFF_MS;
    let delay = 1_000;
    let exitTried = false;
    for (;;) {
      const r = await this.managerInvoke("turn-unconfirmed", { goalId }, { target: { mode: "self" } })
        .catch((e: unknown) => ({ ok: false as const, error: (e as Error).message, code: undefined }));
      const transient = !r.ok && (r.code === undefined || r.code === "unavailable" || r.code === "deadline-exceeded");
      if (!transient) {
        this.log(`once task ${goalId}: its handoff was not confirmed; reported to the manager (${r.ok ? "the task failed" : r.error ?? "refused"})`);
        return;
      }
      if (!exitTried && Date.now() + delay > until) {
        exitTried = true;
        this.log(`once task ${goalId}: its handoff was not confirmed and the manager could not be told; ending this seat so its exit settles the task`);
        if (await exitOnceSeat()) return;
        this.log(`once task ${goalId}: this seat cannot end itself; reporting until a manager answers`);
      }
      if (this._stopping) return;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, exitTried ? 60_000 : 10_000);
    }
  }

  /** Yield one active turn back to the run (`turn-yield`, self-mode). Without `turn` it targets
   *  the OLDEST surfaced turn — the one the current session turn is working on. The entry is
   *  dropped locally only when the manager's answer settles it, by this yield or by a terminal
   *  the run reached first; a refused one stays for the poll to reconcile (the manager's answer,
   *  not a local guess, decides whether it is settled). */
  async yieldTurn(status: "done" | "blocked" | "handoff", opts: { to?: string; note?: string; turn?: string } = {}): Promise<ControlReply> {
    if (this.config.turnRelay === false && !this.nativeTurnLeaseValid())
      return { ok: false, error: "this personal connection has no valid workflow turn participation lease; opt in or renew it first" };
    try {
      await this.requireConnected();
    } catch (error) {
      throw new Error(`${(error as Error).message}. The yield was not sent.`, { cause: error });
    }
    const t = opts.turn !== undefined
      ? this.activeTurns.get(opts.turn)
      : [...this.activeTurns.values()].filter((x) => x.surfaced).sort((a, b) => a.acceptedAt - b.acceptedAt)[0];
    if (!t) {
      const id = opts.turn ?? [...this.settledTurns.keys()].at(-1);
      const settled = id === undefined ? undefined : this.settledTurns.get(id);
      if (id !== undefined && settled !== undefined) return { ok: false, error: settledTurnError(id, settled) };
      return { ok: false, error: opts.turn !== undefined ? `no active turn "${opts.turn}" on this seat` : "no turn is active — nothing to yield" };
    }
    // The surfaced gate holds for an explicit id too: a yield for a payload the session has not
    // been shown would record work nobody did.
    if (!t.surfaced) return { ok: false, error: `turn "${t.goalId}" has not been surfaced into this session yet; nothing was seen, so nothing can be yielded for it` };
    if (status === "handoff" && (opts.to === undefined || opts.to.length === 0))
      return { ok: false, error: "a handoff yield names its addressee (to)" };
    const r = await this.managerInvoke("turn-yield", { goalId: t.goalId, status, to: opts.to, note: opts.note }, { target: { mode: "self" } });
    if (!r.ok) return r;
    this.yieldedSincePull.add(t.goalId);
    // A turn the manager settled between this seat's polls is answered with that terminal's state;
    // only `succeeded` is a yield that landed.
    if ((r.data as { state?: unknown } | undefined)?.state !== "succeeded") {
      this.settleTurn(t);
      return { ok: false, error: settledTurnError(t.goalId, t) };
    }
    this.activeTurns.delete(t.goalId);
    // A poll that ran while this yield was in flight saw the turn gone and took it for the run's
    // settlement; the manager's answer says this yield settled it. Remembering the yield tells a
    // later one, such as a worker's own after its session turn ended, that the turn already settled.
    this.rememberSettled(t.goalId, { yielded: status });
    return r;
  }

  /** Drop an active turn the run settled without this seat's yield, remembering its deadline. */
  private settleTurn(t: ActiveTurn): void {
    // A once task settled without this seat (its deadline, or a stop) ends its handoff too.
    if (t.once !== undefined) endOnceHandoff(this.onceUid(), t.goalId);
    this.activeTurns.delete(t.goalId);
    this.rememberSettled(t.goalId, { ...(t.deadlineAt !== undefined ? { deadlineAt: t.deadlineAt } : {}), ...(t.once !== undefined ? { once: true as const } : {}) });
  }

  /** Record a settled turn as the newest, which a yield naming no turn reports. */
  private rememberSettled(goalId: string, settled: SettledTurn): void {
    this.settledTurns.delete(goalId);
    this.settledTurns.set(goalId, settled);
    if (this.settledTurns.size > MAX_SETTLED_TURNS) this.settledTurns.delete(this.settledTurns.keys().next().value!);
  }
}
