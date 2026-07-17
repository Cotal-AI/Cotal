import type { ExactDrainResult, InboxItem, InboxScope } from "./inbox-types.js";

export interface InboxSource {
  peekInbox(scope?: InboxScope): InboxItem[];
  drainInbox(limit?: number): InboxItem[];
  drainInboxIds(ids: readonly string[]): ExactDrainResult;
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

  /** Remove already-confirmed late duplicates by exact id, even behind pull-only traffic. */
  discardTombstoned(): number {
    const ids = this.source.peekInbox().filter((item) => this.hasTombstone(item.id)).map((item) => item.id);
    if (ids.length) this.source.drainInboxIds(ids);
    return ids.length;
  }

  /** Exact discard for adapter-local traffic such as own echoes, even behind pull-only items. */
  discardMatching(match: (item: InboxItem) => boolean): number {
    const ids = this.source.peekInbox().filter(match).map((item) => item.id);
    if (ids.length) this.source.drainInboxIds(ids);
    return ids.length;
  }

  /** Select the next automatic FIFO batch after already-reserved ids. */
  select(reserved: ReadonlySet<string>, limit: number): InboxItem[] {
    const selected: InboxItem[] = [];
    for (const item of this.source.peekInbox("automatic")) {
      if (reserved.has(item.id)) continue;
      selected.push(item);
      if (selected.length >= limit) break;
    }
    return selected;
  }

  /** Commit provider-confirmed ids exactly; tombstone any already absent after overflow. */
  commitConfirmed(ids: readonly string[]): CommitResult {
    if (ids.length === 0) return { drained: 0, tombstoned: 0 };

    this.discardTombstoned();
    const result = this.source.drainInboxIds(ids);
    for (const id of result.missingIds) this.addTombstone(id);
    return { drained: result.items.length, tombstoned: result.missingIds.length };
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
