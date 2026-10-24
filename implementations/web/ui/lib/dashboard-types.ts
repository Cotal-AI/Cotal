import type { OrderNote } from "./ordering";
import type { Presence } from "@cotal-ai/core";

export interface Row {
  id?: string;
  mode?: string;
  ts: string;
  who?: string;
  whoName?: string;
  role?: string;
  target?: string;
  body: string;
  status?: string;
}
export interface Channel {
  name: string;
  messages?: number;
  unread: number;
  description?: string;
  deliveryClass?: string;
  replay?: boolean;
  replayWindow?: string;
}
export interface Conversation {
  with: string;
  withName?: string;
  role?: string;
  status?: string;
  msgs: Row[];
}
export interface DMPeer {
  id: string;
  name: string;
  role?: string;
  status: string;
  threads: number;
  conversations: Conversation[];
}
export type DashboardPresence = Presence & { progress?: { kind: string } };
export interface Snapshot {
  space: string;
  connected: boolean;
  loading: boolean;
  channelDeleteSupported: boolean;
  roster: DashboardPresence[];
  counts: Record<string, number>;
  stalest: string;
  channels: Channel[];
  dmPeers: DMPeer[];
  selected: string | null;
  dmSel: { peer: string; with: string | null } | null;
  agentSel: string | null;
  agent?: DashboardPresence;
  rows: Row[];
  channelRows: Row[];
  members: string[];
  conversation?: Conversation & { peerName: string };
  waiting: { id: string; title: string; role?: string; desc: string; age: string; status: string }[];
  stale: { name: string; reason: string }[];
  orderNotes: OrderNote[];
  modes: string[];
  paused: boolean;
  expandAll: boolean;
}
export interface DashboardStore {
  getSnapshot(): Snapshot;
  subscribe(listener: () => void): () => void;
  select(channel: string): Promise<void>;
  selectAgent(id: string): void;
  selectDM(peer: string, other?: string | null): void;
  refresh(): Promise<void>;
  deleteChannel(channel: string): Promise<void>;
  setModes(modes: string[]): void;
  togglePause(): void;
  toggleExpand(): void;
  markdown(text: string): string;
}
declare global {
  interface Window {
    COTAL_PRESENCE: {
      describe(peer: DashboardPresence, now?: number): { status: string; activity: string; activityAge: string; heartbeat: string };
      heartbeatAge(ts: number, now?: number): string | undefined;
    };
    COTAL_DASHBOARD: DashboardStore;
    COTAL_HARNESS: Record<string, { label: string; paths: string[]; outline: boolean }>;
  }
}
