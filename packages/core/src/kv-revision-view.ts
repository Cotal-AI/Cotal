import type { StreamInfo } from "@nats-io/jetstream";
import type { KV, KvEntry } from "@nats-io/kv";
import { scanLatestKvEntries } from "./kv-scan.js";

type Head = Pick<StreamInfo, "created" | "config" | "state">;

function sameHead(a: Head, b: Head): boolean {
  return a.created === b.created && a.state.last_seq === b.state.last_seq &&
    a.state.messages === b.state.messages &&
    a.state.num_subjects === b.state.num_subjects && a.config.max_msgs_per_subject === b.config.max_msgs_per_subject;
}

/** A local view of a KV stream. Check the leader on every read; never answer from a cached head on
 * its own. Keep marker keys in the census: a missing subject without a KV marker (e.g. a native
 * purge) is a reason to rebuild, not a delta we can replay. */
export class KvRevisionView {
  private head?: Head;
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
    if (!head || !this.keys.has(key) || head.config.max_msgs_per_subject !== 1 || revision !== head.state.last_seq + 1) return;
    this.head = { ...head, state: { ...head.state, last_seq: revision } };
  }

  private async headNow(): Promise<Head> { return (await this.kv.status()).streamInfo; }

  private async read(): Promise<void> {
    let before = await this.headNow();
    if (this.head && sameHead(this.head, before)) return;

    for (let attempt = 0; attempt < 3; attempt++) {
      // With history 1, a post-cursor entry replaces the whole value for its key. With deeper
      // history, deleting the latest revision can expose an older value, so snapshot on change.
      const prior = this.head;
      const start = prior && prior.created === before.created && prior.config.max_msgs_per_subject === 1 &&
        before.config.max_msgs_per_subject === 1 && prior.state.last_seq < before.state.last_seq
        ? prior.state.last_seq + 1 : undefined;
      const pass = await this.readPass(before, start);
      if (pass.complete) return;
      // A competing write can race the pass without invalidating the old cursor. Losing a key
      // without a marker is different: a subsequent delta cannot tell us which key disappeared.
      if (pass.keyLoss) this.head = undefined;
      before = pass.head;
    }
    throw new Error(`${before.config.name} changed during revision view refresh`);
  }

  private async readPass(before: Head, start?: number): Promise<{ head: Head; complete: boolean; keyLoss?: boolean }> {
    const entries = await scanLatestKvEntries(this.kv, undefined, undefined, start);
    const head = await this.headNow();
    let last = 0;
    let keyCount = start === undefined ? 0 : this.keys.size;
    for (const e of entries) {
      last = Math.max(last, e.revision);
      if (start === undefined || !this.keys.has(e.key)) keyCount++;
    }
    const subjects = head.state.num_subjects ?? 0;
    const stable = sameHead(before, head) && last <= head.state.last_seq;
    // With history one, the prior keys plus the delta contain every retained key at the later
    // head. A larger union means a key disappeared without leaving a marker.
    const caughtUp = before.created === head.created && before.config.max_msgs_per_subject === 1 &&
      head.config.max_msgs_per_subject === 1 && last === head.state.last_seq;
    if ((!stable && !caughtUp) || keyCount !== subjects)
      return { head, complete: false, keyLoss: keyCount > subjects };

    if (start === undefined) {
      for (const key of this.keys) this.apply(key);
      this.keys.clear();
    }
    for (const e of entries) {
      this.keys.add(e.key);
      this.apply(e.key, e.operation === "DEL" || e.operation === "PURGE" ? undefined : e);
    }
    this.head = head;
    return { head, complete: true };
  }
}
