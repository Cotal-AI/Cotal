/** A mesh agent's own presence writes: status with its turn-boundary yield, activity, condition,
 *  model and cwd, each queued on one chain so overlapping calls land in call order. The mesh agent
 *  keeps the status it reports and one forwarder per member called from outside the family. */
import type { PresenceCondition, PresenceStatus } from "@cotal-ai/core";
import type { MeshAgent } from "./agent.js";


/** What {@link AgentPresence} reads from the MeshAgent. Every entry is read at use, so a field the handler
 *  assigns after construction is always current, and a handler method a suite replaces is the one that runs. */
export interface AgentPresenceDeps {
  _status: () => MeshAgent["_status"];
  set_status: (value: MeshAgent["_status"]) => void;
  _stopping: () => MeshAgent["_stopping"];
  activeTurns: () => MeshAgent["activeTurns"];
  config: () => MeshAgent["config"];
  ep: () => MeshAgent["ep"];
  log: (...args: Parameters<MeshAgent["log"]>) => ReturnType<MeshAgent["log"]>;
  requireConnected: (...args: Parameters<MeshAgent["requireConnected"]>) => ReturnType<MeshAgent["requireConnected"]>;
  yieldTurn: (...args: Parameters<MeshAgent["yieldTurn"]>) => ReturnType<MeshAgent["yieldTurn"]>;
}

/** The presence-write members of a mesh agent, over the agent's own inputs. */
export class AgentPresence {
  constructor(private readonly deps: AgentPresenceDeps) {}

  // The MeshAgent members these bodies read, under their agent names. Each reads through its dep at
  // use, so a field the agent assigns later is current and a method a suite replaces on the agent
  // is the one that runs.
  private get _status() { return this.deps._status(); }
  private set _status(value: MeshAgent["_status"]) { this.deps.set_status(value); }
  private get _stopping() { return this.deps._stopping(); }
  private get activeTurns() { return this.deps.activeTurns(); }
  private get config() { return this.deps.config(); }
  private get ep() { return this.deps.ep(); }
  private log(...args: Parameters<MeshAgent["log"]>): ReturnType<MeshAgent["log"]> { return this.deps.log(...args); }
  private requireConnected(...args: Parameters<MeshAgent["requireConnected"]>): ReturnType<MeshAgent["requireConnected"]> { return this.deps.requireConnected(...args); }
  private yieldTurn(...args: Parameters<MeshAgent["yieldTurn"]>): ReturnType<MeshAgent["yieldTurn"]> { return this.deps.yieldTurn(...args); }
  /** Presence writes go out IN CALL ORDER (#636, #2055). setStatus is two awaited puts and every
   *  connector fires it without awaiting, so two overlapping calls interleave their puts and the
   *  record that lands last is whichever call's second put finished last, not the call made last;
   *  at a driven turn's end the measured order was working, idle, working, and the seat then read
   *  working forever. Every write below runs its whole body through this chain, so the later
   *  call's puts start only after the earlier call's have settled. A rejected write must not
   *  poison the chain: the tail is swallowed and the next write still runs. */
  private presenceChain: Promise<void> = Promise.resolve();
  /** Host lifecycle status is independent of presence-only updates such as cotal_status. */
  private turnStatus: PresenceStatus | undefined;

  /** Run one presence write through the chain (#636): the write starts only after every earlier
   *  admitted write has settled, and a rejection is swallowed at the TAIL only, so it propagates
   *  to this write's own caller while the next admitted write still runs.
   *
   *  The straggler rule: departure is the last write, later writes are refused, not reordered.
   *  Once `stop()` has begun, any write admitted here rejects AT ONCE (no put queued, no wait on
   *  the chain) with a fixed error, instead of running after — or, for a write that calls
   *  `requireConnected` (e.g. `setStatus`), sitting out the ten-second connect grace before
   *  rejecting anyway. `stop()` itself submits departure's own put through this same method (the
   *  `forDeparture` escape) so departure keeps landing after every write already admitted, even
   *  though `_stopping` is already true by the time it does. */
  inOrder(write: () => Promise<void>, forDeparture = false): Promise<void> {
    if (this._stopping && !forDeparture) return Promise.reject(new Error("agent is stopping; presence writes are refused"));
    const next = this.presenceChain.then(write, write);
    this.presenceChain = next.catch(() => {});
    return next;
  }

  /** Detach the chain from writes the CALLER has abandoned, so the next write is ordered behind
   *  what has actually settled rather than behind work nobody is waiting for any more.
   *
   *  The chain above orders departure after every admitted write, which is right while those writes
   *  are still progressing and wrong once a teardown has given up on them. A host bounds its wait on
   *  admitted intake and then attempts departure; without this, that attempt queues behind the very
   *  write the bound just abandoned, so the bound buys nothing, offline never publishes, and the seat
   *  stays at its last status until its presence TTL expires. The host says in its own log that
   *  abandoned work is uncancelled and may land after departure, and the chain quietly contradicted
   *  it.
   *
   *  ABANDONED IS NOT CANCELLED here either. The detached writes keep running and may still publish,
   *  which is the same residual the caller already announces; what changes is only that departure
   *  stops waiting on them. Call it exactly where the give-up is decided, never as a general reset:
   *  a caller that invokes this while its writes are still progressing has reintroduced the race the
   *  chain exists to close. */
  abandonPresenceWrites(): void {
    this.presenceChain = Promise.resolve();
  }

  async setStatus(status: PresenceStatus, activity?: string): Promise<void> {
    await this.inOrder(async () => {
    await this.requireConnected();
    const prev = this.turnStatus;
    try {
      if (prev !== "working" && status === "working") await this.ep.setCondition(null);
      await this.publishStatus(status, activity);
    } finally {
      // The transition is a fact about the SEAT, not about whether its presence row was written:
      // assigning before the writes meant one failed publish (which every adapter swallows) left
      // `_status` idle with no boundary run, and the next real turn end saw no transition at all.
      this._status = status;
      this.turnStatus = status;
      // The turn relay's boundary: an adapter funnels its turn-end through this transition (Stop
      // hooks set idle), so the automatic `done` yield and the immediate re-poll live here once
      // instead of per connector. `waiting` is not a boundary — a seat blocked on a permission has
      // not finished, and its deadline is what bounds a stuck one.
      if (prev === "working" && status === "idle") this.onTurnBoundary();
    }
    });
  }

  /**
   * Publish presence for something that is NOT a turn ending.
   *
   * The boundary above reads working→idle as "the seat finished its turn", and that reading holds
   * only at a real turn terminal. A session (re)start writes idle too: Claude Code fires
   * `SessionStart` on compact, clear and resume, and an auto-compaction lands in the MIDDLE of a
   * long turn. Routed through `setStatus` it yielded `done` for work the model had not finished,
   * and the run moved on. An adapter uses this for every idle that is a lifecycle event rather
   * than an ending.
   */
  async resetStatus(status: PresenceStatus, activity?: string): Promise<void> {
    await this.inOrder(async () => {
    await this.requireConnected();
    try {
      await this.publishStatus(status, activity);
    } finally {
      this._status = status;
    }
    });
  }

  private async publishStatus(status: PresenceStatus, activity?: string): Promise<void> {
    await this.ep.setStatus(status, activity);
  }

  /** Change only the activity line. Routing it through `setStatus` with the current status read the
   *  status before queued writes settled, then wrote that stale value back over them. */
  async setActivity(activity: string): Promise<void> {
    await this.inOrder(async () => {
      await this.requireConnected();
      await this.ep.setActivity(activity);
    });
  }

  /** Relay a harness-reported condition into presence, or clear it. */
  async setCondition(condition: PresenceCondition | null): Promise<void> {
    await this.inOrder(() => this.ep.setCondition(condition));
  }

  /** Relay harness-reported work progress (a turn event) as presence `activeAt`. The next heartbeat
   *  carries it, so an observer can tell a turn that stopped advancing from one that is progressing. */
  noteActivity(at?: number): void {
    this.ep.noteActivity(at);
  }

  /** The working→idle boundary: yield `done` for every SURFACED turn (its payload was in the
   *  context of the turn that just ended; ending without an explicit yield IS the done signal).
   *  The manager's notice for each settled yield brings the next queued turn. Fire-and-forget
   *  from the presence path — a yield must never block a status write. */
  private onTurnBoundary(): void {
    for (const t of [...this.activeTurns.values()]) {
      if (!t.surfaced) continue;
      void this.yieldTurn("done", { turn: t.goalId })
        .then((r) => { if (!r.ok) this.log(`turn ${t.goalId} auto-yield: ${r.error ?? "refused"}`); })
        .catch((e) => this.log(`turn ${t.goalId} auto-yield: ${(e as Error).message}`));
    }
  }

  /** Record the host's actual model and optional variant learned after launch, so peers see the
   *  selection in `cotal_roster` and the web roster even when the operator never pinned one. Explicit
   *  `model:` / `variant:` config wins; this only fills the gap. `provider` is best-effort and
   *  reported independently of the model pin: a pinned seat can still report which provider is
   *  serving it, so the early return only short-circuits when no provider was given either. Best-
   *  effort presence mirror (no `requireConnected` — safe pre-connect; it rides the first publish). */
  async setModel(model: string, variant?: string, provider?: string): Promise<void> {
    if (this.config.model && provider === undefined) return; // operator pin is authoritative for the model
    await this.inOrder(() => this.ep.setCardModel(this.config.model ?? model, this.config.variant ?? variant, provider));
  }

  /** Report the session's working directory as its harness supplied it. Advisory display data. */
  async setCwd(cwd: string): Promise<void> {
    await this.inOrder(() => this.ep.setCardCwd(cwd));
  }
}
