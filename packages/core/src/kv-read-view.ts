import type { KV, KvEntry } from "@nats-io/kv";
import { scanKvEntries } from "./kv-scan.js";

type ViewEntry = Pick<KvEntry, "key" | "operation" | "json">;
const decoder = new TextDecoder();

/** A history-1 KV view backed by a complete ordered scan. Only an unchanged stream fence and
 *  proven scan coverage advance the cached revision. Each caller takes its own fence, even when
 *  another refresh is in flight. */
export class KvReadView {
  private readonly rows = new Map<string, ViewEntry>();
  private readonly groups = new Map<string, Map<string, ViewEntry>>();
  private version?: { created: string; revision: number; count: number };
  private inFlight?: Promise<void>;

  constructor(private readonly kv: KV, private readonly group?: (key: string) => string | undefined) {}

  refresh(): Promise<KvReadView> {
    const read = (this.inFlight ?? Promise.resolve()).then(() => this.read());
    const done = read.then(() => {}, () => {});
    this.inFlight = done;
    void done.then(() => { if (this.inFlight === done) this.inFlight = undefined; });
    return read;
  }

  private async read(): Promise<KvReadView> {
    let full = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const before = await this.kv.status();
      const { created, state } = before.streamInfo;
      const prior = before.history === 1 && this.version?.created === created ? this.version : undefined;
      if (prior?.revision === state.last_seq && prior.count === state.messages) return this;
      const delta = !full && attempt < 2 && prior !== undefined && state.last_seq > prior.revision;
      const { entries, lastDelivered } = await scanKvEntries(this.kv, undefined, undefined, delta ? prior.revision + 1 : undefined);
      const after = await this.kv.status();
      const head = after.streamInfo.state;
      if (after.streamInfo.created !== created || after.history !== before.history) continue;
      const stable = head.last_seq === state.last_seq && head.messages === state.messages;
      let count = delta ? this.rows.size : 0;
      for (const entry of entries) if (!delta || !this.rows.has(entry.key)) count++;
      // A replica can report zero pending for a rewrite it has not applied. A complete pass on
      // a single replica can also cover a stream whose final stored revision was deleted.
      const covered = lastDelivered >= state.last_seq || (!delta && (state.messages === 0 || before.replicas === 1));
      if (stable && covered && before.history === 1 && count === state.messages) {
        this.apply(entries, delta);
        this.version = { created, revision: state.last_seq, count };
        return this;
      }
      if (delta && stable && covered && count !== state.messages) full = true;
      // A complete full pass gives the same answer as a fresh registry listing under concurrent
      // writes. Do not advance the warm cache from an unstable pass or from an unproven delta.
      if (!delta && covered) return this.snapshot(entries);
    }
    throw new Error("KV scan could not cover the observed stream revision");
  }

  private snapshot(entries: KvEntry[]): KvReadView {
    const snapshot = new KvReadView(this.kv, this.group);
    snapshot.apply(entries, false);
    return snapshot;
  }

  private apply(entries: KvEntry[], delta: boolean): void {
    if (!delta) { this.rows.clear(); this.groups.clear(); }
    for (const { key, operation, value } of entries) {
      // Copy the body so the view does not retain an entire NATS read buffer or its message.
      const bytes = operation === "PUT" ? Uint8Array.from(value) : undefined;
      const entry = { key, operation, json: <T>() => JSON.parse(decoder.decode(bytes)) as T };
      this.rows.set(key, entry);
      const group = this.group?.(key);
      if (group === undefined) continue;
      let rows = this.groups.get(group);
      if (operation === "PUT") {
        if (rows === undefined) this.groups.set(group, rows = new Map());
        rows.set(key, entry);
      } else {
        rows?.delete(key);
        if (rows?.size === 0) this.groups.delete(group);
      }
    }
  }

  *entries(group?: string): Iterable<ViewEntry> {
    const rows = group === undefined ? this.rows : this.groups.get(group);
    if (rows) for (const entry of rows.values()) if (entry.operation === "PUT") yield entry;
  }
}
