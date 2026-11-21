import type { KV, KvEntry } from "@nats-io/kv";
import { liveKvEntries } from "./kv-scan.js";

interface Frontier {
  name: string;
  created: string;
  lastSequence: number;
  messages: number;
  history: number;
}

async function frontier(kv: KV): Promise<Frontier> {
  const { streamInfo, history } = await kv.status();
  const { config: { name }, created, state: { last_seq: lastSequence, messages } } = streamInfo;
  return { name, created, lastSequence, messages, history };
}

function sameFrontier(a: Frontier, b: Frontier): boolean {
  return a.name === b.name && a.created === b.created && a.lastSequence === b.lastSequence &&
    a.messages === b.messages && a.history === b.history;
}

/** A serial reader's projection cursor. Each refresh checks the leader; a timeout or an incomplete
 * scan propagates instead of serving the previous view. The projection applies the returned update
 * before calling refresh again. */
export class KvRevisionView {
  private seen?: Frontier;
  private readonly keys = new Set<string>();

  async refresh(kv: KV): Promise<{ reset: boolean; entries: KvEntry[] } | undefined> {
    let before = await frontier(kv);
    let rebuild = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      const seen = this.seen;
      if (seen && sameFrontier(seen, before)) return undefined;
      const delta = !rebuild && seen?.name === before.name && seen.created === before.created && seen.history === 1 &&
        before.history === 1 && seen.lastSequence < before.lastSequence;
      const entries = await liveKvEntries(kv, { includeDeleted: true, startSequence: delta ? seen.lastSequence + 1 : undefined });
      const after = await frontier(kv);
      if (!sameFrontier(before, after)) {
        before = after;
        continue;
      }
      // In history-one KV every retained subject counts once, including KV delete markers. A
      // physical stream delete has no marker; if a delta misses it, the native count exposes it.
      if (after.history === 1) {
        const count = delta ? this.keys.size + entries.filter((e) => !this.keys.has(e.key)).length : entries.length;
        if (count !== after.messages) {
          if (!delta) throw new Error(`KV ${after.name} returned ${count} of ${after.messages} keys`);
          rebuild = true;
          continue;
        }
      }
      if (!delta) this.keys.clear();
      for (const e of entries) this.keys.add(e.key);
      this.seen = after;
      return { reset: !delta, entries };
    }
    throw new Error(`KV ${before.name} changed during snapshot reads; retry`);
  }

  /** Consume a write acknowledged to this reader only when no intervening append is possible.
   * The next Stream Info still checks the epoch and count, including out-of-band deletions. */
  noteWrite(key: string, revision: number): void {
    const seen = this.seen;
    if (seen?.history !== 1 || revision !== seen.lastSequence + 1) return;
    this.keys.add(key);
    this.seen = { ...seen, lastSequence: revision, messages: this.keys.size };
  }
}
