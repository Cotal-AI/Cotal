import type { InboxItem } from "@cotal-ai/connector-core";

export interface InboxSource {
  peekInbox(): InboxItem[];
  drainInbox(limit?: number): InboxItem[];
}

export interface CommitResult {
  drained: number;
  tombstoned: number;
  error?: string;
}

const TOMBSTONE_CAP = 4096;

/**
 * Pi-local acknowledgement ledger over MeshAgent's public prefix-drain API.
 *
 * A provider-confirmed batch is drained only when its still-buffered ids are the current front
 * prefix. Missing ids are allowed only at the older edge, where MeshAgent's bounded inbox may have
 * force-evicted them. Anything else is tombstoned and left unacked rather than risking a positional
 * drain of unrelated traffic. A late duplicate is discarded only when it reaches the front.
 */
export class InboxTurn {
  private tombstones = new Set<string>();
  private previousTombstones = new Set<string>();

  constructor(private readonly source: InboxSource) {}

  peek(): InboxItem[] {
    return this.source.peekInbox();
  }

  /** Remove already-confirmed late duplicates from the front, one exact item at a time. */
  discardTombstonedFront(): number {
    let discarded = 0;
    while (true) {
      const front = this.source.peekInbox()[0];
      if (!front || !this.hasTombstone(front.id)) return discarded;
      this.source.drainInbox(1);
      discarded++;
    }
  }

  /** Prefix-only discard for adapter-local traffic such as own channel echoes. */
  discardFront(match: (item: InboxItem) => boolean): number {
    let discarded = 0;
    while (true) {
      const front = this.source.peekInbox()[0];
      if (!front || !match(front)) return discarded;
      this.source.drainInbox(1);
      discarded++;
    }
  }

  /**
   * Select the next FIFO batch after already-reserved ids. `boundary` is never skipped: a buried
   * echo or other local boundary waits until older reserved work reaches a terminal decision.
   */
  select(reserved: ReadonlySet<string>, boundary: (item: InboxItem) => boolean, limit: number): InboxItem[] {
    const selected: InboxItem[] = [];
    for (const item of this.source.peekInbox()) {
      if (reserved.has(item.id)) continue;
      if (boundary(item)) break;
      selected.push(item);
      if (selected.length >= limit) break;
    }
    return selected;
  }

  /**
   * Commit provider-confirmed ids without ever calling drainInbox(0), which means "drain all" in
   * MeshAgent. On an invariant mismatch, acknowledge nothing and retain tombstones for exact later
   * discard.
   */
  commitConfirmed(ids: readonly string[]): CommitResult {
    if (ids.length === 0) return { drained: 0, tombstoned: 0 };

    this.discardTombstonedFront();
    const pending = this.source.peekInbox();
    const pendingIds = new Set(pending.map((item) => item.id));
    const firstPresent = ids.findIndex((id) => pendingIds.has(id));

    if (firstPresent < 0) {
      for (const id of ids) this.addTombstone(id);
      return { drained: 0, tombstoned: ids.length };
    }

    const remaining = ids.slice(firstPresent);
    const missingAfterFront = remaining.find((id) => !pendingIds.has(id));
    const actualPrefix = pending.slice(0, remaining.length).map((item) => item.id);
    const prefixMatches =
      !missingAfterFront && actualPrefix.length === remaining.length && actualPrefix.every((id, i) => id === remaining[i]);

    if (!prefixMatches) {
      for (const id of ids) this.addTombstone(id);
      const expected = remaining.join(", ");
      const actual = actualPrefix.join(", ");
      return {
        drained: 0,
        tombstoned: ids.length,
        error: `confirmed inbox prefix mismatch: expected [${expected}], found [${actual}]`,
      };
    }

    if (remaining.length > 0) this.source.drainInbox(remaining.length);
    for (const id of ids.slice(0, firstPresent)) this.addTombstone(id);
    return { drained: remaining.length, tombstoned: firstPresent };
  }

  private hasTombstone(id: string): boolean {
    return this.tombstones.has(id) || this.previousTombstones.has(id);
  }

  private addTombstone(id: string): void {
    this.tombstones.add(id);
    if (this.tombstones.size >= TOMBSTONE_CAP) {
      this.previousTombstones = this.tombstones;
      this.tombstones = new Set();
    }
  }
}
