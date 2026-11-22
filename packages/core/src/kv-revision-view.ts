import type { StreamInfo } from "@nats-io/jetstream";
import type { KV, KvEntry } from "@nats-io/kv";
import { Bucket } from "@nats-io/kv/internal";
import { scanLatestKvEntries } from "./kv-scan.js";

type Head = Pick<StreamInfo, "created" | "config" | "state">;
type Census = { info: Head; keys: Set<string> };
type ReadPass = { head: Head; complete: boolean };

function sameHead(a: Head, b: Head): boolean {
  return a.created === b.created && a.state.last_seq === b.state.last_seq &&
    a.state.messages === b.state.messages &&
    a.state.num_subjects === b.state.num_subjects && a.config.max_msgs_per_subject === b.config.max_msgs_per_subject;
}

/** A local view of a KV stream. Check the leader on every read; never answer from a cached head on
 * its own. A complete ordered scan is causally fresh without matching the head observed later.
 * Keep marker keys in the census so native removal of a subject can be distinguished from a KV tombstone. */
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
   * the sequence and store census on the next refresh, like every other read. */
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
    if (before.created !== head.created || before.config.max_msgs_per_subject !== head.config.max_msgs_per_subject)
      return { head, complete: false };

    const last = entries.reduce((seq, e) => Math.max(seq, e.revision), 0);
    const end = Math.max(before.state.last_seq, last);
    let keyCount = start === undefined ? 0 : this.keys.size;
    for (const e of entries) {
      if (start === undefined || !this.keys.has(e.key)) keyCount++;
    }
    const exact = end === head.state.last_seq && keyCount === (head.state.num_subjects ?? 0);
    if (exact && (sameHead(before, head) || before.config.max_msgs_per_subject === 1)) {
      this.applyEntries(entries, start);
      this.head = head;
      this.through = end;
      return { head, complete: true };
    }
    if (before.config.max_msgs_per_subject !== 1 || end > head.state.last_seq)
      return { head, complete: false };

    // The pass crossed the caller's fence, but the trailing count can include later writes.
    // Reconcile key identity instead of waiting for equality with a moving stream head.
    return this.reconcileCensus(head, end, entries, start);
  }

  private async reconcileCensus(head: Head, through: number, entries: KvEntry[], start?: number): Promise<ReadPass> {
    const census = await this.census();
    if (census.info.created !== head.created || census.info.config.max_msgs_per_subject !== 1 || census.info.state.last_seq < through)
      return { head: census.info, complete: false };
    // A census-only key was written after the completed pass, so it belongs to the next delta.
    // Dropping an absent key is safe: a later recreation also has a revision after this pass.
    this.applyEntries(entries.filter((e) => census.keys.has(e.key)), start);
    for (const key of this.keys) {
      if (!census.keys.has(key)) { this.keys.delete(key); this.apply(key); }
    }
    // Do not jump to the census revision: it lists key names, not changed values. The next read
    // starts from this pass's proven prefix and will still see writes after that prefix.
    this.head = census.info;
    this.through = through;
    return { head: census.info, complete: true };
  }

  private async census(): Promise<Census> {
    if (!(this.kv instanceof Bucket)) throw new Error("KV revision census requires a native bucket");
    const bucket = this.kv;
    const { created, config, state } = await bucket.jsm.streams.info(bucket.stream, { subjects_filter: `${bucket.prefix}.>` });
    const { subjects, ...summary } = state;
    const keys = new Set(Object.keys(subjects ?? {}).map((subject) => bucket.decodeKey(subject.slice(bucket.prefixLen))));
    if (keys.size !== (state.num_subjects ?? 0)) throw new Error(`${bucket.stream} returned an incomplete key census`);
    return { info: { created, config, state: summary }, keys };
  }

  private applyEntries(entries: KvEntry[], start?: number): void {
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
