// The shape of the dashboard's state. The controller is its only writer.
import type {
  ActivityEntry,
  ChannelInfo,
  CotalMessage,
  FeedMessage,
  MembershipSnapshot,
  PostCapability,
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

/** The live feed's state as the pill says it. `connecting` until the feed first opens, `connected`
 *  while it is open, `reconnecting` after it dropped while the browser retries, and `closed` once the
 *  browser has failed it for good and will not retry. */
export type Connection = "connecting" | "connected" | "reconnecting" | "closed";

/** A post the composer sent. `id` is unset while the server has not answered, which is when the row
 *  shows faded, and set once it went out, until the feed delivers the message itself. `seq` keys the
 *  row. */
export interface Outgoing {
  seq: number;
  text: string;
  ts: number;
  id?: string;
}

/** One composer's state: the text in the box, the refusal of its last post, and its posts the views
 *  do not show yet. A refused post's text is back in `text`. */
export interface Draft {
  text: string;
  refused?: string;
  outgoing: Outgoing[];
}

export interface DashboardState {
  space: string | null;
  connection: Connection;
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
  /** The first reads the page is still waiting on, true until that source's data lands. The shell
   *  draws skeleton rows while either is outstanding. A store starts with nothing outstanding;
   *  `startDashboard` marks both as it starts, and the controller clears each when its read applies
   *  or, for the roster, when the feed delivers one. A refused read clears nothing: the page has no
   *  data to show, and the stale marker says why while the read is retried. */
  loading: { roster: boolean; channels: boolean };
  /** What the dashboard can post as, null until `/api/meta` answers. */
  post: PostCapability | null;
  /** The id the operator posts as, from whichever of `/api/meta` and a post's answer says it first. */
  operatorId: string | null;
  /** By `composeKey`. */
  drafts: Record<string, Draft>;
}

export const initialState: DashboardState = {
  space: null,
  connection: "connecting",
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
  loading: { roster: false, channels: false },
  post: null,
  operatorId: null,
  drafts: {},
};
