import type { KV, KvEntry } from "@nats-io/kv";
import { KvRevisionView } from "./kv-revision-view.js";
import { MEMBERSHIP_FEED_KEY, membershipKey } from "./subjects.js";
import type { ChannelMembership } from "./types.js";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** The broker-checked projection of the derived feed, including undecodable keys we must repair. */
export class MembershipFeedRows {
  private readonly current = new Map<string, ChannelMembership | undefined>();
  private readonly view: KvRevisionView;

  constructor(private readonly kv: KV) {
    this.view = new KvRevisionView(kv, (key, entry) => this.apply(key, entry));
  }

  private apply(key: string, entry?: KvEntry): void {
    if (key === MEMBERSHIP_FEED_KEY) return;
    if (!entry) { this.current.delete(key); return; }
    let record: ChannelMembership | undefined;
    try { record = entry.json<ChannelMembership>(); } catch { /* repair on publish */ }
    this.current.set(key, record);
  }

  async publish(next: Map<string, ChannelMembership>, observedAt: number, stillCurrent: () => boolean): Promise<void> {
    await this.view.refresh();
    if (!stillCurrent()) return;
    const stale = new Set(this.current.keys());
    for (const [id, rec] of next) {
      const key = membershipKey(id);
      stale.delete(key);
      if (!sameMembership(this.current.get(key), rec)) {
        if (!stillCurrent()) return;
        await this.kv.put(key, encode(rec));
      }
    }
    for (const key of stale) {
      if (!stillCurrent()) return;
      await this.kv.delete(key);
    }

    // Feed freshness advances even when no member row changes.
    if (!stillCurrent()) return;
    const revision = await this.kv.put(MEMBERSHIP_FEED_KEY, encode({ observedAt, count: next.size }));
    this.view.skipOverwrite(MEMBERSHIP_FEED_KEY, revision);
  }
}

function sameMembership(a: ChannelMembership | undefined, b: ChannelMembership): boolean {
  return a != null && sameChannels(a.live, b.live) && sameChannels(a.durable, b.durable);
}

function sameChannels(a: string[], b: string[]): boolean {
  return Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
}
