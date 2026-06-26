import type { InboxItem } from "./agent.js";

/** The slice of {@link MeshAgent} an {@link InboxTurn} drives off of. */
export interface InboxSource {
  /** Buffered messages, oldest first, without acking. */
  peekInbox(): InboxItem[];
  /** Ack + remove the front `limit` messages and return them. */
  drainInbox(limit?: number): InboxItem[];
  /** Ack + remove the messages with these ids (any position); an absent id is a no-op. */
  ackInbox(ids: string[]): InboxItem[];
}

/**
 * Ack-on-surface delivery off a {@link MeshAgent}'s stream-backed inbox.
 *
 * The inbox is the single source of truth — there is no parallel buffer to drift out of
 * sync. A turn *surfaces* messages by id and acks them (via `ackInbox`) only once the turn
 * COMPLETES; a crash or interrupt before {@link commit} leaves them on the stream, so they
 * redeliver — nothing is acked merely by being read. Acking by id (rather than by front
 * position) keeps it correct even when the `MAX_INBOX` overflow force-evicts the in-flight
 * prefix from the front mid-turn: those ids are already gone, so the ack no-ops them and
 * never touches the newer messages that took their place.
 *
 * Fits both shapes the embed adapters use:
 *   - a one-message serialize loop: `start()` → run → `commit()`;
 *   - pi's same-scope steer loop: `start()` → `extend(match)`* (fold contiguous peers, e.g.
 *     same-scope messages, as they stream in) → `commit()` on a clean/failed finish, or
 *     `abandon()` on interrupt.
 *
 * `cotal_inbox` (where exposed) must stay on `peekInbox` so a model call can't double-drain
 * what the loop already surfaced.
 */
export class InboxTurn {
  private surfacedIds: string[] = [];
  private _origin?: InboxItem;

  constructor(private readonly source: InboxSource) {}

  /** True while a turn holds surfaced-but-unacked messages. */
  get inFlight(): boolean {
    return this.surfacedIds.length > 0;
  }

  /** The message that opened the current turn (its reply scope), or undefined when idle. */
  get origin(): InboxItem | undefined {
    return this._origin;
  }

  /** How many messages this turn has surfaced. */
  get count(): number {
    return this.surfacedIds.length;
  }

  /**
   * Ack-drop the leading messages matching `skip` (own echoes, ambient chatter) so they
   * neither block the front nor linger to the inbox cap. Only valid with no turn in flight
   * (a between-turns, synchronous front trim — no eviction can interleave).
   */
  drop(skip: (item: InboxItem) => boolean): void {
    if (this.surfacedIds.length) return;
    const pending = this.source.peekInbox();
    let n = 0;
    while (n < pending.length && skip(pending[n])) n++;
    if (n) this.source.drainInbox(n);
  }

  /**
   * Open a turn on the front message (its origin) and surface it. Returns the origin, or
   * undefined if the inbox is empty. Idempotent while a turn is in flight (returns the
   * current origin). Call {@link drop} first so the front is the message you mean to answer.
   */
  start(): InboxItem | undefined {
    if (this.surfacedIds.length) return this._origin;
    const front = this.source.peekInbox()[0];
    if (!front) return undefined;
    this._origin = front;
    this.surfacedIds = [front.id];
    return front;
  }

  /**
   * Fold the front-contiguous run of not-yet-surfaced messages that `match(item, origin)`
   * into this turn, stopping at the first unsurfaced non-match (so a cross-scope message is
   * left to open its own turn, preserving FIFO + scope isolation). Already-surfaced messages
   * are skipped, so an overflow that evicts part of the prefix can't desync this. Returns the
   * newly surfaced messages for the caller to feed in (e.g. via steer). No-op until
   * {@link start}.
   */
  extend(match: (item: InboxItem, origin: InboxItem) => boolean): InboxItem[] {
    if (!this._origin) return [];
    const surfaced = new Set(this.surfacedIds);
    const run: InboxItem[] = [];
    for (const item of this.source.peekInbox()) {
      if (surfaced.has(item.id)) continue; // already surfaced (still buffered) — skip
      if (!match(item, this._origin)) break; // first unsurfaced non-match → stop at the gap
      run.push(item);
      this.surfacedIds.push(item.id);
    }
    return run;
  }

  /**
   * Ack the surfaced messages by id — the sole ack site. Call on a terminal status that
   * should consume them: a clean finish, or a failed/dropped turn (drop, no retry-loop). Ids
   * already evicted by the overflow no-op. Do NOT call on interrupt/crash — use
   * {@link abandon} so the run redelivers.
   */
  commit(): void {
    if (this.surfacedIds.length) this.source.ackInbox(this.surfacedIds);
    this.reset();
  }

  /** End the turn without acking — the surfaced run stays on the stream and redelivers. */
  abandon(): void {
    this.reset();
  }

  private reset(): void {
    this.surfacedIds = [];
    this._origin = undefined;
  }
}
