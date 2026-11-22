import type { StreamInfo } from "@nats-io/jetstream";
import type { KV, KvEntry } from "@nats-io/kv";
import { Bucket } from "@nats-io/kv/internal";
import { scanLatestKvEntries } from "./kv-scan.js";

type Head = Pick<StreamInfo, "created" | "config" | "state">;
type ReadPass = { head: Head; complete: boolean };
const MAX_TAIL_READS = 16;

function sameStore(a: Head, b: Head): boolean {
  return a.created === b.created && a.config.max_msgs_per_subject === b.config.max_msgs_per_subject;
}

function sameHead(a: Head, b: Head): boolean {
  return sameStore(a, b) && a.state.last_seq === b.state.last_seq &&
    a.state.messages === b.state.messages &&
    a.state.num_subjects === b.state.num_subjects;
}

/** A local view of a KV stream. Check the leader on every read; never answer from a cached head on
 * its own. Keep KV markers in the key count: native removal of a subject has no marker to replay. */
export class KvRevisionView {
  private head?: Head;
  private through = 0;
  private readonly keys = new Set<string>();
  private running?: Promise<void>;
  private queued?: Promise<void>;

  constructor(
    private readonly kv: KV,
    private readonly apply: (key: string, entry?: KvEntry) => void,
  ) {}

  /** Coalesce callers only into a read that has not started yet. */
  refresh(): Promise<void> {
    if (this.queued) return this.queued;
    const pass = (this.running ?? Promise.resolve()).catch(() => {}).then(() => {
      this.queued = undefined;
      return this.read();
    });
    this.running = this.queued = pass;
    const done = () => { if (this.running === pass) this.running = undefined; };
    void pass.then(done, done);
    return pass;
  }

  /** A writer may skip reading back its own overwrite of an existing, unprojected key. Verify
   * the sequence and key count on the next refresh, like every other read. */
  skipOverwrite(key: string, revision: number): void {
    const head = this.head;
    if (!head || this.through !== head.state.last_seq || !this.keys.has(key) ||
      head.config.max_msgs_per_subject !== 1 || revision !== this.through + 1) return;
    this.through = revision;
    this.head = { ...head, state: { ...head.state, last_seq: revision } };
  }

  private async headNow(): Promise<Head> { return (await this.kv.status()).streamInfo; }

  private async read(): Promise<void> {
    let before = await this.headNow();
    if (this.head && this.through === before.state.last_seq &&
      this.keys.size === (before.state.num_subjects ?? 0) && sameHead(this.head, before)) return;

    for (let attempt = 0; attempt < 3; attempt++) {
      // With history 1, a post-cursor entry replaces the whole value for its key. With deeper
      // history, deleting the latest revision can expose an older value, so snapshot on change.
      const prior = this.head;
      const start = prior && prior.created === before.created && prior.config.max_msgs_per_subject === 1 &&
        before.config.max_msgs_per_subject === 1 && this.through < before.state.last_seq
        ? this.through + 1 : undefined;
      const pass = await this.readPass(before, start);
      if (pass.complete) return;
      this.head = undefined;
      before = pass.head;
    }
    throw new Error(`${before.config.name} changed during revision view refresh`);
  }

  private async readPass(before: Head, start?: number): Promise<ReadPass> {
    // Do not stop on the first revision past the entry head: a key changed before that fence may have
    // been overwritten and moved further ahead before the consumer gets to it.
    const entries = await scanLatestKvEntries(this.kv, undefined, undefined, start);
    const head = await this.headNow();
    if (!sameStore(before, head)) return { head, complete: false };

    const end = entries.reduce((seq, e) => Math.max(seq, e.revision), before.state.last_seq);
    if (end > head.state.last_seq) return { head, complete: false };
    const latest = new Map(entries.map((e) => [e.key, e]));
    if (head.config.max_msgs_per_subject === 1 && end < head.state.last_seq) {
      return this.reconcileTail(latest, start, end, head);
    }
    if (head.config.max_msgs_per_subject !== 1 && !sameHead(before, head)) return { head, complete: false };
    if (!this.countMatches(latest, start, head)) return { head, complete: false };
    return this.accept(latest, start, head, end);
  }

  private async reconcileTail(latest: Map<string, KvEntry>, start: number | undefined, end: number, head: Head): Promise<ReadPass> {
    const tail = await this.readTail(end, head);
    if (tail) {
      const checked = await this.headNow();
      if (!sameStore(head, checked) || checked.state.last_seq < head.state.last_seq) return { head: checked, complete: false };
      // A missing revision can only be counted as absent at the later reply, and only if all
      // revisions at that reply were queried. A complete tail also proves the earlier head.
      const proven = tail.every((e) => e !== undefined) ? head
        : checked.state.last_seq === head.state.last_seq ? checked : undefined;
      if (proven) {
        for (const e of tail) if (e) latest.set(e.key, e);
        return this.countMatches(latest, start, proven)
          ? this.accept(latest, start, proven, proven.state.last_seq) : { head: checked, complete: false };
      }
    }
    // A fresh full pass can stand on its own. Keep its cursor, not the later head, so a
    // following delta still has to account for every retained key before it can serve.
    return start === undefined ? this.accept(latest, start, head, end) : { head, complete: false };
  }

  private countMatches(latest: ReadonlyMap<string, KvEntry>, start: number | undefined, head: Head): boolean {
    let count = start === undefined ? 0 : this.keys.size;
    for (const key of latest.keys()) if (start === undefined || !this.keys.has(key)) count++;
    return count === (head.state.num_subjects ?? 0);
  }

  private accept(latest: ReadonlyMap<string, KvEntry>, start: number | undefined, head: Head, through: number): ReadPass {
    this.applyEntries(latest.values(), start);
    this.head = head;
    this.through = through;
    return { head, complete: true };
  }

  private async readTail(after: number, head: Head): Promise<(KvEntry | undefined)[] | undefined> {
    const length = head.state.last_seq - after;
    if (length > MAX_TAIL_READS) return undefined;
    if (!(this.kv instanceof Bucket)) throw new Error("KV revision tail requires a native bucket");
    const bucket = this.kv;
    // A retained revision cannot reappear with its old sequence. If every slot is readable, the
    // scan and tail cover every live key at this head. A gap can hide an insertion balancing a
    // markerless erase, so the subject count alone cannot confirm the projection.
    return Promise.all(Array.from({ length }, async (_, i) => {
      const msg = await bucket.jsm.streams.getMessage(bucket.stream, { seq: after + i + 1 });
      return msg ? bucket.smToEntry(msg) : undefined;
    }));
  }

  private applyEntries(entries: Iterable<KvEntry>, start?: number): void {
    if (start === undefined) {
      for (const key of this.keys) this.apply(key);
      this.keys.clear();
    }
    for (const e of entries) {
      this.keys.add(e.key);
      this.apply(e.key, e.operation === "DEL" || e.operation === "PURGE" ? undefined : e);
    }
  }
}
