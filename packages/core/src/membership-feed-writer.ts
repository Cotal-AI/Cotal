import type { KV } from "@nats-io/kv";
import { KvRevisionView } from "./kv-revision-view.js";
import { MEMBERSHIP_FEED_KEY, membershipKey } from "./subjects.js";
import type { ChannelMembership } from "./types.js";

const encoder = new TextEncoder();
const encode = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));

/** The derived store can be recreated while the daemon runs. Refresh before comparing rows, so a
 * missing store cannot be mistaken for a quiet poll or have a heartbeat stamped over a partial view. */
export class MembershipFeedWriter {
  private readonly cursor = new KvRevisionView();
  private readonly current = new Map<string, ChannelMembership | undefined>();
  private readonly dirty = new Set<string>();
  private lastLive = new Map<string, Set<string>>();
  private lastDurable?: Map<string, Set<string>>;

  async write(kv: KV, live: Map<string, Set<string>>, durable: Map<string, Set<string>>): Promise<void> {
    await this.refresh(kv);
    const observedAt = Date.now();
    // The durable projection keeps its identity until its registry changes. In a live-only poll,
    // touch connected, departed, and externally changed principals, not every offline member.
    const ids = this.lastDurable === durable
      ? new Set([...live.keys(), ...this.lastLive.keys(), ...this.dirty])
      : new Set([...live.keys(), ...durable.keys(), ...this.current.keys()]);
    for (const id of ids) await this.writeMember(kv, membershipKey(id), live.get(id), durable.get(id), observedAt);

    let count = durable.size;
    for (const id of live.keys()) if (!durable.has(id)) count++;
    this.cursor.noteWrite(MEMBERSHIP_FEED_KEY, await kv.put(MEMBERSHIP_FEED_KEY, encode({ observedAt, count })));
    this.dirty.clear();
    this.lastLive = live;
    this.lastDurable = durable;
  }

  private async writeMember(kv: KV, key: string, live: Set<string> | undefined, durable: Set<string> | undefined, observedAt: number): Promise<void> {
    if (!live && !durable) {
      if (this.current.has(key)) {
        await kv.delete(key);
        this.current.delete(key);
      }
      return;
    }
    const rec = { live: [...(live ?? [])].sort(), durable: [...(durable ?? [])].sort(), observedAt };
    if (sameMembership(this.current.get(key), rec)) return;
    this.cursor.noteWrite(key, await kv.put(key, encode(rec)));
    this.current.set(key, rec);
  }

  private async refresh(kv: KV): Promise<void> {
    const update = await this.cursor.refresh(kv);
    if (!update) return;
    if (update.reset) {
      this.current.clear();
      this.dirty.clear();
      this.lastDurable = undefined;
    }
    for (const e of update.entries) {
      if (e.key === MEMBERSHIP_FEED_KEY) continue;
      this.dirty.add(e.key);
      if (e.operation !== "PUT") this.current.delete(e.key);
      else {
        try { this.current.set(e.key, e.json<ChannelMembership>()); }
        catch { this.current.set(e.key, undefined); }
      }
    }
  }
}

/** Ignore observedAt so a quiet poll does not rewrite every member. Malformed rows are replaced. */
function sameMembership(a: ChannelMembership | undefined, b: ChannelMembership): boolean {
  const eq = (x: string[], y: string[]) => Array.isArray(x) && x.length === y.length && x.every((v, i) => v === y[i]);
  return !!a && eq(a.live, b.live) && eq(a.durable, b.durable);
}
