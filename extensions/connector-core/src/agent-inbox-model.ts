// The inbox item shapes, limits and small pure helpers the AgentInbox class works with, moved verbatim
// from agent-inbox.ts. agent-inbox.ts re-exports the ones other modules import, so their paths are unchanged.
import { createHash } from "node:crypto";
import { ANYCAST_NOTICE_KEY, MENTION_NOTICE_KEY, type CotalEndpoint, type CotalMessage, type Delivery } from "@cotal-ai/core";
import type { AgentConfig } from "./config.js";

/** A short reconnect or modest sender-clock skew must not turn a current request into history. */
export const CHANNEL_CATCHUP_AGE_MS = 5 * 60_000;


/** The endpoint and host operations the inbox reads when each call runs. */
export interface AgentInboxDeps {
  endpoint: () => CotalEndpoint;
  config: () => AgentConfig;
  transportConnected: () => boolean;
  emit: (event: "incoming" | "mention-wake", item: InboxItem) => void;
  warning: (error: Error) => void;
  noteDirected: (item: InboxItem) => void;
  inOrder: (write: () => Promise<void>) => Promise<void>;
  requireConnected: () => Promise<void>;
}


/** A message that has arrived for us, normalized for the agent to read. */
export interface InboxItem {
  id: string;
  /** Opaque per-delivery RECEIVE key (#624): the address a host uses to drain/ack THIS buffered
   *  delivery. It is the wire `id` for every message that carries one; a message whose `id` is the
   *  empty string gets a minted key, because an empty id is never a dedup key and never a
   *  selectable one. It is NOT wire identity and NOT dedup authority: nothing coalesces on it, so
   *  a redelivered copy of an id-less message mints its own key and surfaces again (at-least-once,
   *  the disclosed cost). It exists so the exact-id drains and in-flight protection can select the
   *  DELIVERY rather than an id value that two distinct messages share. */
  recvKey: string;
  ts: number;
  fromId: string;
  fromName: string;
  fromRole?: string;
  kind: "channel" | "dm" | "anycast";
  /** Set when kind === "channel". */
  channel?: string;
  /** Set when kind === "anycast" (the role addressed). */
  service?: string;
  /** Lowercased names called out on a channel message (priority hint). */
  mentions?: string[];
  /** True iff this message mentions us by name — computed once, here. Drives high-priority wake. */
  mentionsMe: boolean;
  /** True iff this is backfilled history (a "catching up" block on join), not a live message. */
  historical: boolean;
  text: string;
  replyTo?: string;
  contextId?: string;
  /** How many times the broker has delivered this copy, 1 on the first; absent on a live copy.
   *  Broker-derived, never read from the payload: above 1, an earlier delivery of this message went
   *  unacked past its ack wait. That alone does not say it reached a model: a message queued here
   *  past the wait is redelivered unseen. */
  deliveryCount?: number;
  /** The broker's count on the first copy of this message this session received, 1 for a live copy.
   *  Above 1, an earlier reader, or this session before a restart, may have shown it. */
  firstDeliveryCount?: number;
  /** The broker's count on the copy this session first handed to its host, 0 for a live copy. Below
   *  {@link deliveryCount}, that handoff was never confirmed and the broker delivered it again. */
  handedOverAt?: number;
  /** Set on a DM from the space's delivery daemon about one of this session's own role requests
   *  (`anycast`, SPEC §8.1) or about a channel post whose mention the daemon could not deliver
   *  (`mention`, SPEC §8): its sender was checked against the delivery lease holder. A notice asks
   *  for no reply and answers no question. */
  notice?: DeliveryNotice;
}

/** A bounded, non-consuming view of the currently buffered inbox for presentation-only surfaces. */
export interface InboxSnapshot {
  /** Total buffered deliveries, including rows beyond {@link items}. */
  unread: number;
  /** Oldest buffered rows, copied without receive/ack handles. */
  items: InboxItem[];
}

/** An inbox entry: the normalized message plus its JetStream ack handle. */
export interface Pending {
  item: InboxItem;
  /** Ack the backing stream message — called only once the item is actually surfaced. */
  ack: () => void;
  /** The current copy's redelivery state, and the time until which this reader can vouch it still
   *  holds that copy. Both absent on a live copy. */
  redelivery?: Delivery["redelivery"];
  ownedUntil?: number;
  /** Delivery class, set at receive time. Quiet ambient stays pull-only even if the mode later
   *  changes, and an automatic entry becomes pull-only when its channel is quieted, muted or left. */
  pullOnly: boolean;
  /** Local receive time. Distinct from `item.ts`, which is the sender's stamp. */
  receivedAt: number;
  /** Its place in this session's arrival order. A held role request keeps it while held and once
   *  taken, so it is offered and shown where it arrived. */
  arrival: number;
  /** #662: the focus tally a buffered id-less channel message is counted in, its digest there, and
   *  the copy it is counted as. Evicting it un-counts that copy only, so recall can hand its stream
   *  copy back while an identical copy with another disposition stays counted. */
  idless?: { tally: Map<string, IdlessTally>; digest: string; copy: IdlessCopy };
  /** A role request on an auth mesh (SPEC §8.1): the take of the current copy, the take in flight,
   *  and the delivery count a recorded take is for. Such an entry is shown only once its take of
   *  the copy it holds is recorded. */
  take?: Delivery["take"];
  taking?: Promise<void>;
  /** The link drops counted when {@link taking} began. A take that began before the latest drop is
   *  the old link's, so a read asks again instead of waiting on it. */
  takingDrops?: number;
  takenCount?: number;
  /** A take was recorded for it once, so a host may have shown it. Only such an entry is acked from
   *  the held set by an exact drain. */
  takenOnce?: boolean;
  /** How many reads are waiting on its take in {@link AgentInbox.takeChosen}. Such a read shows the
   *  request itself, so its admission is announced as an arrival only when no read waits. */
  awaited?: number;
}

/** #662: the copies of one id-less channel message (by content) a focus episode has settled
 *  locally. A live copy carries no stream sequence, so recall binds each settled copy to one
 *  retained stream copy at or below its frontier the first time a read can see it, and two
 *  identical copies never share a sequence. A tally with nothing left in it is deleted. */
export interface IdlessTally {
  channel: string;
  /** Settled copies no read has bound yet. */
  unbound: IdlessCopy[];
  /** Stream sequences of the copies settled here or handed back. */
  bound: Set<number>;
}

/** #662: one settled id-less copy. Its stream copy is at or below the chat stream's last sequence
 *  read after it arrived. While the connection stays up, every stream copy at or below that read
 *  reached this session before the read answered, so the read bounds no copy sent in a reconnect
 *  gap. A read that answers only after the connection dropped bounds nothing. */
export interface IdlessCopy {
  /** The recall epoch it was settled in. */
  epoch: number;
  /** The chat stream's last sequence read after it arrived, once that read answers on the same
   *  connection. */
  frontier?: number;
  /** Settles when that read answers or fails. Never rejects. */
  ready: Promise<void>;
  /** The stream sequence a read bound it to. */
  seq?: number;
  /** The inbox evicted it before a read bound it. It keeps its place in arrival order, and the
   *  stream copy a read binds it to is left for recall to hand back. */
  evicted?: boolean;
}

/** Where a session's focus-mode recall has been read to: a timestamp plus the id that breaks its ties. */
export interface RecallMark {
  ts: number;
  id: string;
}

/** Total order on {@link RecallMark}: by time, then by id, so items sharing a millisecond still queue. */
export function afterRecallMark(a: RecallMark, b: RecallMark): boolean {
  // #624: recall marks and items are addressed by RECEIVE key (never the wire id), and a minted
  // key is never the empty string, so the tie-break comparator never sees an empty id on either
  // side: the only empty id in a RecallMark is the initial cursor {ts: 0, id: ""}, whose ts
  // differs from every real item and so never reaches the id comparison. (The empty-id guard this
  // comparator once carried was removed after a root chase showed it unreachable: with the wire id
  // out of the marks, no real path can put two empty ids, or an empty id against a real one, into
  // the comparison.)
  return a.ts !== b.ts ? a.ts > b.ts : a.id > b.id;
}

/** How many pending messages one session buffers before the overflow valve in
 *  {@link AgentInbox.buffer} evicts. Exported so the overflow smokes read the bound they exercise. */
export const MAX_INBOX = 200;
/** How long {@link AgentInbox.takeChosen} waits for the delivery daemon before it lets a caller show
 *  what is already taken. A take not decided by then stays held for a later read. */
export const TAKE_WAIT_MS = 2_000;
/** How long a role request whose take could not be decided waits before it is asked about again. */
export const TAKE_RETRY_MS = 10_000;
/** How many receive keys {@link AgentInbox.holdInFlight} protects at once. The overflow valve never
 *  evicts a held entry, so this ceiling also bounds the inbox while holds are open, which is why it
 *  is derived from {@link MAX_INBOX}. It sits above the inbox because a frame keeps its holds until
 *  its own verdict, even on entries an overlapping frame has already committed. */
export const MAX_IN_FLIGHT = MAX_INBOX * 2;
/** How many future-stamped recall ids one session will remember having handed over. See
 *  {@link AgentInbox.recallAheadRoom}. */
export const MAX_AHEAD = 256;
/** How many overflow-evicted ambient messages {@link AgentInbox.evictedClassifications} remembers
 *  the class of. */
export const CLASSIFICATION_CAP = 4096;
/** How many ids one focus episode keeps out of recall in {@link AgentInbox.focusExcludedIds}, and,
 *  bounded separately, how many id-less copies it counts in {@link AgentInbox.focusIdlessEntries}. */
export const FOCUS_EXCLUSION_CAP = 4096;
/** #662: history reads one channel's recall makes while an id-less copy keeps arriving mid-read. */
export const IDLESS_READS = 3;
/** How many ids each of {@link AgentInbox.protectedPullOnlyIds} and
 *  {@link AgentInbox.protectedDropIds} holds. */
export const PROTECTED_DISPOSITION_CAP = 4096;

export type InboxScope = "all" | "automatic" | "pull-only";

export interface ExactDrainResult {
  items: InboxItem[];
  missingKeys: string[];
}

/** What a delivery daemon's notice is about. */
export type DeliveryNotice = "anycast" | "mention";

/** Which delivery daemon notice part a DM carries, anycast (SPEC §8.1) or mention (SPEC §8), if any.
 *  Its sender is still to be checked against the delivery lease. */
export function deliveryNoticeOf(m: CotalMessage): DeliveryNotice | undefined {
  for (const p of m.parts) {
    if (p.kind !== "data" || typeof p.data !== "object" || p.data === null || Array.isArray(p.data)) continue;
    if (ANYCAST_NOTICE_KEY in p.data) return "anycast";
    if (MENTION_NOTICE_KEY in p.data) return "mention";
  }
  return undefined;
}

/** #662: what an id-less channel delivery shares with its stream copy. Both are the same published
 *  bytes, read through the same authentication, so their content is all that links them. */
export function idlessDigest(m: CotalMessage): string {
  return createHash("sha256").update(JSON.stringify(m)).digest("base64url");
}

/** Record that this session handed the item's current copy to its host: a take for showing, or a
 *  hold for a frame. Only the first handoff is kept, so a frame built before or after its own hold
 *  reads the same record, and a later copy reads an earlier handoff that was never confirmed. */
export function handOver(item: InboxItem): void {
  item.handedOverAt ??= item.deliveryCount ?? 0;
}

/** The dedup key a received message id contributes to ingest's coalescing, or undefined when the id
 *  is EMPTY: an empty id is never a dedup key (#624). Undefined means "no identity to coalesce on",
 *  so every id-keyed lookup in {@link AgentInbox.ingest} is skipped for such a message and it flows to
 *  the buffer on its own merits. Real ids are returned unchanged: their coalescing (live/durable
 *  copies of one message, and redelivery after handle) is untouched. */
export function ingestDedupKey(id: string): string | undefined {
  return id === "" ? undefined : id;
}
