import type { KV, KvEntry } from "@nats-io/kv";
import { KvRevisionView } from "./kv-revision-view.js";
import { familiesCovering, parseMemberKey } from "./subjects.js";
import type { MembershipRecord } from "./types.js";

function decodeMemberRecord(entry: KvEntry): MembershipRecord | undefined {
  if (entry.operation !== "PUT") return undefined;
  try { return entry.json<MembershipRecord>(); }
  catch { return undefined; }
}

/** Per-reader view of the canonical registry. Fan-out reads the exact channel and ancestor families
 * only, without changing the keys or the records that delivery and its trusted reader authorize. */
export class MemberRegistryView {
  private readonly cursor = new KvRevisionView();
  private readonly channels = new Map<string, Map<string, MembershipRecord>>();
  private durableByOwner?: Map<string, Set<string>>;

  async covering(kv: KV, channel: string): Promise<MembershipRecord[]> {
    await this.refresh(kv);
    const records: MembershipRecord[] = [];
    for (const row of [channel, ...familiesCovering(channel)]) {
      const members = this.channels.get(row);
      if (members) for (const record of members.values()) records.push(record);
    }
    return records;
  }

  async durable(kv: KV): Promise<Map<string, Set<string>>> {
    await this.refresh(kv);
    if (this.durableByOwner) return this.durableByOwner;
    const durable = new Map<string, Set<string>>();
    for (const members of this.channels.values()) {
      for (const r of members.values()) {
        if (r.leaveCursor !== undefined || r.activated !== true) continue;
        let channels = durable.get(r.owner);
        if (!channels) durable.set(r.owner, channels = new Set());
        channels.add(r.channel);
      }
    }
    return this.durableByOwner = durable;
  }

  private async refresh(kv: KV): Promise<void> {
    const update = await this.cursor.refresh(kv);
    if (!update) return;
    this.durableByOwner = undefined;
    if (update.reset) this.channels.clear();
    for (const entry of update.entries) {
      const key = parseMemberKey(entry.key);
      if (!key) continue;
      let members = this.channels.get(key.channel);
      const record = decodeMemberRecord(entry);
      if (record) {
        if (!members) this.channels.set(key.channel, members = new Map());
        members.set(entry.key, record);
      } else if (members?.delete(entry.key) && members.size === 0) {
        this.channels.delete(key.channel);
      }
    }
  }
}
