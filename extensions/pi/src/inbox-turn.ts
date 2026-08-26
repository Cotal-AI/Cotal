import type { ExactDrainResult, InboxItem, InboxScope } from "./inbox-types.js";

export interface InboxSource {
  peekInbox(scope?: InboxScope): InboxItem[];
  drainInbox(limit?: number): InboxItem[];
  drainInboxDeliveries(keys: readonly string[]): ExactDrainResult;
}

export interface CommitResult {
  drained: number;
  tombstoned: number;
}

const TOMBSTONE_CAP = 4096;

/**
 * Pi-local acknowledgement ledger over MeshAgent's exact-id drain API. Provider-confirmed items
 * can be committed around interleaved pull-only traffic without positional acknowledgement;
 * overflow-missing ids are tombstoned for exact late-duplicate discard.
 */
export class InboxTurn {
  private tombstones = new Set<string>();
  private previousTombstones = new Set<string>();

  constructor(private readonly source: InboxSource) {}

  peek(scope: InboxScope = "all"): InboxItem[] {
    return this.source.peekInbox(scope);
  }

  /** Remove already-confirmed late duplicates by exact receive key, even behind pull-only traffic.
   *  #624: tombstones and selection address the DELIVERY (InboxItem.recvKey). An empty wire id is
   *  never a key, so two distinct id-less deliveries never cross-reserve or cross-tombstone each
   *  other inside a turn. */
  discardTombstoned(): number {
    const ids = this.source.peekInbox().filter((item) => this.hasTombstone(item.recvKey)).map((item) => item.recvKey);
    if (ids.length) this.source.drainInboxDeliveries(ids);
    return ids.length;
  }

  /** Exact discard for adapter-local traffic such as own echoes, even behind pull-only items. */
  discardMatching(match: (item: InboxItem) => boolean): number {
    const ids = this.source.peekInbox().filter(match).map((item) => item.recvKey);
    if (ids.length) this.source.drainInboxDeliveries(ids);
    return ids.length;
  }

  /** Select the next automatic FIFO batch after already-reserved receive keys. */
  select(reserved: ReadonlySet<string>, limit: number): InboxItem[] {
    const selected: InboxItem[] = [];
    for (const item of this.source.peekInbox("automatic")) {
      if (reserved.has(item.recvKey)) continue;
      selected.push(item);
      if (selected.length >= limit) break;
    }
    return selected;
  }

  /** Commit provider-confirmed ids exactly; tombstone any already absent after overflow. */
  commitConfirmed(ids: readonly string[]): CommitResult {
    if (ids.length === 0) return { drained: 0, tombstoned: 0 };

    this.discardTombstoned();
    const result = this.source.drainInboxDeliveries(ids);
    for (const key of result.missingKeys) this.addTombstone(key);
    return { drained: result.items.length, tombstoned: result.missingKeys.length };
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
