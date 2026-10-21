/**
 * The live participant surface of ONE admitted chat opening (spec "Live human session" and "Program
 * participants"). This module declares the contract a native admission adapter must satisfy. It
 * contains no admission, no credential, no identity minting and no transport. Nothing here can
 * produce a session: a value of this type exists only when a reviewed per-mode admission adapter
 * (proposal.md §4, §6) returns one.
 *
 * Every method acts under the session's own bounded authority. The methods mirror the existing
 * connector-core `MeshAgent` participant methods (send, dm, anycast, setStatus, setAttention,
 * setChannelMode, joinChannel, leaveChannel, peekInbox / drainInboxDeliveries, roster, channelInfo,
 * reconnect) and `CotalEndpoint.invokeService` / `readHistory`, so an adapter wraps that engine
 * instead of building a second one. Results are classified HERE as data, never thrown, because only
 * the adapter can tell a native denial from an unknown outcome.
 */
import type { AttentionMode, ChannelMode, PresenceStatus } from "@cotal-ai/core";
import type { RefusalCode } from "@cotal-ai/workspace";

/** The auth mode the opening was admitted under. It sets which security claims output may make. */
export type SessionMode = "user" | "static" | "open";

/** What the opening is, as its admission authority recorded it. Display data only: the broker-bound
 *  principal, not the label, is the authority. No credential, secret or bearer is ever carried. */
export interface SessionIdentity {
  readonly mode: SessionMode;
  /** The resolved space this opening operates in. Display context, never inferred from its label. */
  readonly space: string;
  /** The principal dot-form `<owner>.<actor>` the admission authority assigned. */
  readonly principal: string;
  /** The opening's lifecycle UID, as admitted. Shown abbreviated in human output. */
  readonly lifecycleUid: string;
  /** The display label. Never an authority input. */
  readonly label: string;
  /** Effective channel ceilings the authority accepted, for display and local pre-checks only. The
   *  broker remains the enforcement point. */
  readonly allowSubscribe: readonly string[];
  readonly allowPublish: readonly string[];
  /** Absolute end of the opening in epoch ms, when the authority set one. */
  readonly expiresAt?: number;
}

/** A refusal before any effect, with the native cause kept beside it. */
export interface Refused {
  readonly outcome: "refused";
  readonly code: RefusalCode;
  readonly message: string;
  readonly native?: { readonly code?: string; readonly detail?: unknown };
}

/** The effect may or may not have happened. Never retried automatically. */
export interface Unknown {
  readonly outcome: "unknown";
  readonly message: string;
}

/** A read or local step that did not complete and had no effect. */
export interface Failed {
  readonly outcome: "failed";
  readonly message: string;
}

export type Result<T> = { readonly outcome: "ok"; readonly value: T } | Refused | Unknown | Failed;

/** A publication the broker's stream acknowledged. Stored is not delivered, read or answered. */
export interface Stored {
  readonly outcome: "stored";
  readonly messageId: string;
  /** The stream sequence from the publish ack, when the native call returns it. Native `unicastAttributed`
   *  and `anycastAttributed` do; native `multicast` awaits the ack but discards it (`publishMsg`), so a
   *  channel send has no sequence here. Absent means not returned, never zero. */
  readonly seq?: number;
  readonly duplicate?: boolean;
  /** For a channel send, the channel it was stored on and whether the registry knows it. */
  readonly channel?: string;
  readonly registered?: boolean;
  /** For a DM, the resolved recipient. */
  readonly recipient?: { readonly id: string; readonly name: string };
  /** For a DM, the recipient's roster status just before the publish; `unrostered` when it had no row. */
  readonly recipientStatusAtSend?: PresenceStatus | "unrostered";
  /** For anycast, the live holders at send, when the presence view was current. */
  readonly holdersAtSend?: number;
}

export type PublishResult = Stored | Refused | Unknown;

/** One received message, as the session surfaces it. Text is untrusted. */
export interface SessionMessage {
  /** The opaque per-delivery key the session acknowledges with {@link AdmittedChatSession.surfaced}. */
  readonly deliveryKey: string;
  readonly id: string;
  readonly ts: number;
  /** Derived from the delivering subject, never from the payload. */
  readonly kind: "channel" | "dm" | "anycast";
  readonly from: { readonly id: string; readonly name: string; readonly role?: string };
  readonly channel?: string;
  readonly service?: string;
  readonly text: string;
  readonly replyTo?: string;
  readonly mentionsMe: boolean;
  readonly historical: boolean;
  /** Broker delivery count above 1 means an earlier copy went unacknowledged and may have surfaced. */
  readonly deliveryCount?: number;
}

export interface RosterRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly role?: string;
  readonly status: PresenceStatus;
  readonly activity?: string;
  readonly sessionKind?: string;
}

export interface RosterView {
  readonly rows: readonly RosterRow[];
  /** `current` only when the presence watch has a complete snapshot. Otherwise the list is partial. */
  readonly view: "current" | "unpopulated" | "stale";
}

export type ConnectionState = "connected" | "disconnected" | "reconnecting" | "ended";

export interface ConnectionReport {
  readonly state: ConnectionState;
  readonly identity: SessionIdentity;
  readonly bufferedInbox: number;
  readonly joinedChannels: readonly string[];
  readonly attention: AttentionMode;
  readonly channelModes: Readonly<Record<string, ChannelMode>>;
}

export interface ChannelInfo {
  readonly channel: string;
  readonly registered: boolean;
  readonly description?: string;
  readonly instructions?: string;
  readonly replay: boolean;
  readonly readable: boolean;
  readonly postable: boolean;
}

export interface HistoryPage {
  readonly channel: string;
  readonly messages: readonly SessionMessage[];
  /** True when retention, a bound or a gap means this is not the full conversation. */
  readonly partial: boolean;
  readonly note?: string;
}

/** What closing the opening achieved. Only the adapter's native observation may set these. */
export interface CloseReport {
  /** `retired`: the authority confirmed the terminal. `requested`: asked, not confirmed.
   *  `unknown`: the request's outcome is unknown. `not-applicable`: open mode has no lifecycle. */
  readonly retirement: "retired" | "requested" | "unknown" | "not-applicable";
  /** Whether the broker connection closure was confirmed (eviction verified or own close observed). */
  readonly connectionClosed: "confirmed" | "not-confirmed";
  /** Static mode: the credential stays broker-valid until this epoch ms unless eviction was verified. */
  readonly credentialValidUntil?: number;
  readonly message: string;
}

export type SessionEvent =
  | { readonly type: "message"; readonly message: SessionMessage }
  | { readonly type: "presence"; readonly row: RosterRow; readonly change: "joined" | "updated" | "left" }
  | { readonly type: "connection"; readonly state: ConnectionState; readonly reason?: string }
  /** Messages may have been missed: a live-only channel while disconnected, a retention bound, a
   *  dropped buffer. Never presented as complete history. */
  | { readonly type: "gap"; readonly scope: string; readonly reason: string };

/**
 * One admitted opening. An adapter implements this over the existing participant engine; the CLI
 * front ends (TUI, `--stdio`) consume it and nothing else.
 */
export interface AdmittedChatSession {
  identity(): SessionIdentity;
  /** Register for events. Returns the unsubscribe. Events start after the call; no replay. */
  subscribe(listener: (event: SessionEvent) => void): () => void;

  send(text: string, channel: string, mentions: readonly string[]): Promise<PublishResult>;
  dm(to: string, text: string, replyTo?: string): Promise<PublishResult>;
  anycast(role: string, text: string): Promise<PublishResult>;

  setStatus(status: Exclude<PresenceStatus, "offline">, activity?: string): Promise<Result<void>>;
  setAttention(mode: AttentionMode): Promise<Result<void>>;
  setChannelMode(channel: string, mode: ChannelMode | "normal"): Promise<Result<void>>;
  join(channel: string): Promise<Result<{ readonly joined: boolean; readonly backfilled: number; readonly durable: boolean; readonly reason?: string }>>;
  leave(channel: string): Promise<Result<{ readonly left: boolean }>>;

  /** Buffered messages held by attention or channel mode. `peek` leaves them buffered. */
  inbox(peek: boolean): Promise<Result<readonly SessionMessage[]>>;
  roster(): Promise<Result<RosterView>>;
  channelInfo(channel: string): Promise<Result<ChannelInfo>>;
  connection(): Promise<Result<ConnectionReport>>;
  history(channel: string, limit: number): Promise<Result<HistoryPage>>;
  /** Endpoint invoke within the session's own grants. A seat-only or unbound command refuses natively. */
  invoke(endpoint: string, command: string, args: Readonly<Record<string, unknown>> | undefined, timeoutMs: number): Promise<Result<unknown>>;
  /** Reconnect THIS opening only. Never creates a new identity; refuses when it cannot keep this one. */
  reconnect(): Promise<Result<{ readonly reconnected: boolean; readonly message: string }>>;

  /** Acknowledge deliveries after they were written or shown. Unacknowledged ones redeliver. */
  surfaced(deliveryKeys: readonly string[]): void;
  /** End listening and presence, and request this opening's retirement. Idempotent. */
  close(): Promise<CloseReport>;
}
