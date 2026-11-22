import type { KV, KvEntry } from "@nats-io/kv";
import { KvRevisionView } from "./kv-revision-view.js";
import { familiesCovering, isChannelFamily, parseMemberKey } from "./subjects.js";
import type { MembershipRecord } from "./types.js";

interface MemberFilter {
  channel?: string;
  covering?: string;
  owner?: string;
}

type Rows = Map<string, MembershipRecord>;

const indexes = new WeakMap<KV, MemberIndex>();

export function indexedMembers(kv: KV, filter: MemberFilter): Promise<MembershipRecord[]> {
  let index = indexes.get(kv);
  if (!index) indexes.set(kv, index = new MemberIndex(kv));
  return index.list(filter);
}

class MemberIndex {
  private readonly rows: Rows = new Map();
  private readonly channels = new Map<string, Rows>();
  private readonly principals = new Map<string, Rows>();
  private readonly view: KvRevisionView;

  constructor(kv: KV) {
    this.view = new KvRevisionView(kv, (key, entry) => this.apply(key, entry));
  }

  async list(filter: MemberFilter): Promise<MembershipRecord[]> {
    await this.view.refresh();
    const covering = filter.covering === undefined ? undefined
      : [filter.covering, ...familiesCovering(filter.covering).filter(isChannelFamily)];
    if (filter.channel !== undefined && covering && !covering.includes(filter.channel)) return [];
    const channels = filter.channel === undefined ? covering : [filter.channel];
    const ownerRows = filter.owner === undefined ? undefined : this.principals.get(filter.owner);
    if (filter.owner !== undefined && !ownerRows) return [];
    const groups = channels ? channels.map((ch) => this.channels.get(ch)) : [ownerRows ?? this.rows];
    const result: MembershipRecord[] = [];
    for (const rows of groups) {
      if (!rows) continue;
      for (const [key, record] of rows) {
        if (ownerRows && !ownerRows.has(key)) continue;
        result.push(structuredClone(record));
      }
    }
    return result;
  }

  private apply(key: string, entry?: KvEntry): void {
    const parsed = parseMemberKey(key);
    if (!parsed) return;
    let record: MembershipRecord | undefined;
    try { record = entry?.json<MembershipRecord>(); } catch { /* skip undecodable values */ }
    if (record && typeof record === "object" && !Array.isArray(record)) this.rows.set(key, record);
    else { this.rows.delete(key); record = undefined; }
    this.updateGroup(this.channels, parsed.channel, key, record);
    this.updateGroup(this.principals, parsed.principal, key, record);
  }

  private updateGroup(index: Map<string, Rows>, group: string, key: string, record?: MembershipRecord): void {
    let rows = index.get(group);
    if (record) {
      if (!rows) index.set(group, rows = new Map());
      rows.set(key, record);
    } else if (rows) {
      rows.delete(key);
      if (rows.size === 0) index.delete(group);
    }
  }
}
