import type { KV, KvEntry } from "@nats-io/kv";
import { scanKvEntries } from "./kv-scan.js";

/** A single reader's view of a history-1 KV. The leader's stream state fences each read, so a
 *  caller never uses a snapshot that is behind an acknowledged write. A replay starts at the first
 *  unseen revision and includes DEL/PURGE markers. A stream replacement or a removal without a
 *  marker invalidates the view and requires a fresh snapshot. The caller owns serialization. */
export class KvReadView {
  private readonly rows = new Map<string, KvEntry>();
  private readonly groups = new Map<string, Map<string, KvEntry>>();
  private version?: { created: string; revision: number; count: number };

  constructor(private readonly kv: KV, private readonly group?: (key: string) => string | undefined) {}

  private reset(): void {
    this.version = undefined;
    this.rows.clear();
    this.groups.clear();
  }

  async refresh(): Promise<this> {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await this.kv.status();
        const { created, state } = before.streamInfo;
        // The canonical buckets keep one entry per key. A drifted bucket can still be read, but
        // its message count cannot validate an incremental key view.
        if (before.history !== 1 || (this.version && (this.version.created !== created || state.last_seq < this.version.revision))) this.reset();
        const prior = this.version;
        if (prior?.revision === state.last_seq && prior.count === state.messages) return this;
        const delta = prior !== undefined && state.last_seq > prior.revision;
        if (!delta) this.reset();
        const entries = await scanKvEntries(this.kv, undefined, undefined, delta ? prior.revision + 1 : undefined);
        const after = await this.kv.status();
        const head = after.streamInfo.state;
        if (after.streamInfo.created !== created || after.history !== before.history ||
          head.last_seq !== state.last_seq || head.messages !== state.messages) continue;
        let count = this.rows.size;
        for (const entry of entries) if (!this.rows.has(entry.key)) count++;
        if (before.history === 1 && count !== state.messages) {
          this.reset();
          continue;
        }
        for (const entry of entries) {
          this.rows.set(entry.key, entry);
          const group = this.group?.(entry.key);
          if (group === undefined) continue;
          let rows = this.groups.get(group);
          if (entry.operation === "PUT") {
            if (rows === undefined) this.groups.set(group, rows = new Map());
            rows.set(entry.key, entry);
          } else {
            rows?.delete(entry.key);
            if (rows?.size === 0) this.groups.delete(group);
          }
        }
        this.version = { created, revision: state.last_seq, count: state.messages };
        return this;
      }
      throw new Error("KV snapshot did not settle after three reads");
    } catch (error) {
      this.reset();
      throw error;
    }
  }

  *entries(group?: string): Iterable<KvEntry> {
    const rows = group === undefined ? this.rows : this.groups.get(group);
    if (rows) for (const entry of rows.values()) if (entry.operation === "PUT") yield entry;
  }
}
