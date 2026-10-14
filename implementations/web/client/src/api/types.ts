// Wire shapes the dashboard reads. The message and presence types are core's own, re-exported so
// the client has one name for each; the rest are the server's JSON answers (src/web.ts).
import type { CotalMessage, Presence, MembershipSnapshot } from "@cotal-ai/core";

export type { CotalMessage, Presence, MembershipSnapshot };

/** A presence row as `/api/roster` serves it. `progress` is the web server's marker that a working
 *  peer's connector reports no work progress, so the page says so instead of implying motion. */
export type RosterEntry = Presence & { progress?: { kind: "unknown" } };

/** The observer's own presence watch: current, still loading, or silent since `staleSince`. */
export type PresenceView =
  | { state: "current"; fresh: true }
  | { state: "unpopulated"; fresh: false }
  | { state: "stale"; fresh: false; staleSince: number };

export interface ChannelInfo {
  channel: string;
  messages: number;
  description?: string;
  replay: boolean;
  replayWindow?: string;
  deliveryClass: "live" | "durable";
}

export type ActivityEntry =
  | { mode: "chat"; channel: string; msg: CotalMessage }
  | { mode: "unicast"; msg: CotalMessage };

/** One bounded read of `/api/activity`: what landed, and which sources did not and why. */
export interface ActivityPage {
  entries: ActivityEntry[];
  partial: boolean;
  read: number;
  of: number;
  missing: string[];
  reasons: Record<string, string>;
  deadlineMs: number;
}

export interface Meta {
  space: string;
  pid: number;
}

/** A frame on the live `/feed` stream. */
export type FeedMessage = { mode: "chat" | "unicast" | "anycast"; senderId?: string; channel?: string; msg: CotalMessage };
