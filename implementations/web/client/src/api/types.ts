// Wire shapes the dashboard reads. The message and presence types are core's own, re-exported so
// the client has one name for each; the rest are the server's JSON answers (src/web.ts).
import type { CotalMessage, Presence, MembershipSnapshot } from "@cotal-ai/core";

export type { CotalMessage, Presence, MembershipSnapshot };

/** A presence row as `/api/roster` serves it. `progress` is the web server's marker that a working
 *  peer's connector reports no work progress, so the working line draws no moving dots. */
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
  | { mode: "chat"; channel: string; msg: CotalMessage; arrivedAt?: number }
  | { mode: "unicast"; msg: CotalMessage; arrivedAt?: number };

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

/** What the dashboard can post as, as `/api/meta` reports it. Mirrors the server's
 *  `PostCapability` JSON; the client imports nothing from the server. */
export type PostCapability = { mode: "participant" } | { mode: "off"; reason: string };

/** `operatorId` is present once the server knows the id it posts as: from startup on a static
 *  mesh, and from the first post on an open mesh. */
export interface Meta {
  space: string;
  pid: number;
  post: PostCapability;
  operatorId?: string;
}

/** What `POST /api/send` answers for a post that went out. `seq` is a DM's stored sequence. */
export interface SendAnswer {
  ok: true;
  id: string;
  operatorId: string;
  seq?: number;
}

/** A frame on the live `/feed` stream. `arrivedAt` is not on the wire: the controller stamps it, from
 *  its own clock, when the frame reaches this page, so a view can say how long ago a message flowed
 *  without trusting the sender's clock. Entries read from history carry none. */
export type FeedMessage = { mode: "chat" | "unicast" | "anycast"; senderId?: string; channel?: string; msg: CotalMessage; arrivedAt?: number };

/** One read of an agent's event channel, `GET /api/agents/<id>/events`: its newest frame messages,
 *  oldest first, with `more` when the channel held more than were asked for. A read the broker
 *  refused is an answer, not a failure: `refused` is the broker's own text and `grant` the command
 *  that would let this dashboard read the channel, when the mesh has one. */
export type AgentEventsPage = { frames: CotalMessage[]; more: boolean } | { refused: string; grant?: string };

/** A frame message from an agent this page watches, as the `agent-frame` feed event carries it. `id`
 *  is the roster id the server took from the event channel's subject. */
export interface AgentFrame {
  id: string;
  msg: CotalMessage;
}
