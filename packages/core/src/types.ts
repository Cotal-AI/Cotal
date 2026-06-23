/**
 * Cotal wire types (v0.2).
 *
 * These are the shapes that travel on the mesh. They are intentionally A2A-inspired
 * (AgentCard / Message / Part) but transport-agnostic. This file IS part of the
 * "wire contract" — treat changes here as protocol changes.
 */

export type EndpointKind = "agent" | "endpoint";

export interface AgentSkill {
  id: string;
  name: string;
  description?: string;
}

/** A2A-inspired identity record for an endpoint or agent. */
export interface AgentCard {
  /** Unique, stable for the lifetime of this connection. */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** 'agent' (participates in coordination) or a plain 'endpoint' (logger, dashboard…). */
  kind: EndpointKind;
  /** Cotal addition: the role this participant plays (planner, reviewer, …). */
  role?: string;
  /** A2A-style one-line summary of what this agent does (discovery / observability). */
  description?: string;
  /** Cotal: free-form "what it can do" tags (A2A skill-tags, flattened) — discovery only. */
  tags?: string[];
  skills?: AgentSkill[];
  meta?: Record<string, unknown>;
  /** Wire-contract version this participant speaks (the SPEC.md version, `"0.2"` today). A change
   *  signal, not negotiation: v0 has none, but a peer can detect a mismatch instead of silently
   *  misreading a future envelope. Omitted ⇒ assume the v0.x line. */
  protocolVersion?: string;
}

/**
 * Lifecycle status of a participant.
 * - `idle`: connected, no active task
 * - `waiting`: blocked — awaiting input, approval, or a peer
 * - `working`: actively executing a task / in a turn
 * - `offline`: disconnected or heartbeat lapsed (derived by observers, not self-set while live)
 */
export type PresenceStatus = "idle" | "waiting" | "working" | "offline";

/**
 * How aggressively peer traffic interrupts an agent — chosen by the agent, orthogonal to
 * {@link PresenceStatus}. Defined here (the wire layer) because it is now published in
 * {@link Presence}; the connector imports it. Advisory observability, not a security boundary.
 */
export type AttentionMode = "open" | "dnd" | "focus";

/**
 * Per-channel attention override (more specific than the global {@link AttentionMode}).
 * - `quiet` — still delivered + buffered, but never wakes; an `@`-mention still wakes (per-channel `dnd`).
 * - `muted` — channel messages dropped on receive, incl. `@`-mentions ("don't receive this channel").
 */
export type ChannelMode = "quiet" | "muted";

/** Live presence record. Stored in the space's KV bucket under key = card.id. */
export interface Presence {
  card: AgentCard;
  status: PresenceStatus;
  /** Freeform "what I'm doing right now". */
  activity?: string;
  /** This instance's current global attention mode. Advisory, within-space observability — a peer
   *  can see "they're in focus" and choose to DM. Published from the connector's authoritative state
   *  (presence is a mirror, never the source of truth for delivery). `open`/absent ⇒ receives all. */
  attention?: AttentionMode;
  /** Per-channel attention overrides this instance currently has (runtime, reset on restart). Keys are
   *  concrete channel names. Advisory: lets a peer see "locally muted #deploys → DM to reach me". NOT
   *  access control — the broker still authorizes and delivers; this is a receive-side presentation. */
  channelModes?: Record<string, ChannelMode>;
  /** Epoch ms of the last heartbeat. */
  ts: number;
}

/**
 * A channel's delivery class (SPEC §4). Fixed per channel, wire-observable.
 * - `live` — native broker-subscription delivery; **at-most-once** (only instances subscribed at
 *   publish time receive it; a disconnected/busy/not-yet-joined instance has no claim to it later).
 * - `durable` — `live` plus a per-subscriber durable backstop; **at-least-once for current members**
 *   (also retained per member and redelivered on the member's next connection/turn until acked).
 *
 * Effective class is {@link effectiveDeliveryClass}: `channel ?? space default ?? "durable"`. The
 * space default is set at space creation from the deployment profile (local/self-hosted ⇒ `durable`,
 * public/web-scale ⇒ `live`) so it is always discoverable on the wire, never inferred per-component.
 */
export type DeliveryClass = "live" | "durable";

/**
 * Channel registry entry — channel-global config, stored in the per-space channels KV
 * (one entry per channel; the space-wide default lives under {@link CHANNEL_DEFAULTS_KEY}).
 * Shared across every peer, not a per-subscriber choice. `description`/`instructions` reach
 * the model, so this is a prompt-injection surface: writes are privileged and both text
 * fields are length-bounded at the write path (see channels.ts).
 */
export interface ChannelConfig {
  /** Override the space default for history replay-on-join. */
  replay?: boolean;
  /** How far back a joiner's backfill reaches — a duration like `"24h"`, `"30m"`, `"7d"`.
   *  Bounds the join-backfill read horizon (now − window) on the pinned single-filter `chathist`
   *  history consumer. Unset + `replay` ⇒ the full retained window; ignored when replay is off. */
  replayWindow?: string;
  /** Override the space default delivery class (SPEC §4, §7). See {@link DeliveryClass}. */
  deliveryClass?: DeliveryClass;
  /** One-line "what this channel is for". */
  description?: string;
  /** Longer "how to use it" — surfaced to joiners as advisory, attributed data. */
  instructions?: string;
}

/** Space-wide channel defaults, stored under {@link CHANNEL_DEFAULTS_KEY}. */
export interface ChannelDefaults {
  replay?: boolean;
  replayWindow?: string;
  /** Default delivery class for channels without an explicit one. Written at space creation from
   *  the deployment profile (local ⇒ `durable`, web ⇒ `live`); see {@link DeliveryClass}. */
  deliveryClass?: DeliveryClass;
}

/**
 * Durable-membership state (Plane-3, SPEC §7). One {@link MembershipRecord} per (concrete channel,
 * owner) in the privileged members registry KV.
 * - `live-confirmed` — the owner is live-subscribed (core-sub / boot durable); no Plane-3 backstop.
 *   Fan-out does NOT target these (their durability, if any, is the legacy tail until Stage 5).
 * - `durable-active` — a Plane-3 durable backstop is established for this (channel, owner). Fan-out
 *   targets these; the trusted reader re-authorizes each entry against the interval below.
 */
export type MembershipState = "live-confirmed" | "durable-active";

/**
 * A durable-membership record (privileged write only; agent-authored membership is forbidden —
 * it would self-authorize delivery + reads). Eligibility is by **CHAT stream sequence**, never
 * wall-clock: a `durable-channel` entry is deliverable to this owner iff
 * `joinCursor < seq <= leaveCursor` (open leave ⇒ no upper bound) — SPEC §7 L355-356. `leaveCursor`
 * present ⇒ this is a tombstone (kept through the retention horizon so late entries are denied
 * deterministically); a rejoin bumps {@link generation} and takes a fresh {@link joinCursor}.
 */
export interface MembershipRecord {
  /** Concrete channel (never a wildcard — wildcard ACLs grant live breadth, durable is per-channel). */
  channel: string;
  /** Owner agent id (nkey). */
  owner: string;
  state: MembershipState;
  /** CHAT stream seq captured at join — durable eligibility is `seq > joinCursor`. */
  joinCursor: number;
  /** True only once activation catch-up has COMPLETED. A **completeness/reporting** flag, NOT a delivery
   *  gate: {@link durableEligible} is pure membership-interval, so a `durable-active` record routes
   *  in-interval immediately (no live message is lost during catch-up). `activated` instead gates what is
   *  REPORTED — `durableJoin` returns `durable:true` and `channelMembers()` lists the owner only once
   *  catch-up confirms; a join whose catch-up never completes reports `durable:false`, stays hidden, and
   *  is tombstoned on eviction so it does not route. A tombstone preserves the `activated` it had at leave. */
  activated?: boolean;
  /** CHAT stream seq captured at leave — eligibility upper bound `seq <= leaveCursor`. Present ⇒
   *  tombstone. Absent ⇒ open membership (no upper bound). */
  leaveCursor?: number;
  /** Bumped each (re)join. Stale-write guard (with the KV revision CAS) + idempotency-key component
   *  for fan-out/catch-up (`<msgId>:<owner>:<generation>`). */
  generation: number;
  /** The privileged writer's id (audit; never an agent). */
  writerIdentity: string;
  /** Epoch ms of the last write (diagnostics only — eligibility is seq, never this). */
  updatedAt: number;
}

/**
 * A durable read-ACL record (privileged write only — the manager records it at mint; agent-authored
 * ACLs are forbidden, they would self-authorize reads). One per OWNER in the `cotal_acl_<space>` KV.
 * The delivery daemon's trusted reader re-authorizes each durable entry against `allowSubscribe`, and
 * validates a runtime durable-join against it (channel ∈ `allowSubscribe`). Written ATOMICALLY (a
 * single CAS put of the whole value) so a present record is always complete: a present
 * `allowSubscribe: []` is a known "reads nothing" decision (DROP), distinct from an ABSENT record
 * (unknown owner — DEFER, never drop).
 */
export interface AclRecord {
  /** The owner's current read ACL — the channels/patterns it may read (its `allowSubscribe`). */
  allowSubscribe: string[];
  /** Bumped each write; stale-write guard companion to the KV revision CAS. */
  revision: number;
  /** Epoch ms of the last write (diagnostics only). */
  updatedAt: number;
}

/**
 * A fan-out entry in an owner's mixed pre-auth inbox (`dinbox.<owner>`, Plane-3). The fan-out writer
 * copies one of these per eligible owner; the trusted reader re-authorizes it (`channel`+`seq` against
 * the membership interval for `durable-channel`, ACL-only for `live-mention`) before transferring the
 * embedded `msg` to the owner's DELIVER store. `seq`/`reason`/`generation` are the re-auth metadata;
 * the agent never sees this envelope (it receives only `msg` on `dlv.<owner>`).
 */
export interface Plane3Entry {
  msg: CotalMessage;
  /** Concrete channel the message was published on (the re-auth subject). */
  channel: string;
  /** The message's CHAT stream sequence (membership-interval re-auth). */
  seq: number;
  /** Why this owner was fanned to: a `durable` channel's member (interval-gated) vs a `live` channel
   *  `@mention` to an authorized target (ACL-only, no membership). */
  reason: "durable-channel" | "live-mention";
  /** The owner's membership generation at fan-out (idempotency-key component + diagnostics). */
  generation: number;
}

/**
 * One agent's derived channel-membership record (the broker-authoritative graph feed, stored per-agent
 * in `cotal_membership_<space>` under {@link membershipKey}; privileged-write, admin/observer-read).
 * The UNION of the two halves the broker can prove: `live` core-subscriptions (from CONNZ) and `durable`
 * memberships (from the Plane-3 members registry). NOT self-reported — sourced from the broker, so it
 * shows silent readers and covers `live` channels that keep no enumerable roster. **Display-only**: it
 * MUST never be an input to any delivery / ACL / authorization decision (that bounds the writer's blast
 * radius to dashboard integrity).
 */
export interface ChannelMembership {
  /** Channel-subscription patterns from the broker's live connection view (CONNZ), **wildcards kept**
   *  (e.g. `team.>`) — expanded to concrete channels only by the consumer at read time, so a channel
   *  *creation* never rewrites a wildcard-subscriber's record. Empty when the agent has no live connection. */
  live: string[];
  /** Concrete durable channels from the privileged members registry (authoritative for the durable arm,
   *  incl. reconnect-grace) — a member here whose presence is offline is "member, currently offline". */
  durable: string[];
  /** Epoch ms this record was last (re)written — a per-agent "last changed" caption. Feed-wide freshness
   *  is the separate {@link MEMBERSHIP_FEED_KEY} heartbeat (refreshed every poll); ordering is the native
   *  KV revision. */
  observedAt: number;
}

/** One agent's membership record keyed by its id — a {@link ChannelMembership} with the agent id folded
 *  in (the KV key), for the dashboard snapshot/SSE. */
export interface MembershipEntry extends ChannelMembership {
  /** The agent nkey (`card.id`) — resolve to name/role/status via presence at the dashboard. */
  id: string;
}

/** The broker-sourced membership feed as the dashboard consumes it. */
export interface MembershipSnapshot {
  /** Feed freshness — epoch ms of the daemon's last successful poll (the heartbeat key). Undefined when
   *  the feed has never been written (no daemon / pre-feature space → the graph degrades to traffic-only). */
  asOf?: number;
  members: MembershipEntry[];
}

/** Reverse-DNS extension part kind, e.g. `com.acme.snapshot`.
 * @pattern ^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$ */
export type ExtensionPartKind = `${string}.${string}`;

export type Part =
  | { kind: "text"; text: string }
  | { kind: "data"; data: unknown }
  | { kind: ExtensionPartKind; [key: string]: unknown };

export interface EndpointRef {
  id: string;
  name: string;
  role?: string;
}

interface CotalMessageBase {
  /** Unique message id. */
  id: string;
  /** Epoch ms. */
  ts: number;
  space: string;
  from: EndpointRef;
  /** Lowercased peer names called out within a `channel` message — a wake hint that also, on a
   *  `live` channel, routes a durable copy to each mentioned target **authorized to read that
   *  channel** (SPEC §4/§5). It never carries content outside the target's read ACL and is not a
   *  routing substitute for `channel`/`to`; the message still multicasts to the whole channel.
   *  Omitted when empty. */
  mentions?: string[];
  parts: Part[];
  /** Id of the message being replied to. */
  replyTo?: string;
  /** Conversation / thread correlation id. */
  contextId?: string;
}

/** A message on the mesh (chat / direct message for now; extensible to other families). */
export type CotalMessage =
  | (CotalMessageBase & {
      /** Channel name — multicast (broadcast to everyone on the channel). */
      channel: string;
      to?: never;
      toService?: never;
    })
  | (CotalMessageBase & {
      /** Instance id — unicast (direct to one specific endpoint). */
      to: string;
      channel?: never;
      toService?: never;
    })
  | (CotalMessageBase & {
      /** Service / role — anycast (any one instance of the service receives it). */
      toService: string;
      channel?: never;
      to?: never;
    });

export type PresenceEvent =
  | { type: "join"; presence: Presence }
  | { type: "update"; presence: Presence }
  | { type: "offline"; presence: Presence };

/** Context delivered as the 3rd arg of a "message" event. `historical` marks a message
 *  replayed from a channel's backlog on join (a "catching up" block) vs a live message —
 *  so a joiner doesn't act on a resolved 2-hour-old thread as if it were live. */
export interface MessageMeta {
  historical: boolean;
  /** Authenticated message class, derived from the **delivering NATS subject** (NOT the
   *  forgeable payload routing fields `to`/`toService`). `channel` = multicast (chat.*),
   *  `dm` = unicast (inst.*), `anycast` = a role's work-queue (svc.*). This is the only
   *  trustworthy "how was this addressed to me" signal: a peer can put your id in payload
   *  `to`, but it cannot publish on your private DM subject — so directedness rides this,
   *  never the payload. */
  kind: "channel" | "dm" | "anycast";
}

/**
 * Delivery control handed to "message" listeners alongside each {@link CotalMessage}.
 * The message stays on its JetStream stream until {@link Delivery.ack} is called — so
 * ack ONLY once the message has actually been surfaced (printed, injected, handled).
 * A crash before ack redelivers it.
 */
export interface Delivery {
  /** Mark the message handled; advances this reader's bookmark so it won't redeliver. */
  ack(): void;
  /** Decline for now; the message redelivers (e.g. couldn't surface it yet). */
  nak(): void;
  /** Whether {@link ack} actually COMMITS this copy (durable backstop / JetStream, at-least-once)
   *  or is a no-op (live core-sub / history backfill, at-most-once). A receiver coalescing a
   *  cross-path duplicate must NOT downgrade a durable ack to a live no-op — else the durable copy
   *  is never committed, JetStream redelivers it, and it double-surfaces. See {@link DeliveryClass}. */
  durable: boolean;
}

/** Control-plane request/reply (e.g. CLI → manager). */
export interface ControlRequest {
  op: string;
  args?: Record<string, unknown>;
  from: EndpointRef;
}

export type ControlRequestInit = Omit<ControlRequest, "from"> & { from?: EndpointRef };

export interface ControlReply {
  ok: boolean;
  data?: unknown;
  error?: string;
}
