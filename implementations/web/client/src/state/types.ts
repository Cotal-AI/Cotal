// The shape of the dashboard's state. The controller is its only writer.
import type {
  ActivityEntry,
  ChannelInfo,
  CotalMessage,
  FeedMessage,
  MembershipSnapshot,
  PresenceView,
  RosterEntry,
} from "../api/types.js";
import type { OrderNote } from "../lib/eventOrder.js";
import type { StaleMark } from "../lib/snapshot.js";

/** A channel row. A live message can name a channel before the next `/api/channels` read does, so
 *  such a row carries its count and nothing else: its policy is unknown until the server says it. */
export type ChannelRow = Pick<ChannelInfo, "channel" | "messages"> & Partial<Omit<ChannelInfo, "channel" | "messages">>;

/** A message as the dashboard keeps it in a channel view or the DM list: the payload, and the
 *  publisher the server verified from the subject when it knows one. Only the live feed carries
 *  `senderId`; core's history reads do not return the subject, so a row read from history has none
 *  and nothing fills it in from the payload's own `from`. */
export interface StoredMessage {
  msg: CotalMessage;
  senderId?: string;
}

export interface DashboardState {
  space: string | null;
  connected: boolean;
  roster: RosterEntry[];
  presenceView: PresenceView | null;
  channels: ChannelRow[];
  unread: Record<string, number>;
  /** Newest last, capped at 500. The backfill holds chat and unicast entries; the live feed adds
   *  anycast too, with its verified `senderId`. */
  activity: (ActivityEntry | FeedMessage)[];
  dms: StoredMessage[];
  open: { channel: string; messages: StoredMessage[] } | null;
  stale: StaleMark[];
  /** Newest last, capped at 50. */
  orderNotes: OrderNote[];
  membership: { snapshot?: MembershipSnapshot; unreadable?: string };
}

export const initialState: DashboardState = {
  space: null,
  connected: false,
  roster: [],
  presenceView: null,
  channels: [],
  unread: {},
  activity: [],
  dms: [],
  open: null,
  stale: [],
  orderNotes: [],
  membership: {},
};
