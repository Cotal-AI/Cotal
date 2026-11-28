import { EndpointHistory, type ChannelHistoryPageOptions } from "./endpoint-history.js";
export { MULTI_FILTER_BATCH, MULTI_FILTER_READ_CONCURRENCY } from "./endpoint-history.js";
import { type NativeConnectionBinding } from "./native-connection.js";
import { EventEmitter } from "node:events";
import {
  type NatsConnection,
} from "@nats-io/transport-node";
import {
  responderFromLease,
  responderFromProbe,
  type LivenessAnswer,
  type LivenessPlane,
  type ResponderState,
} from "./liveness.js";
import { EndpointPresence, type CardMetaChanges, type PresenceView } from "./endpoint-presence.js";
export { PresenceWriteStuckError, type CardMetaChanges, type PresenceView } from "./endpoint-presence.js";
import { BIND_SPLIT_REISSUES, resolveService, type ResolvedService, type SubmitAndFollowGoalOptions } from "./endpoint-invoke.js";
import { EpEnvelopeError, respondedButUnbound, replyRefusedBeforeEffect, replyTargetUnmapped } from "./endpoint-envelope.js";
import { isRepeatSafeCommand } from "./endpoint-grants.js";
import type { EpCaller, EpPrincipal, IssuedCaller, PrincipalAuthority } from "./endpoint-subjects.js";
import { type EpPrincipalCommandDef } from "./endpoint-serve.js";
import { epPrincipalCall } from "./endpoint-call.js";
import type { EndpointReply } from "./endpoint-envelope.js";
import type { CompiledContract } from "./schema-profile.js";
import { issuedPermitsSubject } from "./issued-authority.js";
import type { RegistryEndpointsInput, RegistryEndpointsOutput } from "./registry-contract.js";
import { listRegistryEndpoints } from "./registry-client.js";
import type { EpVerbTarget, EpAttributedReply } from "./endpoint-verbs.js";
import { isJetStreamMissing } from "./jetstream-missing.js";
import { assertValidName } from "./resolve.js";
import {
  JetStreamApiCodes,
  type JetStreamManager,
  type Consumer,
} from "@nats-io/jetstream";
import { type PushConsumer } from "@nats-io/jetstream";

import type {
  AgentCard,
  ChannelConfig,
  ControlReply,
  ControlRequest,
  ControlRequestInit,
  EndpointRef,
  Part,
  Presence,
  PresencePrompts,
  PresenceAgentEndpoint,
  PresenceStatus,
  PresenceCondition,
  AttentionMode,
  ChannelMode,
  CotalMessage,
  DmHistoryRead,
  HistoryMessage,
  DeliveryClass,
  MembershipChange,
  MembershipSnapshot,
} from "./types.js";
import type { DeliveryLeaseInfo, ManagerLeaseInfo } from "./lease.js";
import { EndpointDeliveryLease } from "./endpoint-delivery-lease.js";
import { EndpointDeliveryPlane, type MaybePromise } from "./endpoint-delivery-plane.js";
import { EndpointControlPlane } from "./endpoint-control-plane.js";
import { EndpointMessaging } from "./endpoint-messaging.js";
import { EndpointDurableBackstop } from "./endpoint-durable-backstop.js";
import { EndpointDurable } from "./endpoint-durable.js";
import { EndpointAnycast } from "./endpoint-anycast.js";
import { EndpointConsumers } from "./endpoint-consumers.js";
import { EndpointPrincipalServe } from "./endpoint-principal-serve.js";
import { EndpointSubscriptions, membershipConsumerReleased } from "./endpoint-subscriptions.js";
import { EndpointChannelDiscovery } from "./endpoint-channel-discovery.js";
import { EndpointLiveness } from "./endpoint-liveness.js";
import { EndpointCredentials } from "./endpoint-credentials.js";
import { EndpointReconnect } from "./endpoint-reconnect.js";
import { EndpointConnection } from "./endpoint-connection.js";
import { EndpointProvisioning } from "./endpoint-provisioning.js";
import { EndpointBootMemberships } from "./endpoint-boot-memberships.js";
import type { EndpointParts } from "./endpoint-parts.js";
import { isRecord } from "./endpoint-inbound.js";
import { isCasLoss } from "./endpoint-records.js";
import type { EndpointIdentity } from "./endpoint-identity.js";
import { newConnectionState, type ConnectionState } from "./endpoint-connection-state.js";
import { newLifecycleState, type LifecycleState } from "./endpoint-lifecycle-state.js";
import { newCredentialState, type CredentialState } from "./endpoint-credential-state.js";
import { newChannelRegistryState, type ChannelRegistryState } from "./endpoint-channel-registry-state.js";
import { newDeliveryState, type DeliveryState } from "./endpoint-delivery-state.js";
import type { AnycastStatus } from "./anycast-requests.js";
import {
  MEMBERSHIP_FEED_KEY,
  spaceWildcard,
} from "./subjects.js";

import { isPermissionDenied } from "./permission-denied.js";
export { isPermissionDenied };
import {
  isPublishPermissionDenied,
  kvWatchConsumer,
} from "./endpoint-dial.js";
export {
  DEFAULT_SERVER,
  isPublishPermissionDenied,
  wsServers,
  defaultProbeTimeoutMs,
  dialerFor,
  isAuthRejection,
  isReachable,
  type ProbeResult,
  probeConnect,
} from "./endpoint-dial.js";
import {
  resolveEndpointPrincipal,
  resolveEndpointSettings,
  type PrincipalServeIntent,
  type EndpointOptions,
  type TransportState,
  type ChannelMember,
  type HistoryPage,
  type PrincipalServe,
} from "./endpoint-options.js";
export {
  deliveryLimitOf,
  DEFAULT_SPACE,
  type EndpointOptions,
  type ChannelMember,
  type DmOnlyOptions,
  DmDurableMissingError,
  DmBindRefusedError,
  type TransportState,
  type HistoryPage,
  fitHistoryPage,
  type PrincipalServe,
} from "./endpoint-options.js";
import {
  historyMessageFromDelivery,
  isUsableMessageId,
  isFromSubjectSender,
  authenticatedMessage,
} from "./endpoint-messages.js";
export {
  isFromSubjectSender,
} from "./endpoint-messages.js";

/** The principal endpoint each `{space, runtime id, endpoint}` is served by in this process. Two
 *  would subscribe the same subject and both answer one request (SPEC 13.21). */
const principalServers = new Map<string, PrincipalServeIntent>();

export class CotalEndpoint extends EventEmitter {
  readonly card: AgentCard;
  readonly space: string;
  readonly channels: string[];

  /** Identity and configuration fixed at construction. The constructor fills it; the parts hold it
   *  by reference and read it when they use it. */
  private readonly identity = { userMode: false } as EndpointIdentity;
  /** The connection and every handle opened on it. The connection part writes it, the rebuild writes it
   *  back, and the parts hold it by reference and read a field when they use it. */
  private readonly conn: ConnectionState = newConnectionState();
  /** Start, stop and rebuild state. The parts hold it by reference and read a field when they use it. */
  private readonly lifecycle: LifecycleState = newLifecycleState();
  /** The presented credential and its renewal. The parts hold it by reference and read a field when they use it. */
  private readonly cred: CredentialState = newCredentialState();
  /** The channel registry this endpoint has read. The parts hold it by reference and read a field when they use it. */
  private readonly channelRegistry: ChannelRegistryState = newChannelRegistryState();
  /** Subscriptions, consumers and responders on the connection. The parts hold it by reference and read a field when they use it. */
  private readonly delivery: DeliveryState = newDeliveryState();
  /** The parts, filled at the end of the constructor once every part exists. Parts read a peer from it at use. */
  private readonly parts = {} as EndpointParts;
  /** The plane-3 delivery daemon side of this endpoint (fan-out writer, trusted reader, control
   *  responders) and the agent's DELIVER pump. Every dependency is read when it is used. */
  private readonly deliveryPlane: EndpointDeliveryPlane = new EndpointDeliveryPlane(this.identity, this.conn, this.lifecycle, this.cred, this.delivery, {
    maxPayload: () => this.maxPayload,
    notLiveMsg: (...args) => this.notLiveMsg(...args),
    emit: (event, ...args) => this.emit(event, ...args),
  }, this.parts);
  private readonly history = new EndpointHistory(this.identity, this.conn, {
    notLiveMsg: () => this.notLiveMsg(),
    requireLifecycleUid: (operation) => this.requireLifecycleUid(operation),
    emit: (event, ...args) => this.emit(event, ...args),
    decodeHistory: historyMessageFromDelivery,
    isRecord,
    isUsableMessageId,
    isFromSubjectSender,
    authenticatedMessage,
    isPublishPermissionDenied,
  }, this.parts);
  private readonly deliveryLease = new EndpointDeliveryLease(this.identity, this.conn, this.lifecycle, {
    notLiveMsg: () => this.notLiveMsg(),
    deleteWatchConsumer: (iter) => this.deleteOwnConsumer(kvWatchConsumer(iter)),
    recoverable: (error) => this.emitRecoverable(error),
    emit: (event, error) => this.emit(event, error),
  });
  private readonly presence = new EndpointPresence(this.identity, this.conn, this.lifecycle, {
    notLiveMsg: () => this.notLiveMsg(),
    emit: (event, value) => this.emit(event, value),
    recoverable: (error) => this.emitRecoverable(error),
    isPublishPermissionDenied,
  }, this.parts);
  private stopPromise?: Promise<void>;

  /** True when {@link actor} was SELF-MINTED at construction — a fresh random token, because the
   *  card declared no actor and no id and no creds named one. Such a principal differs on every
   *  restart, so nothing can be granted to it in advance and nothing durable may be keyed on it.
   *  Exposed via {@link actorIsEphemeral} so a caller deriving a per-agent resource name can refuse
   *  the mode instead of silently keying on a value that will not survive the process. */
  readonly actorIsEphemeral: boolean;

  /** This endpoint's wire principal (owner + actor tokens, §13.2) — what its minted grant rows
   *  pin. Public so a caller can build owner-mode target blocks for {@link invokeService}. */
  get principal(): { owner: string; actor: string } {
    return { owner: this.identity.owner, actor: this.identity.actor };
  }

  /** Class-queue splits this endpoint has hit and silently survived ({@link EndpointControlPlane.splitRecoveryCount}).
   *  Pull it, or listen for `split-recovered` — the event can be missed, the count cannot. */
  get splitRecoveryCount(): number {
    return this.controlPlane.splitRecoveryCount;
  }

  /** Mis-keyed or malformed presence rows this reader rejected. The warning event may be missed; the count cannot. */
  get presenceBindingDropCount(): number {
    return this.presence.bindingDropCount;
  }
  /** The endpoint's own lifecycle UID, REQUIRED for every lifecycle-keyed messaging resource; absent
   *  ⇒ loud refusal naming the operation (the hard cut of SPEC §13.1 — no alias-keyed fallback). */
  private requireLifecycleUid(what: string): string {
    if (!this.identity.ownLifecycleUid)
      throw new Error(
        `${what} requires this endpoint's lifecycleUid (EndpointOptions.lifecycleUid): dm/dlv/chathist broker resources are lifecycle-keyed names (SPEC 13.1)`,
      );
    return this.identity.ownLifecycleUid;
  }

  constructor(opts: EndpointOptions) {
    super();
    this.on("transport", (state: TransportState) => { this.conn.nativeBound = state.connected; });
    resolveEndpointPrincipal(opts, this.identity, this.cred);
    this.presence.configureEnvironment(
      (opts.environment === undefined ? process.env.COTAL_ENVIRONMENT : opts.environment)?.trim() || undefined);
    resolveEndpointSettings(opts, this.identity, this.cred);
    // Seed the presence mirror so file-default channel modes are visible from the first publish
    // (not only after the first runtime toggle). Mirror only — delivery reads the connector's state.
    this.presence.seedChannelModes(opts.channelModes);
    this.card = this.identity.card;
    this.space = this.identity.space;
    this.channels = this.identity.channels;
    this.actorIsEphemeral = this.identity.actorIsEphemeral;
    this.fillParts();
  }

  /** Fill the parts record once every part exists. Each part reads a peer from it at use, never in
   *  its own constructor. */
  private fillParts(): void {
    Object.assign(this.parts, {
      anycastRail: this.anycastRail,
      bootMemberships: this.bootMemberships,
      channelDiscovery: this.channelDiscovery,
      connection: this.connection,
      consumers: this.consumers,
      controlPlane: this.controlPlane,
      credentials: this.credentials,
      deliveryLease: this.deliveryLease,
      deliveryPlane: this.deliveryPlane,
      durable: this.durable,
      durableBackstop: this.durableBackstop,
      history: this.history,
      liveness: this.liveness,
      presence: this.presence,
      principalServe: this.principalServe,
      provisioning: this.provisioning,
      reconnection: this.reconnection,
      subscriptions: this.subscriptions,
    } satisfies EndpointParts);
  }

  ref(): EndpointRef {
    return { id: this.card.id, name: this.card.name, role: this.card.role };
  }

  /** True on any AUTHED broker (static creds OR user-mode bearer) — the gate every open-vs-auth
   *  branch keys on: authed endpoints OPEN pre-created streams/KVs and BIND pre-provisioned
   *  durables (creates are denied to agents); only the open dev broker lazy-creates. */
  private get authed(): boolean {
    return Boolean(this.cred.currentCreds || this.identity.credsSource) || this.identity.userMode;
  }

  start(): Promise<void> {
    return this.connection.start();
  }

  /**
   * A condition the endpoint is already surviving. Node rethrows `error` when no listener is
   * attached, so emitting retry notices on `error` killed hosts that the endpoint intended to
   * keep running (#891). `warning` is observable and never fatal without a listener.
   */
  private emitRecoverable(err: Error): void {
    this.emit("warning", err);
  }



  /** The bearer and credential renewal of this endpoint. Every dependency is read when it is used, so
   *  a field assigned after construction is seen. */
  private readonly credentials = new EndpointCredentials(this.identity, this.conn, this.lifecycle, this.cred, {
    emitRecoverable: (err) => this.emitRecoverable(err),
    reconnect: () => this.reconnect(),
    emit: (event, ...args) => this.emit(event, ...args),
    on: (event, listener) => { this.on(event, listener); },
    off: (event, listener) => { this.off(event, listener); },
  }, this.parts);

  /** The credential this endpoint presents on its next connect, checked as {@link credsForWire}
   *  checks it. A second connection under the same identity reads it on every attempt, so it
   *  presents each credential this endpoint adopts and never an expired one. */
  wireCreds(): string {
    return this.credentials.wireCreds();
  }

  /** Fetch, broker-prove and adopt the source credential, then refresh the same connection
   * once outgoing mux and named-reply requests are quiet. A busy timeout retains the connection
   * and adopted credential. Call again to retry. This does not tear down endpoint bindings.
   * A dropped connection that is being re-established carries no request, so it redials now
   * instead of after its backoff; the rebuild re-fetches a stale credential from the source. */
  refreshCredsRequestSafe(): Promise<void> {
    return this.credentials.refreshCredsRequestSafe();
  }

  /** EXPLICIT credential reload — the auditable adoption step of D5 class-2 standing renewal (served
   *  to the renewal owner via the delivery-admin rail). The PROOF-OF-RECORD is a DISPOSABLE PREFLIGHT
   *  connection that presents exactly the candidate: it succeeds only when the BROKER accepts this
   *  re-signed generation, and it runs BEFORE the live cache is touched. So a cred the broker refuses
   *  throws HERE (structured), the resident connection — and the delivery-admin rail this very reply
   *  rides — is never disturbed, and "file re-signed" can never masquerade as "daemon adopted".
   *  `expected` is the renewal owner's generation token (SHA-256 of the JWT it re-signed): a re-read
   *  that does not match is rejected before the preflight even runs. On success the candidate becomes
   *  the resident connection's next-presented cred; the wire swap is NOT forced here — the caller
   *  ({@link handleDeliveryAdmin}) schedules it AFTER the aggregate reply, because the responder rides
   *  this connection and reconnecting before the reply flushes would strand it (see
   *  adoption-false-green.smoke.ts). Returns the BROKER-ACCEPTED generation's window (identity/iat/exp):
   *  the resident wire swap is best-effort and self-healing (the 75% timer + the broker's expiry-close),
   *  NOT witnessed, so the caller must claim broker acceptance, not verified resident reauth. NEVER a
   *  fingerprint. */
  reloadCreds(expected?: string): Promise<{ identity: string; iat?: number; exp?: number }> {
    return this.credentials.reloadCreds(expected);
  }

  /** The connection bind and teardown of this endpoint. Every dependency is read when it is used, so a
   *  field assigned after construction is seen. */
  private readonly connection: EndpointConnection = new EndpointConnection(this.identity, this.conn, this.lifecycle, this.cred, this.channelRegistry, this.delivery, {
    authed: () => this.authed,
    requireLifecycleUid: (what) => this.requireLifecycleUid(what),
    emitRecoverable: (err) => this.emitRecoverable(err),
    emit: (event, ...args) => this.emit(event, ...args),
    listenerCount: (event) => this.listenerCount(event),
    deleteOwnConsumer: (consumer) => this.deleteOwnConsumer(consumer),
  }, this.parts);

  /** The rebuild and retry pacing of this endpoint. Every dependency is read when it is used, so a field
   *  assigned after construction is seen. */
  private readonly reconnection = new EndpointReconnect(this.conn, this.lifecycle, {
    emit: (event, ...args) => this.emit(event, ...args),
  }, this.parts);

  /** Run the next rebuild attempt now if the endpoint is waiting out a {@link EndpointConnection.reestablishLoop}
   *  backoff, for a caller with work waiting on the link. After a long outage that backoff can run
   *  for up to a minute past the broker's return, and a send made in it waited for an attempt
   *  nobody had scheduled (#7408). Idle endpoints keep their spread-out retries. A no-op otherwise:
   *  a rebuild in flight is already the attempt, and a link nats.js is still reconnecting keeps
   *  its buffered publishes. */
  retryNow(): void {
    if (!this.lifecycle.stopped && this.lifecycle.reestablishing && !this.lifecycle.rebuildPromise) this.reconnection.kickBackoff();
  }

  /** Manual reconnect: tear down the current connection and rebuild, WITHOUT the permanent
   *  stop (stopped/stopping stay false). Serialized with the self-heal supervisor via
   *  {@link EndpointReconnect.rebuild}, and interruptible — if a backoff is in flight, kick it so the attempt
   *  is now, not in retryMs. Throws if stopped. On failure, leaves {@link EndpointConnection.reestablishLoop}
   *  running in the background so the endpoint never stays dead, and rethrows so the caller
   *  can report it. */
  reconnect(): Promise<void> {
    return this.reconnection.reconnect();
  }

  /** Stop the endpoint and close its connection.
   *
   *  Every principal serve ends first: its handlers' `signal` aborts, and stop waits for each
   *  handler in flight until its request's deadline at most, so a handler that never settles does
   *  not hold stop open longer than 30 s, the route's cap on a deadline. A reply that comes after
   *  that is dropped.
   *
   *  The presence epoch moves first: a bind still awaiting the broker must find it moved
   *  before any await below gives it a window to install a watch on a stopped endpoint
   *  (see {@link EndpointPresence.startPresenceWatch}). */
  stop(): Promise<void> {
    return this.stopPromise ??= this.connection.stopOnce();
  }

  /** The native binding of every connection this endpoint holds. A host compares the list with a
   *  complete native census of the account to show that no other connection uses it. The list
   *  proves neither liveness nor the absence of other connections. A stopped endpoint whose
   *  connections all closed reports none. It throws while there is no settled answer: before
   *  start, during a start, rebuild or stop, while a credential transaction or its connection swap
   *  is pending, and while the connection is down or redialing. */
  nativeConnections(): NativeConnectionBinding[] {
    return this.connection.nativeConnections();
  }

  // ---- messaging -----------------------------------------------------------

  /** The messaging verbs of this endpoint: multicast, unicast, anycast and the event-payload
   *  channel. Every dependency is read when it is used, so a field assigned after construction is seen. */
  private readonly messaging = new EndpointMessaging(this.identity, this.conn, {
    notLiveMsg: () => this.notLiveMsg(),
    ref: () => this.ref(),
    emitRecoverable: (err) => this.emitRecoverable(err),
  }, this.parts);

  /** Multicast: broadcast to everyone on a channel. */
  async multicast(
    text: string,
    opts?: { channel?: string; parts?: Part[]; replyTo?: string; contextId?: string; mentions?: string[] },
  ): Promise<CotalMessage> {
    return this.messaging.multicast(text, opts);
  }

  /** The broker's live `max_payload` — the CEILING a frame is measured against, not a budget for a
   *  caller's own payload.
   *
   *  Exposed because the connection is private and callers outside core (a connector assembling a
   *  batched payload) otherwise have no way to learn the ceiling except by failing a publish.
   *  Throws rather than guessing a default: a wrong ceiling is worse than none, because it splits
   *  either too eagerly or too late and both look like working code.
   *
   *  THIS ALONE CANNOT SIZE A MESSAGE. The envelope this endpoint adds after the publish call, and
   *  the client's own headers, are charged against the same ceiling and the caller never sees them.
   *  Use {@link encodedSize}, which measures what will actually be sent. */
  get maxPayload(): number {
    return this.messaging.maxPayload;
  }

  /**
   * Verify the PRECONDITION {@link multicastExpecting} depends on: that the chat stream evaluates
   * the subject expectation BEFORE the `Nats-Msg-Id` dedup cache. **Throws if it cannot be
   * guaranteed.** Call before the first serialized append on a given endpoint.
   *
   * **The ordering follows the stream's REPLICATION FACTOR, not the deployment.** A standalone R1
   * stream and an R1 stream inside a real 3-node cluster both refuse a stale expectation with a CAS
   * error; only an R3 stream evaluates dedup first and answers a retry with `duplicate: true`. A
   * check written against cluster size would pass on exactly the deployment that breaks.
   *
   * Every stream Cotal creates is `num_replicas: 1`, from the same canonical config the restore path
   * uses, so the property holds by construction today. This exists because "by construction" is an
   * observation until something checks it: nothing in the wire contract reserves the replica factor.
   * A caller appending under a stale assumption does not fail loudly; it accepts a retry as success
   * and drops a message.
   *
   * Evidence is `smoke:cas-preflight-cluster`, which records the server version it measured against
   * rather than naming one here — the suites resolve `nats-server` from `PATH`, so a hardcoded
   * provenance ages into a claim about a machine that no longer exists.
   *
   * @throws if the stream is unreadable (no `STREAM.INFO` grant, or absent) or reports more than
   *   one replica. Never degrades to a warning: the failure it prevents is silent.
   */
  async assertExpectationSemantics(): Promise<void> {
    return this.messaging.assertExpectationSemantics();
  }

  /**
   * The bytes this frame will ACTUALLY put on the wire, to compare against {@link maxPayload}.
   *
   * Caller-side arithmetic is wrong in the dangerous direction: a split sized against the caller's
   * own payload produces a frame the broker REJECTS, and a rejected truncation makes the loss silent
   * again — the failure splitting exists to prevent.
   *
   * It lives on the surface that BUILDS the envelope so measurement and construction cannot drift
   * apart unnoticed: it shares {@link casEnvelope} with the publish path, sets the same two headers,
   * and lets the client's own encoder encode them rather than re-implementing the wire format.
   * `frame-size.smoke.ts` binary-searches a real broker's ceiling and requires this number to land
   * on it exactly.
   *
   * `expectedLastSubjectSeq` is a parameter because it is a header VALUE: sizing at 0 and publishing
   * at 123456 differ by five bytes.
   * `expectedLastMsgId` is measured when given, so a caller that may send it can size for it.
   *
   * Residual: `ts` is re-stamped at publish, so the two differ in value — not in length until
   * epoch-millis needs a 14th digit.
   */
  encodedSize(opts: {
    channel: string;
    parts: Part[];
    id: string;
    expectedLastSubjectSeq: number;
    expectedLastMsgId?: string;
    mentions?: string[];
    replyTo?: string;
    contextId?: string;
  }): number {
    return this.messaging.encodedSize(opts);
  }

  /**
   * Multicast with an OPTIMISTIC-CONCURRENCY expectation and a caller-chosen dedup id, returning
   * the `PubAck` fields instead of discarding them. The serialized-append primitive: two writers
   * racing one subject cannot interleave, because the loser's expectation no longer holds.
   *
   * **Why a separate method rather than options on {@link multicast}.** `multicast` mints a fresh
   * `id` per call and drops the ack; both are right for ordinary chat and both are fatal to a
   * caller that must retry an append idempotently. Keeping them apart means no existing caller
   * changes behaviour, and the stricter validation below applies only where a caller opted in.
   *
   * - `id` becomes the JetStream `Nats-Msg-Id`, so the SAME id may be republished on retry and the
   *   server dedups it within the stream's duplicate window. It is validated rather than trusted:
   *   it lands in a wire header, and the dedup cache is **stream-wide**, so a caller-supplied id is
   *   both an injection surface and a way to suppress another publisher's message.
   * - `expectedLastSubjectSeq` is the sequence this publisher believes is the subject's tip; `0`
   *   means "the subject must be empty". A mismatch throws, and the throw stays classifiable by the
   *   already-public {@link isCasLoss} — the error is deliberately **not wrapped**, since wrapping
   *   would hide the `err_code` that classification reads.
   * - `expectedLastMsgId`, when given, becomes `Nats-Expected-Last-Msg-Id`. The broker checks it after
   *   its dedup cache, so a fresh value nobody has published turns a publish into a probe: an id the
   *   cache holds answers `duplicate: true` with the stored sequence, and any other id is refused
   *   with error 10070 before anything is stored.
   *
   * @throws if the endpoint is not live, the channel is not concrete, `id` is malformed, `parts` is
   *   empty, or `expectedLastSubjectSeq` is not a non-negative safe integer.
   */
  async multicastExpecting(opts: {
    channel: string;
    parts: Part[];
    id: string;
    expectedLastSubjectSeq: number;
    expectedLastMsgId?: string;
    mentions?: string[];
    replyTo?: string;
    contextId?: string;
  }): Promise<{ message: CotalMessage; ack: { seq: number; duplicate: boolean } }> {
    return this.messaging.multicastExpecting(opts);
  }

  /** Publish a payload frame on this principal's forge-locked sibling event rail. */
  async publishEventPayload(opts: { parts: Part[]; id: string; expectedLastSubjectSeq: number }): Promise<{ ack: { seq: number; duplicate: boolean } }> {
    return this.messaging.publishEventPayload(opts);
  }

  /** Read payload history through a single native-filtered consumer, never through CHAT. */
  async eventPayloadHistory(owner: string, actor: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<HistoryMessage[]> {
    return this.messaging.eventPayloadHistory(owner, actor, opts);
  }

  /** Verify the sibling stream and learn its actual message ceiling. A pre-upgrade space without
   *  the stream or its info-read permission returns null and emits a warning. Other authorization,
   *  transport and config errors throw. */
  async eventPayloadLimit(): Promise<number | null> {
    return this.messaging.eventPayloadLimit();
  }

  /** Unicast: direct message to one specific instance. */
  async unicast(
    instanceId: string,
    text: string,
    opts?: { parts?: Part[]; replyTo?: string; contextId?: string },
  ): Promise<CotalMessage> {
    return this.messaging.unicast(instanceId, text, opts);
  }

  /** Unicast, returning the JetStream publish ack alongside the message: the only truthful proof
   *  a sender has is that the broker stored the message at a sequence, never that anyone read it. */
  async unicastAttributed(
    instanceId: string,
    text: string,
    opts?: { parts?: Part[]; replyTo?: string; contextId?: string },
  ): Promise<{ msg: CotalMessage; ack: { seq: number; duplicate: boolean } }> {
    return this.messaging.unicastAttributed(instanceId, text, opts);
  }

  /** Anycast: deliver to ANY one instance of a service (role) — queue-group load balancing. */
  async anycast(
    service: string,
    text: string,
    opts?: { parts?: Part[]; replyTo?: string; contextId?: string },
  ): Promise<CotalMessage> {
    return this.messaging.anycast(service, text, opts);
  }

  /** Anycast, returning the JetStream publish ack alongside the message: the broker stored the
   *  request on the role's work queue at a sequence, which proves neither a holder nor a read. */
  async anycastAttributed(
    service: string,
    text: string,
    opts?: { parts?: Part[]; replyTo?: string; contextId?: string },
  ): Promise<{ msg: CotalMessage; ack: { seq: number; duplicate: boolean } }> {
    return this.messaging.anycastAttributed(service, text, opts);
  }

  /** Subscribe to a read-only observer feed. Defaults to the whole space; an observer under
   *  auth must pass `chatWildcard(space)` since its `sub.allow` only covers chat (DM/anycast
   *  stay confidential), and an admin must tap the messaging planes individually
   *  (`chat`/`inst`/`svc` — its enumerated `sub.allow` excludes the v0.4 endpoint rails,
   *  SPEC 13.9/13.11), otherwise the space-wildcard subscribe is denied and the feed dies.
   *
   *  A messaging frame (`chat`, `inst`, `svc`) is checked the way every other read of those planes
   *  is (SPEC §5): one whose payload sender is not the subject's sender is dropped, and one that
   *  passes carries the channel, recipient or role its subject names, not the payload's (#3741).
   *  A `chat`, `inst` or `svc` message whose parts cannot be read is dropped, as history drops it.
   *  Frames carrying stored-message headers are dropped on any subject. Handler exceptions emit
   *  `error`, and the feed keeps reading. Other frames reach the handler as decoded. */
  tap(
    handler: (subject: string, msg: CotalMessage | undefined) => void,
    opts?: { subject?: string },
  ): void {
    this.connection.addTap({ handler, subject: opts?.subject ?? spaceWildcard(this.space) });
  }

  // ---- control plane (request/reply) --------------------------------------

  /** The control plane and the service-invocation client of this endpoint. Every dependency is
   *  read when it is used, so a field assigned after construction is seen. */
  private readonly controlPlane = new EndpointControlPlane(this.identity, this.conn, this.lifecycle, this.cred, this.delivery, {
    authed: () => this.authed,
    notLiveMsg: () => this.notLiveMsg(),
    requireLifecycleUid: (what) => this.requireLifecycleUid(what),
    ref: () => this.ref(),
    reconnect: () => this.reconnect(),
    emit: (event, ...args) => this.emit(event, ...args),
  }, this.parts);

  /** Serve control requests for a service. Returns the subscription so a caller that re-registers on
   *  reconnect (the delivery daemon) can drop the stale one. `boundReply` is REQUIRED for any service
   *  whose responder holds a wildcard publish grant over the service subtree (the delivery daemon's
   *  `ctl.delivery.*.*.reply.>`): without it, an authenticated caller could set its reply target to a
   *  PEER's reply lane (`ctl.delivery.<victim>.reply.<n>`) and turn the responder into a confused
   *  deputy — the broker does NOT permission-check the requester's embedded reply subject. With it, a
   *  reply is published only when `m.reply` is under the AUTHENTICATED request subject
   *  (`${m.subject}.reply.…`), binding the reply to the broker-policed sender token.
   *
   *  Requests are answered one at a time, in arrival order. A request `concurrent` accepts is answered
   *  in its own time instead: it waits for none of the requests in front of it, including one still
   *  running, and holds up none behind it. Only for a request that shares no state with the service's
   *  other requests. */
  serveControl(
    service: string,
    handler: (req: ControlRequest) => Promise<ControlReply> | ControlReply,
    opts: { boundReply?: boolean; concurrent?: (req: ControlRequest) => boolean } = {},
  ): import("@nats-io/transport-node").Subscription {
    return this.controlPlane.serveControl(service, handler, opts);
  }

  /** Send a control request to a service and await its reply (client side). Like {@link EndpointControlPlane.requestDelivery},
   *  the reply rides a BOUNDED subject UNDER the request subject (`ctl.<service>.<id>.reply.<uuid>`), not
   *  the per-id `_INBOX`.
   *  `noMux` lets us name the reply subject while keeping NoResponders detection. The random suffix is
   *  defense-in-depth (a predictable suffix would let a peer target an in-flight named reply sub). The
   *  reply sits under the sender's OWN request subject, so the responder's `boundReply` guard accepts it. */
  async requestControl(
    service: string,
    req: ControlRequestInit,
    timeoutMs = 5000,
  ): Promise<ControlReply> {
    return this.controlPlane.requestControl(service, req, timeoutMs);
  }

  /** The caller this connection's endpoint requests ride as: the legacy triple, or the issued
   *  caller with its discovered generation (SPEC 13.15). It names the reply rail this connection's
   *  credential reads, which is where a manager's turn notice for it lands (SPEC 14.3). */
  serviceRailCaller(): EpCaller {
    return this.controlPlane.serviceRailCaller();
  }

  /** Follow this caller's goal on its standing connection, subscribing before submission.
   *  A submitter may use a separate short-lived control credential for the same caller triple;
   *  the accepted action's readiness budget can outlive that credential. This endpoint retains
   *  its existing credential renewal and caller-scoped progress grants. */
  async followServiceGoal(
    endpoint: string,
    submit: (signal?: AbortSignal) => Promise<EpAttributedReply>,
    deadlineMs = 10_000,
    opts: Pick<SubmitAndFollowGoalOptions, "reconcile" | "signal" | "prepare"> = {},
  ): Promise<EpAttributedReply> {
    return this.controlPlane.followServiceGoal(endpoint, submit, deadlineMs, opts);
  }

  /** The resolved, digest-verified command surface of `endpoint` as this connection's caller sees
   *  it. Unpinned calls cache the complete discovery surface, and `refresh` drops both the full
   *  handle and any command-specific invocation handles. `instanceId` selects one instance without
   *  reading or populating either class cache, as a pinned invoke does. The caller's existing
   *  credential must permit that route. */
  async describeService(endpoint: string, opts: { deadlineMs?: number; signal?: AbortSignal; refresh?: boolean; instanceId?: string } = {}): Promise<ResolvedService> {
    return this.controlPlane.describeService(endpoint, opts);
  }

  /** The caller a registry listing rides (SPEC 13.15). An issued connection lists as itself. Any
   *  other connection reads the listing generation the issuer bound to the credential it presented,
   *  under the token its connection id and that credential's expiry derive. `undefined`: that
   *  credential carries no listing binding, because it predates listing issuance or has no expiry. */
  async listingCaller(): Promise<IssuedCaller | undefined> {
    return this.controlPlane.listingCaller();
  }

  /** One page of the registry's `endpoints` answer (SPEC 13.20) over this connection
   *  ({@link listRegistryEndpoints}). The describe rides this connection's own caller; the question
   *  rides the listing caller on an authed mesh. `unbound`: this credential carries no listing
   *  binding. */
  async listEndpoints(input: RegistryEndpointsInput, opts: { deadlineMs?: number; signal?: AbortSignal } = {}): Promise<
    | { unbound: true }
    | { unbound?: false; reply: EpAttributedReply; page?: RegistryEndpointsOutput }
  > {
    return this.controlPlane.listEndpoints(input, opts);
  }

  /** Ask the registry over `nc` under `listing`: this connection, or another of this caller triple
   *  such as a manager-call connection. The describe rides this connection, whose view holds the
   *  registry's describe. Every endpoint the page lists has its cached describe dropped, so the next
   *  describe of it reads the surface afresh. `unbound`: the broker refused the question under
   *  `listing`, whose credential holds no listing row. */
  async listEndpointsOver(
    nc: NatsConnection,
    listing: IssuedCaller | undefined,
    input: RegistryEndpointsInput,
    opts: { deadlineMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ unbound: true } | { unbound?: false; reply: EpAttributedReply; page?: RegistryEndpointsOutput }> {
    return this.controlPlane.listEndpointsOver(nc, listing, input, opts);
  }

  /** GENERIC v0.4 service invoke over this endpoint's own connection: resolve
   *  the named endpoint's registered surface — describe, §13.7 store fetch, digest-verified
   *  recompile ({@link resolveService}; cached per endpoint name) — and invoke one command. The
   *  resolve is describe-bound currency, and a call that reaches the wrong incarnation is recovered
   *  two ways depending on WHO caught it — the difference between knowing the command did not run
   *  and only knowing someone answered:
   *   - the RESPONDER fenced it on the request's `bind` (§13.2, an `ok:false` reply marked
   *     {@link replyRefusedBeforeEffect}): the command did not run, so the bind is dropped and the
   *     call re-issued for any command, up to {@link BIND_SPLIT_REISSUES} times while each re-issue
   *     is refused the same way. If a re-issue cannot be resolved, the refusal
   *     surfaces — still saying the command did not run — naming the resolve failure as why the
   *     repair could not be attempted. An unpinned targeted call that reached a member holding no
   *     mapping for its target ({@link replyTargetUnmapped}) is repaired the same way, and when the
   *     re-issues run out, the latest such refusal is the one surfaced.
   *   - this CLIENT caught it on the reply ({@link respondedButUnbound}: a different instance,
   *     `failed-precondition`; the same instance at any other epoch, `expired`), which is what a
   *     responder too old to know the field produces. A live instance received and answered it, so
   *     the bind is dropped but the call is re-issued only for a command on the
   *     {@link isRepeatSafeCommand} allowlist; anything else surfaces, since a second attempt could
   *     duplicate its effect.
   *  A broker permission refusal marked `not-executed` rebuilds the connection and retries once
   *  within the original deadline. A second refusal stands. Responder errors and calls that may
   *  have run never trigger this repair.
   *  Errors from the responder come back structurally on the attributed reply
   *  (`reply.ok === false`); transport/validation refusals throw {@link EpEnvelopeError}. */
  async invokeService(
    endpoint: string,
    command: string,
    args?: Record<string, unknown>,
    opts: { target?: EpVerbTarget; deadlineMs?: number; follow?: boolean; signal?: AbortSignal; instanceId?: string; classInstanceId?: string } = {},
  ): Promise<EpAttributedReply> {
    return this.controlPlane.invokeService(endpoint, command, args, opts);
  }

  /** Send a PRIVILEGED delivery-admin request to the server-side delivery daemon and await its reply
   *  (the D5 rail-split: `reloadCreds` now, the eviction executor next). Same bounded-reply shape as
   *  {@link EndpointControlPlane.requestDelivery}; the cred layer is the real gate — only the manager's supervisor profile
   *  holds the request-publish grant, so an agent calling this gets a broker denial, not a handler
   *  refusal. NoResponders (no daemon) surfaces as the thrown request error — callers decide whether
   *  that degrades (renewal falls back to the daemon's 75% re-read backstop) or fails. */
  requestDeliveryAdmin(op: string, args: Record<string, unknown>, timeoutMs = 5000): Promise<ControlReply> {
    return this.controlPlane.requestDeliveryAdmin(op, args, timeoutMs);
  }

  // ---- presence ------------------------------------------------------------

  getRoster(): Presence[] {
    return this.presence.getRoster();
  }

  /**
   * Read the roster from the broker now, for an endpoint that does not watch presence (SPEC §6). One
   * batched Direct Get of the bucket that binds no consumer, decoded and dropped as the watch decodes.
   * A record that says `offline` or whose `ts` is past the liveness window reads offline. A peer an
   * earlier read saw that is gone from the bucket stays in the roster as offline, as a watch keeps
   * it. The result is also what {@link getRoster} returns until the next read.
   *
   * Calls made while a read is in flight share it, and every other call reads anew, so a verdict
   * never rests on a read that settled before it was asked. A failed read throws and changes
   * nothing. A credential that may not make the read is refused with the grant it lacks.
   */
  async readPresence(): Promise<Presence[]> {
    return this.presence.readPresence();
  }

  /**
   * Trust state of THIS observer's presence watch, not of any peer. `unpopulated` means the
   * current watch has not completed its initial snapshot, so {@link getRoster} may be partial and
   * cannot support an absence verdict. `stale` means the whole bucket has been silent past the
   * liveness window, so the roster is last-known as of `staleSince`. `fresh` is false for both
   * unsafe states so consumers written before `state` was added degrade in the safe direction.
   */
  presenceView(): PresenceView {
    return this.presence.presenceView();
  }

  /** Wait until the current presence watch has consumed its initial KV snapshot. An observer that
   * does not register completes on an empty bucket at once. A registering one completes when its
   * own record arrives, and the timeout bounds that wait. */
  async waitForPresenceSnapshot(timeoutMs = 1_000): Promise<"snapshot" | "timeout"> {
    return this.presence.waitForPresenceSnapshot(timeoutMs);
  }

  async setActivity(activity: string): Promise<void> {
    return this.presence.setActivity(activity);
  }

  /** Set the status, and with `activity` the activity line too, in one presence write, so no peer sees
   *  the new activity beside the old status. */
  async setStatus(status: PresenceStatus, activity?: string): Promise<void> {
    return this.presence.setStatus(status, activity);
  }

  /** Record harness-reported work progress as `activeAt`. It writes nothing itself: the next heartbeat
   *  carries it, so a stream of events costs no presence writes. */
  noteActivity(at: number = Date.now()): void {
    return this.presence.noteActivity(at);
  }

  /** Publish a harness-reported condition, or clear it. Core stores the relay without interpretation. */
  async setCondition(condition: PresenceCondition | null): Promise<void> {
    return this.presence.setCondition(condition);
  }

  /** Publish the agent's global attention mode into presence (advisory observability). Mirror only —
   *  delivery decisions stay in the connector's authoritative state. */
  async setAttention(attention: AttentionMode): Promise<void> {
    return this.presence.setAttention(attention);
  }

  /** Publish the agent's per-channel attention overrides into presence (advisory). An empty map drops
   *  the field. Mirror only — never read back into delivery. */
  async setChannelModes(modes: Record<string, ChannelMode>): Promise<void> {
    return this.presence.setChannelModes(modes);
  }

  /** Overlay the host's live model and optional variant onto the card's display-only metadata, then
   *  republish presence. The mutated card is read live by every later publish, so even a pre-connect
   *  call surfaces on the first presence write. `provider` is the effective provider the connector
   *  reported serving the model; when omitted an existing `meta.provider` is left untouched. */
  async setCardModel(model: string, variant?: string, provider?: string): Promise<void> {
    return this.presence.setCardModel(model, variant, provider);
  }

  /** Overlay the session's working directory onto the card's display-only `meta.cwd`, then
   *  republish presence. Advisory display data; an empty string leaves the card unchanged. */
  async setCardCwd(cwd: string): Promise<void> {
    return this.presence.setCardCwd(cwd);
  }

  /** Apply `changes` to the card's advisory `meta`, each key set or removed with `undefined`, then
   *  republish presence once, so no record shows part of them. A call before the first connect
   *  shows on the first presence record; values the card already has change nothing. Throws on an
   *  empty key. */
  async setCardMeta(changes: CardMetaChanges): Promise<void> {
    return this.presence.setCardMeta(changes);
  }

  /** Change the card's display name, and its `meta` by `meta` as {@link setCardMeta} does, then
   *  republish presence at once in one record (SPEC §6). The principal stays as it is, and every
   *  later message carries the new `from.name`. Throws on a name {@link assertValidName} refuses; a
   *  name and meta the card already has change nothing. */
  async setCardName(name: string, meta?: CardMetaChanges): Promise<void> {
    return this.presence.setCardName(name, meta);
  }

  // ---- channel discovery ---------------------------------------------------

  /** The channel registry cache, its policy lookups and the registry watch that fills it, of this
   *  endpoint. Every dependency is read when it is used, so a field assigned after construction is seen. */
  private readonly channelDiscovery = new EndpointChannelDiscovery(this.identity, this.conn, this.channelRegistry, {
    notLiveMsg: () => this.notLiveMsg(),
    emitRecoverable: (err) => this.emitRecoverable(err),
    emit: (event, ...args) => this.emit(event, ...args),
  }, this.parts);

  /**
   * Read the channel registry from the broker now, for a consumer that reads presence on demand. One
   * batched Direct Get that binds no consumer, decoded as the watch decodes; the result replaces the
   * cache, so an entry removed since the last read is gone. {@link listChannels} and a join or leave
   * read through here first; other cache readers see the last read.
   *
   * Calls made while a read is in flight share it, and every other call reads anew. A failed read
   * throws and changes nothing. A credential that may not make the read is refused with the grant it lacks.
   */
  async readChannels(): Promise<void> {
    return this.channelDiscovery.readChannels();
  }

  /** This channel's registry config from the local cache (undefined if unset). */
  getChannelConfig(channel: string): ChannelConfig | undefined {
    return this.channelDiscovery.getChannelConfig(channel);
  }

  /** Effective replay-on-join policy for a channel: per-channel override ?? space default ??
   *  true. Reads the live cache, so it reflects runtime registry edits. */
  channelReplay(channel: string): boolean {
    return this.channelDiscovery.channelReplay(channel);
  }

  /** Effective replay window for a channel (per-channel override ?? space default), or undefined
   * for the full retained window. Only meaningful when {@link channelReplay} is true. */
  channelReplayWindow(channel: string): string | undefined {
    return this.channelDiscovery.channelReplayWindow(channel);
  }

  /** A channel's effective replay policy read straight from the registry bucket, for a caller that
   *  reads it right after start, before any watch cache has caught up, or that watches nothing. A
   *  wildcard reads the space defaults only. A space with no registry bucket has the built-in policy.
   *  `registered` says whether the channel has its own registry entry. */
  async channelReplayPolicy(channel: string): Promise<{ replay: boolean; window: string | null; registered: boolean }> {
    return this.channelDiscovery.channelReplayPolicy(channel);
  }

  /** Effective delivery class for a channel (per-channel override ?? space default ?? "durable"),
   *  from the live watch cache — drives the non-gating delivery-health surface (only durable-class
   *  channels have a Plane-3 backstop to report on). */
  channelDeliveryClass(channel: string): DeliveryClass {
    return this.channelDiscovery.channelDeliveryClass(channel);
  }

  // ---- dynamic subscription (join / leave mid-session) ---------------------

  /** Join, leave and channel listing, and the membership feed watches, of this endpoint. Every
   *  dependency is read when it is used, so a field assigned after construction is seen. */
  private readonly subscriptions: EndpointSubscriptions = new EndpointSubscriptions(this.identity, this.conn, this.lifecycle, this.channelRegistry, this.delivery, {
    authed: () => this.authed,
    notLiveMsg: () => this.notLiveMsg(),
    armJoin: (channels) => this.armJoin(channels),
    watchConsumerDeleteDenied: (stream, name, owner) => this.watchConsumerDeleteDenied(stream, name, owner),
    deleteMembershipConsumer: (jsm, stream, name) => this.deleteMembershipConsumer(jsm, stream, name),
    emit: (event, ...args) => this.emit(event, ...args),
  }, this.parts);

  /** The channels this endpoint is currently subscribed to (live — reflects join/leave). */
  joinedChannels(): string[] {
    return this.subscriptions.joinedChannels();
  }

  /**
   * Join a channel mid-session: open a native core subscription (manager-free live read, broker-
   * confirmed against `sub.allow`), capture the stream frontier as the join watermark, backfill its
   * history if replay is on, and — for a `durable`-class channel or a family such as `review.>` when a
   * delivery daemon is present — request a Plane-3 durable backstop (via `ctl.delivery`). Any other
   * pattern stays live only, with a `reason`. Idempotent: re-joining is a no-op (no
   * re-backfill). Returns the backfill count + whether the durable backstop is active (+ a `reason`
   * when a durable channel couldn't get one).
   */
  async joinChannel(
    channel: string,
  ): Promise<{ joined: boolean; backfilled: number; durable: boolean; reason?: string }> {
    return this.subscriptions.joinChannel(channel);
  }

  /** Leave a channel mid-session — MANAGER-FREE for the live read: close the core subscription. For a
   *  Plane-3 durable channel, the membership is tombstoned FIRST at the leave cursor (SPEC §7: leave is
   *  a hard read boundary for the backstop — a pre-leave entry stays deliverable, `seq > leaveCursor` is
   *  denied). FAIL-CLOSED: if the tombstone can't be confirmed the call throws and the leave is NOT
   *  applied (live sub stays up, local mirror intact) so the caller can retry — never close the live
   *  read while the backstop keeps delivering. `legacyDiscoveryMessage` lets the caller supply the
   *  remedy when membership discovery predates lifecycle support, without changing the refusal. */
  async leaveChannel(channel: string, legacyDiscoveryMessage?: string): Promise<{ left: boolean }> {
    return this.subscriptions.leaveChannel(channel, legacyDiscoveryMessage);
  }

  /**
   * What the chat stream still holds and what removes the rest. `perSender` is the stream's
   * per-subject cap: a subject is one sender on one channel, and past the cap that sender's oldest
   * message on the channel is discarded. `maxAgeMs` is the stream's age limit. Each is `null` when
   * the stream sets none. `senders` counts each sender's retained messages per channel, so a sender
   * at the cap marks a channel whose retained history has lost that sender's older messages while
   * other senders' messages from the same time remain. `stream` is false when the chat stream does
   * not exist, which holds nothing. `lastSeq` is the stream's newest sequence, 0 when it has none.
   */
  async chatRetention(): Promise<{ perSender: number | null; maxAgeMs: number | null; oldestAt: string | null; senders: { channel: string; sender: string; messages: number }[]; stream: boolean; lastSeq: number }> {
    return this.subscriptions.chatRetention();
  }

  /** Whether this space's direct-message stream is on its broker. A missing stream is false.
   *  Any other failure, including a permission denial, is raised. */
  async dmStreamPresent(): Promise<boolean> {
    return this.subscriptions.dmStreamPresent();
  }

  /** One coherent channel model for dashboards: every channel that has messages OR a registry
   *  entry (configured-but-empty), each tagged with its {@link ChannelConfig}. Works even on
   *  observer endpoints (no consumers needed). */
  async listChannels(): Promise<{ channel: string; messages: number; config?: ChannelConfig }[]> {
    return this.subscriptions.listChannels();
  }

  /**
   * Who is a durable member of a channel — read from the privileged members registry (Plane-3),
   * joined with presence for liveness (a member whose peer is gone but lingering shows `live:false`,
   * not a phantom). Only CURRENT, ACTIVATED members (non-tombstoned, and past activation catch-up — a
   * join still completing or that failed catch-up reported durable:false and stays hidden here until
   * confirmed, so this surface never overstates membership). A row is a concrete channel or a family
   * (`review.>`, #5404). Asked for one channel, a family row counts when the channel is durable-class
   * and under it, and a principal with several rows is listed once. The map of every channel keys each
   * row as recorded, so a family's members sit under the family itself (`review.>`), not under each
   * channel it covers. `live`-class channels carry no durable record — membership there
   * is the live core-sub, not tracked here. Privileged read (the members KV is manager-write/read; agents hold no grant), so
   * it is served by the manager, not an agent capability.
   */
  async channelMembers(channel: string): Promise<ChannelMember[]>;
  async channelMembers(): Promise<Map<string, ChannelMember[]>>;
  async channelMembers(
    channel?: string,
  ): Promise<ChannelMember[] | Map<string, ChannelMember[]>> {
    return channel === undefined ? this.subscriptions.channelMembers() : this.subscriptions.channelMembers(channel);
  }

  /**
   * Snapshot the broker-sourced channel-membership feed (admin/observer read): every agent's
   * `{live, durable}` record plus `asOf` — the feed's freshness heartbeat (epoch ms of the daemon's last
   * successful poll, from the reserved {@link MEMBERSHIP_FEED_KEY}). `live` patterns are kept as-is
   * (wildcards preserved); the consumer expands them against the channel registry. `asOf` is undefined
   * when the feed has never been written (no daemon → the dashboard degrades to traffic-only).
   */
  async readMembership(): Promise<MembershipSnapshot> {
    return this.subscriptions.readMembership();
  }

  /** Watch the membership feed for changes (admin/observer): `onChange` receives every KV entry as a
   *  {@link MembershipChange} — the decoded member record (or its deletion), or the feed heartbeat's
   *  `asOf` — so a caller keeps its snapshot current without re-reading the bucket; the entries replayed
   *  when the watch (re)arms carry `update: false` and end with a `replayed` change. The async stop
   *  handle disarms local delivery before resolving. It deletes the broker consumer when permitted;
   *  a known-ungranted delete leaves it to native inactivity reclamation. A feed the cred can't read
   *  (or absent) surfaces as an `error` event and the dashboard keeps its last snapshot. */
  async watchMembership(onChange: (change: MembershipChange) => void, onClosed?: (err: Error) => void): Promise<{ stop(): Promise<void> }> {
    return this.subscriptions.watchMembership(onChange, onClosed);
  }


  /** Skip only a delete the authenticated connection's well-formed publish claims exclude.
   *  This is request avoidance, not authority: the broker still enforces every request we send. */
  private watchConsumerDeleteDenied(stream: string, name: string, owner: object | undefined): boolean {
    const permission = owner && this.conn.watchDeletePermissions.get(owner)?.();
    return Boolean(permission && !issuedPermitsSubject(permission, `$JS.API.CONSUMER.DELETE.${stream}.${name}`));
  }

  /** Delete one of this connection's own KV-watch consumers. A refused delete is the designed
   *  outcome for a profile without a stream-wide CONSUMER.DELETE (#691): the broker reaps the
   *  consumer at its inactive threshold. */
  private async deleteOwnConsumer(consumer: Consumer | PushConsumer): Promise<void> {
    const { stream_name, name } = await consumer.info(true);
    if (this.watchConsumerDeleteDenied(stream_name, name, consumer)) return;
    try { await consumer.delete(); }
    catch (e) {
      if (!isJetStreamMissing(e, JetStreamApiCodes.ConsumerNotFound) && !isPublishPermissionDenied(e)) throw e;
    }
  }

  /** Delete one membership-watch consumer, swallowing ONLY already-gone and a refused delete. */
  private async deleteMembershipConsumer(jsm: JetStreamManager, stream: string, name: string): Promise<boolean> {
    try { return await jsm.consumers.delete(stream, name); }
    catch (err) {
      if (membershipConsumerReleased(err)) return true;
      throw err;
    }
  }

  /** Fetch recent messages from a channel's JetStream backlog. `signal` cancels the active pull and
   *  reclaims its ephemeral consumer before the promise rejects. Returns `HistoryMessage[]`
   *  (#1413): every field present on a row was checked by the drain before the row was
   *  returned — a stored row missing `ts` / `space` / `parts` / `from.name` is dropped, never
   *  returned with that member silently `undefined`.
   *
   *  `publisher` reads only what that one principal published on the channel, by filtering on its
   *  own subject (`chat.<owner>.<actor>.<channel>`). The subject's sender slots are what the
   *  broker's publish permissions police, so on a mesh with permissions every row of such a read was
   *  published by that principal: the same guarantee a live subscription to that subject gives.
   *  Without it the read is the channel from any sender. */
  async channelHistory(
    channel: string,
    opts?: { limit?: number; signal?: AbortSignal; publisher?: { owner: string; actor: string } },
  ): Promise<HistoryMessage[]> {
    return this.history.channelHistory(channel, opts);
  }

  /** Read one concrete channel using this lifecycle's single-filter CHAT grant (SPEC §8/§9).
   *  No observer authority, presence or delivery ACL mirror is required. Returns the newest page,
   *  oldest-first, including this caller's own sends. `complete` says no older valid row remains.
   *  Reads have a ten-second budget, shortened by `signal`. Concurrent connections sharing this
   *  lifecycle wait for native consumer inactivity cleanup; they never delete another reader. */
  async channelHistoryPage(
    channel: string,
    opts?: ChannelHistoryPageOptions,
  ): Promise<HistoryPage> {
    return this.history.channelHistoryPage(channel, opts);
  }

  /**
   * The newest `limit` chat messages across concrete channels or one channel family, oldest-first within the page,
   * each tagged with the channel the BROKER delivered it on.
   *
   * The CHAT stream interleaves every channel into one sequence space. Consumers take sets of
   * filter subjects for the requested channels. Large filter sets are read in batches, and the
   * pages are merged by stream sequence to select the newest `limit` messages overall.
   *
   * **The broker does the filtering, so the wire carries only what is asked for.** A channel left
   * out of `channels` costs nothing: its messages are never delivered, so a space whose volume is
   * dominated by channels the caller does not want stays cheap.
   *
   * **The channel comes from the SUBJECT, never from the payload.** A message claims a `channel`
   * field, and this method ignores it: the tag is derived from the subject the broker routed the
   * message on, the same derivation {@link listChannels} uses to name a channel in the first place.
   *
   * A single channel family such as `events.>` uses one broker filter without enumerating its
   * concrete channels. Otherwise every channel must be concrete: mixing a family with other
   * filters, or using other wildcard patterns, is refused rather than risking overlapping filters.
   *
   * **The broker enforces read authority.** A multi-filter create
   * cannot encode its filter in the API subject, so it rides the bare
   * `$JS.API.CONSUMER.CREATE.<CHAT>` row that only the read-only dashboard profiles hold. An agent
   * credential pins the filter into the subject per channel and is denied here by the broker, which
   * is the correct answer: this method reads across channels, and an agent's read ACL is per
   * channel. A single filter uses the filter-bearing create subject, including a channel family,
   * so the broker checks the credential's grant for that filter. No additional authority is minted.
   */
  async multiChannelHistory(
    channels: readonly string[],
    opts?: { limit?: number; signal?: AbortSignal; batch?: number },
  ): Promise<{ channel: string; seq: number; msg: HistoryMessage }[]> {
    return this.history.multiChannelHistory(channels, opts);
  }

  /** Read a channel's recent history through the delivery daemon, using a provisioned ACL mirror.
   *  SPEC's ban on raw control-surface stream reads does not remove the single-channel CHAT grant.
   *  Human callers without an ACL mirror use {@link channelHistoryPage}; this method adds fresh
   *  mirror checks for provisioned readers. `items` is shape-identical to what {@link channelHistory}
   *  returns — the same `CotalMessage[]`, the same newest-N selection, the same oldest-first order
   *  within the page — so a caller migrates by reading `.items` and nothing else changes. The return
   *  is WRAPPED rather than bare precisely because of `complete`: a bare array cannot say whether
   *  older history remains behind it.
   *
   *  **Why this exists when `channelHistory` already works:** authorization. A consumer pins its
   *  authorization at CREATE time, so a caller whose read ACL is revoked mid-scroll keeps being served
   *  by the consumer it already holds. The mediator re-reads authorization on EVERY call (live
   *  registry row ∩ mint-time ceiling — SPEC §9.6), so a revocation stops the very next read and a
   *  registry-only widen cannot exceed the effective credential. That is the whole point of the verb;
   *  a mediator that cached the ACL would be a rename of the path it replaces.
   *
   *  **The caller never names itself.** The daemon takes the principal from the broker-authenticated
   *  request subject ({@link serveControl} fail-closes when the payload `from` disagrees), so there is
   *  no caller-supplied identity to forge.
   *
   *  A channel outside the caller's read ACL THROWS. It must never come back as an empty page: "you
   *  may not read this" and "there is nothing here" are different answers and only one is safe to
   *  render as an empty conversation.
   *
   *  Chat channels only — DM history is deliberately not served here (it is god-view-only today, a
   *  different authorization model, and one handler with two authz paths is the wrong shape on the
   *  surface where a mistake exposes private messages). */
  async readHistory(channel: string, opts?: { limit?: number }): Promise<HistoryPage> {
    return this.history.readHistory(channel, opts);
  }

  /** Fetch recent DMs (any sender→any recipient) from the space's DM backlog. `signal` cancels the
   *  active pull and reclaims its ephemeral consumer. God-view only:
   *  a normal agent/observer's ACL denies CONSUMER.CREATE on DM_<space>, so this throws-and-
   *  skips for them — only an `admin`-profile cred can read it. Returns `HistoryMessage[]`
   *  (#1413): every field present on a row was checked by the drain before the row was
   *  returned — a stored row missing `ts` / `space` / `parts` / `from.name` is dropped, never
   *  returned with that member silently `undefined`. */
  async dmHistory(opts?: { limit?: number; signal?: AbortSignal }): Promise<HistoryMessage[]> {
    return this.history.dmHistory(opts);
  }

  /** The newest `limit` DMs (100 by default) sent to or by any of `principals`, oldest first. Each
   *  principal is a concrete `<owner>.<actor>`; anything else throws, because a wildcard would widen
   *  the read to other principals' DMs. The broker filters on the DM subject, so every row's `to` or
   *  `from.id` is one of them. Only an `admin` credential may read the DM backlog. Where
   *  {@link dmHistory} returns an empty list for any other, this returns `denied`. */
  dmHistoryOf(principals: readonly string[], opts?: { limit?: number; signal?: AbortSignal }): Promise<DmHistoryRead> {
    return this.history.dmHistoryOf(principals, opts);
  }

  // ---- internals -----------------------------------------------------------

  /** The error message for a guard that finds the endpoint unbound: "reconnecting" during a
   *  rebuild's null window OR an inter-retry backoff (so a concurrent op reports the real
   *  reason, not "not started" — `reestablishing` spans the whole retry loop incl. backoff),
   *  else "endpoint not started" (genuine pre-start). */
  private notLiveMsg(): string {
    return this.lifecycle.reconnecting || this.lifecycle.reestablishing
      ? "reconnecting - try again shortly"
      : "endpoint not started";
  }

  /** Stream creation and the privileged DM, DELIVER and TASK durable provisioning of this endpoint.
   *  Every dependency is read when it is used, so a field assigned after construction is seen. */
  private readonly provisioning = new EndpointProvisioning(this.identity, this.conn, {
    authed: () => this.authed,
    notLiveMsg: () => this.notLiveMsg(),
  }, this.parts);

  /** Create this open space's message streams if they are not there yet, as a consuming endpoint
   *  does when it starts. For a sender that consumes nothing and may be the space's first
   *  participant (#7045). An authenticated broker's streams come from its setup, and its agents may
   *  not create them, so this throws there. */
  async ensureOpenSpaceStreams(): Promise<void> {
    return this.provisioning.ensureOpenSpaceStreams();
  }

  /**
   * Privileged: pre-create an agent's DM inbox durable (auth mode), so the agent can BIND
   * it without holding CONSUMER.CREATE on DM_<space>. The creator sets the filter to
   * inst.<targetId>.* — the agent never gets to choose it, which is what stops a peer from
   * creating a durable filtered to someone else's inbox. Idempotent (byte-identical config),
   * safe to call again on manager restart. The caller must be permissive on DM_<space>.
   */
  async provisionDmInbox(owner: string, actor: string, lifecycleUid: string): Promise<void> {
    return this.provisioning.provisionDmInbox(owner, actor, lifecycleUid);
  }

  /**
   * Privileged: pre-create an agent's bind-only Plane-3 DELIVER durable (`dlv_<id>`, filtered to
   * `dlv.<id>`), so the agent can BIND its per-member durable handoff without holding CONSUMER.CREATE
   * on the DLV stream. Same bind-only model as {@link provisionDmInbox}: the creator sets the filter,
   * the agent never does. The trusted reader transfers re-authorized copies onto `dlv.<id>`; the agent
   * acks them via native JetStream (SPEC §8). Idempotent. The caller must be permissive on DLV.
   */
  async provisionDlvInbox(owner: string, actor: string, lifecycleUid: string): Promise<void> {
    return this.provisioning.provisionDlvInbox(owner, actor, lifecycleUid);
  }

  /**
   * Privileged: pre-create a role's shared TASK work-queue durable (auth mode), so agents
   * of that role can BIND it without holding CONSUMER.CREATE on TASK_<space>. The creator
   * sets the filter to svc.<role>.> — agents never choose it, which stops cross-role drain.
   * Idempotent per role. The caller must be permissive on TASK_<space>.
   */
  async provisionTaskQueue(role: string): Promise<void> {
    return this.provisioning.provisionTaskQueue(role);
  }

  // ---- Plane-3: durable backstop (SPEC §8) — privileged, hosted by the server-side DELIVERY DAEMON ----
  //
  // Two daemon loops + two privileged membership ops (served to agents on `ctl.delivery`). The FAN-OUT
  // writer (routing, not auth) reads every chat message and copies it into each eligible owner's MIXED
  // inbox (`dinbox.<owner>`); the TRUSTED READER (the auth gate) re-authorizes each entry against the
  // CURRENT ACL + membership interval and TRANSFERS the authorized copy to the owner's per-member
  // DELIVER store (`dlv.<owner>`), which the agent binds + acks via native JetStream. The agent holds no
  // read on the mixed store. (v3: this all moved off the manager — the manager is lifecycle-only; it
  // records the read-ACL at mint via commitAcl.) See `.internal/research/stage4-impl-design.md`.

  /** The Plane-3 registries, manager and daemon-renewal leases, and durable membership writes of this
   *  endpoint. Every dependency is read when it is used, so a field assigned after construction is seen. */
  private readonly durableBackstop: EndpointDurableBackstop = new EndpointDurableBackstop(this.identity, this.conn, {
    authed: () => this.authed,
    notLiveMsg: () => this.notLiveMsg(),
  }, this.parts);

  /** Privileged ({@link DurableProvisioner}): record an agent's read ACL in the durable registry at
   *  provision/mint time — the same act as baking it into the JWT, persisted so the server-side
   *  delivery daemon can re-authorize the agent's durable entries and validate its runtime
   *  durable-joins without holding any in-memory ledger. Written ATOMICALLY ({@link writeAclRecord}),
   *  so a present record is always complete (`[]` = known no-read, never a half-write). */
  async commitAcl(targetId: string, lifecycleUid: string, allowSubscribe: string[]): Promise<void> {
    return this.durableBackstop.commitAcl(targetId, lifecycleUid, allowSubscribe);
  }

  /**
   * Raise the mint-time ACL ceiling. Provision/remint only — see {@link reissueAcl}.
   * Process discipline: call only in the same act that bakes `allowSubscribe` into the JWT; the
   * write is not crypto-bound to credential bytes.
   */
  async reissueAcl(targetId: string, lifecycleUid: string, allowSubscribe: string[]): Promise<void> {
    return this.durableBackstop.reissueAcl(targetId, lifecycleUid, allowSubscribe);
  }

  /** The server-side delivery daemon's fresh-per-entry ACL read: one LIFECYCLE's current read ACL
   *  (`allowSubscribe`) from the durable registry (exact key `<owner>.<actor>.<uid>`), or `undefined`
   *  if no record (an unknown lifecycle — the reader DEFERS, never drops). A present `[]` (known
   *  no-read) returns `[]` (the reader DROPS). */
  async aclForOwner(owner: string, lifecycleUid: string): Promise<string[] | undefined> {
    return this.durableBackstop.aclForOwner(owner, lifecycleUid);
  }

  /** Resolve an ALIAS to its single live lifecycle-keyed ACL row (`readAclForAlias`): the daemon's
   *  authz seam for callers that arrive with alias identity only (a `ctl.delivery` durable-join).
   *  THROWS {@link AmbiguousAclAlias} on two live rows — first-match would let a stale lifecycle
   *  authorize the successor (SPEC 13.1: at most one live lifecycle per alias). */
  async aclForAlias(principal: string): Promise<{
    allowSubscribe: string[];
    issuedAllowSubscribe: string[];
    lifecycleUid: string;
  } | undefined> {
    return this.durableBackstop.aclForAlias(principal);
  }

  /** Is this shard's lease row one THIS ENDPOINT INSTANCE wrote? The question a daemon whose renew
   *  just failed has to answer before it decides whether it still owns the shard.
   *
   *  Both halves are required. `holder` alone is not sufficient (a successor daemon re-reading the
   *  same creds file presents the same principal, so its row would read as ours), and `incarnation`
   *  alone is not sufficient either, it is a bare uuid with no claim to the principal, so a row
   *  bearing ours but a foreign holder is not something we should ever adopt. A row with NO
   *  incarnation predates the field and cannot be proven ours, which is the safe reading: it leads
   *  to the takeover path rather than to serving on someone else's claim. */
  ownsDeliveryLease(info: DeliveryLeaseInfo): boolean {
    return this.deliveryLease.ownsDeliveryLease(info);
  }

  /** Acquire the single-flight delivery lease for a shard via an ATOMIC CAS create, marked NOT-ready.
   *  THROWS if a live lease exists — a loud refusal-to-bind (the daemon exits), never a retry, so two
   *  daemons can't split a durable's delivery. A crashed holder's lease auto-expires (bucket TTL),
   *  freeing a re-acquire. Acquired BEFORE binding (single-flight gate); {@link markDeliveryLeaseReady}
   *  flips it ready AFTER the loops + `ctl.delivery` are bound. Returns the lease revision. */
  async acquireDeliveryLease(shardIndex: number): Promise<number> {
    return this.deliveryLease.acquireDeliveryLease(shardIndex);
  }

  /** Flip the held lease to READY (CAS `kv.update`) AFTER `startPlane3` has bound the loops + the
   *  `ctl.delivery` responder — so "lease ready" proves the responder is up, not just that the slot was
   *  claimed. Returns the new revision. */
  async markDeliveryLeaseReady(shardIndex: number, revision: number): Promise<number> {
    return this.deliveryLease.markDeliveryLeaseReady(shardIndex, revision);
  }

  /** Flip the held lease back to NOT-ready, the counterpart to {@link markDeliveryLeaseReady}, for a
   *  holder that has UNBOUND its loops and control responder but has not given up the shard.
   *
   *  `ready` is a claim about the RESPONDER, not about the row's existence: `ensureDelivery` waits on
   *  it and the channel-health surface reports it. A daemon that goes quiet to re-check its ownership
   *  still holds the key, so without this the space would be told a responder is up while nothing is
   *  bound, a readiness lie of exactly the kind #1318 is about, just pointed the other way. Keeping
   *  the row (rather than deleting it) is deliberate: the shard is still claimed, so no third daemon
   *  should be invited in; what is being withdrawn is only the claim to be answering. */
  async markDeliveryLeaseNotReady(shardIndex: number, revision: number): Promise<number> {
    return this.deliveryLease.markDeliveryLeaseNotReady(shardIndex, revision);
  }

  /** Renew the held lease (CAS `kv.update` against `revision`, keeping `ready:true`) to refresh it before
   *  the bucket TTL expires it. Returns the new revision. Throws if the revision moved (lost the lease —
   *  the daemon should exit). */
  async renewDeliveryLease(shardIndex: number, revision: number): Promise<number> {
    return this.deliveryLease.renewDeliveryLease(shardIndex, revision);
  }

  /** Release the held lease on clean shutdown so a replacement daemon re-acquires immediately (a
   *  crash just lets the bucket TTL expire it).
   *
   *  THE REVISION IS WHAT MAKES THIS A RELEASE RATHER THAN A DELETE. An unconditional delete removes
   *  whatever row is there, and by shutdown time the row is not necessarily still ours: the exit
   *  paths that matter most are precisely the ones where another daemon has taken the shard, so the
   *  departing process would delete the REPLACEMENT's lease on its way out and leave the shard with
   *  no holder at all. Passing the revision this endpoint last owned makes the delete a compare-and-
   *  swap (`previousSeq` becomes JetStream's `ExpectedLastSubjectSequence`), so a row that has moved
   *  on is left alone.
   *
   *  A RELEASE THAT DID NOT COMMIT REJECTS. The broker's CAS refusal and any broker failure reach the
   *  caller, because only the caller knows whether that matters: a shutdown that must finish anyway
   *  catches it, and a close that reports whether a successor can start learns the outcome here.
   *
   *  THE ARGUMENT IS REQUIRED, AND EXPLICITLY NULLABLE RATHER THAN OPTIONAL. `undefined` means "this
   *  process no longer holds a revision it can argue for", which is the takeover paths' honest
   *  answer and correctly releases nothing, the bucket TTL is the crash-safe authority and expires
   *  a genuinely stale row. But if that were the DEFAULT, every existing `releaseDeliveryLease(0)`
   *  call site would keep compiling and silently stop releasing: the same omission hole
   *  `standaloneConnectOpts` closed by deleting its `= {}`. Measured, not theorised, this landed as
   *  a red in `smoke:delivery-lease`, where a caller that genuinely held the lease released nothing
   *  and the next acquire was refused. A caller must now say which it means. */
  async releaseDeliveryLease(shardIndex: number, revision: number | undefined): Promise<void> {
    return this.deliveryLease.releaseDeliveryLease(shardIndex, revision);
  }

  /** Read a shard's delivery lease (the daemon-availability signal), or `undefined` if none is live.
   *  READ-ONLY surface — drives Component 6's `cotal_channels` delivery-health field (an agent reads it
   *  under its own cred, which holds lease-bucket read but no write). */
  async readDeliveryLease(shardIndex: number): Promise<DeliveryLeaseInfo | undefined> {
    return this.deliveryLease.readDeliveryLease(shardIndex);
  }

  /** Watch THIS shard's lease key and nothing else, for the daemon's loss trigger (#1596).
   *
   *  A KV watch is the native JetStream push for "the row changed hands NOW": a filtered ordered
   *  consumer on the lease bucket delivers the row's own writes the moment the broker applies them,
   *  instead of the daemon waiting for its next renew tick to notice. The watch is a TRIGGER, never a
   *  decision: every event is handed to `onEvent` with the row as the broker now states it (PUT) or
   *  the fact it is gone (DEL/PURGE, `info` undefined), and the caller re-runs the SAME decision tree
   *  its renew tick would (`leaseAction`, `mayServeOn`, `readOwnLease`-style ownership tests). An
   *  event the daemon itself caused (its acquire, its renew, its ready flip) is an ordinary input to
   *  that tree — the row still reads `held` by this endpoint — so it never quiesces on its own write;
   *  no event filtering happens here.
   *
   *  Like the presence watch, this survives a connection rebuild as INTENT: the iterator dies with
   *  its connection and {@link EndpointConnection.connectAndBind} rebinds it onto the fresh one, so a reconnect can
   *  never leave the daemon blind to the row for the rest of its life. The rebind replays the
   *  bucket's current last-per-subject state, so a change that landed during the null window is
   *  delivered on the fresh watch. Resolves a stop handle. */
  async watchDeliveryLease(shardIndex: number, onEvent: (info: DeliveryLeaseInfo | undefined) => void): Promise<() => void> {
    return this.deliveryLease.watchDeliveryLease(shardIndex, onEvent);
  }

  /** The principal recorded as holding a shard's delivery lease, read by THIS process from the row,
   *  or `undefined` when no row is live or the read failed.
   *
   *  THE POINT IS WHO ESTABLISHES THE FACT. Everything a requester learns from a request/reply rail
   *  is something a responder chose to send, and the delivery-admin rail is queue-grouped, so any
   *  process permitted to serve it decides what arrives. The lease row is the other kind of fact: a
   *  KV key whose only writer is the `delivery` credential's own `lease.*` grant, read here under
   *  THIS endpoint's credential, which no reply on any rail participates in. A caller comparing an
   *  answerer against the holder needs that, rather than the answerer's word for which one it is.
   *
   *  `undefined` is a genuine unknown and is NEVER a statement that nobody holds the shard: a read
   *  that throws (a denied or unreadable bucket, a broker that will not answer) must not collapse
   *  into "nothing is there". Callers must treat it as a failure to determine (#1694). */
  async deliveryLeaseHolder(shardIndex: number): Promise<string | undefined> {
    return this.deliveryLease.deliveryLeaseHolder(shardIndex);
  }

  /** The lease row AND the KV revision it is at. The revision is the CAS token every renew and the
   *  CAS release are argued against, so a caller re-establishing ownership after a failed renew
   *  needs the BROKER's sequence, not the one it last cached: a renew can fail with its write
   *  already applied (a lost reply, a reconnect mid-request), which leaves the cached revision one
   *  behind forever and every subsequent CAS refused over a sequence this process itself moved ,
   *  read as somebody else's takeover, which is the #1318 misreading in a second costume.
   *
   *  ABSENT and UNREADABLE are different facts and this method keeps them apart (#1694): `undefined`
   *  means NO row is live (no key, or DEL/PURGE), while a key that EXISTS but does not parse as a
   *  {@link DeliveryLeaseInfo} THROWS. Folding the parse failure into `undefined` made a live-but-
   *  corrupt row read as "nothing there", and the store-identity challenge's absence settlement
   *  then certified a remint over a row it could not read. A caller that wants the old swallow
   *  (an owner testing "is this provably MINE") still gets its safe answer: an unparseable row is
   *  not provably anyone's, and catching here reads as `false` exactly as before. */
  async readDeliveryLeaseEntry(shardIndex: number): Promise<{ info: DeliveryLeaseInfo; revision: number } | undefined> {
    return this.deliveryLease.readDeliveryLeaseEntry(shardIndex);
  }
  /** Take or keep the per-SPACE daemon-credential renewal lease (#1634), returning whether THIS
   *  instance now holds it. One atomic CAS `create` per pass: it succeeds for whoever arrives first
   *  and throws for everyone else, so exactly one manager remints even when several share the
   *  daemon's store. The holder re-`update`s its own key by revision, which both keeps it and proves
   *  it never lost it. Losing the CAS is an ordinary outcome (a peer holds it) and returns false; it
   *  never fails a start. A crashed holder's key TTL-expires with the bucket, so the next pass hands
   *  the lease to a survivor with no operator step. */
  async holdDaemonRenewalLease(instanceId: string): Promise<boolean> {
    return this.durableBackstop.holdDaemonRenewalLease(instanceId);
  }

  /** Release the renewal lease on a clean stop so a peer takes over at once rather than at the TTL.
   *  CAS-guarded, so a lease we already lost is never deleted out from under its new holder. */
  async releaseDaemonRenewalLease(): Promise<void> {
    return this.durableBackstop.releaseDaemonRenewalLease();
  }

  /** Read the per-space daemon-credential renewal-lease row (the one {@link holdDaemonRenewalLease}
   *  CAS-writes), or `undefined` when nothing holds it. A `doctor auth --fix` that lost `hold` calls
   *  this through the SAME bucket the hold attempt opened, to name the live holder in its refusal —
   *  `managerLeaseKv` is private, so this is the exported read beside {@link readManagerLease}. */
  async readDaemonRenewalLease(): Promise<{ instanceId: string; since: number } | undefined> {
    return this.durableBackstop.readDaemonRenewalLease();
  }
  /** Acquire THIS logical instance's liveness lease via ATOMIC CAS create on its own per-instance key
   *  ({@link managerLeaseKey}). THROWS only if that SAME instance id already holds a live key (a same-root
   *  concurrent double-start, or a restart racing the crashed predecessor's not-yet-expired key) — a loud
   *  refusal, never a retry. A DIFFERENT instance (second workspace root ⇒ different id) creates its OWN
   *  key and coexists. A crashed holder's key auto-expires (bucket TTL). Returns the
   *  lease revision (for renew). */
  async acquireManagerLease(info: Omit<ManagerLeaseInfo, "since">): Promise<number> {
    return this.durableBackstop.acquireManagerLease(info);
  }
  /** Renew THIS instance's held key (CAS update against `revision`) before the bucket TTL expires it.
   *  Throws if the revision moved (lost the lease). Returns the new revision. */
  async renewManagerLease(info: Omit<ManagerLeaseInfo, "since">, revision: number): Promise<number> {
    return this.durableBackstop.renewManagerLease(info, revision);
  }
  /** Read THIS instance's OWN lease key, keyed (not the `lease.*` sweep {@link readManagerLease} does).
   *
   *  `undefined` means the key IS NOT THERE — a definite absence, established by a completed read.
   *  A read that could not be completed THROWS instead, so a caller can tell "it is gone" from "I could
   *  not find out". That distinction is the whole point of the method: a renew that got no answer has
   *  proved nothing, and only a definite answer here may be acted on.
   *
   *  `created` is the broker's write time of the row (epoch ms), which is what the bucket TTL counts
   *  from. */
  async readOwnManagerLease(instanceId: string): Promise<{ info: ManagerLeaseInfo; revision: number; created: number } | undefined> {
    return this.durableBackstop.readOwnManagerLease(instanceId);
  }
  /** Release THIS instance's key on clean shutdown so a same-id restart re-acquires immediately. CAS-guarded
   *  by `revision`: if we already LOST it (renew gap) the stored revision has moved, and the conditional
   *  delete is refused and rejects, like any broker failure; a shutdown that must finish anyway catches
   *  it. Keyed per instance, so a release NEVER touches a sibling manager's key (security pin 6). */
  async releaseManagerLease(instanceId: string, revision?: number): Promise<void> {
    return this.durableBackstop.releaseManagerLease(instanceId, revision);
  }
  /** Read a live manager liveness lease, or undefined if NONE (no manager instance holds the space). A
   *  presence/existence check for the CLI's `spawn -f` reuse and `waitLeaseGone`, which only need "is any
   *  manager here". Open-only — never creates the bucket, so a probe that finds no manager leaves none
   *  behind. (Instance-precise enumeration for the class scatter comes from the registration records KV
   *  in 3b-4, not this liveness bucket.)
   *
   *  MULTI-INSTANCE EXACT, and it has to be read that way rather than as a point get. Several managers
   *  may hold one space, each renewing its own `lease.<instanceId>`. A single `last_by_subj` over
   *  `lease.*` returns the newest message under the wildcard REGARDLESS OF KEY — so a stopping peer's
   *  DEL tombstone, being newest, answered "no manager here" while a sibling was alive and renewing.
   *  Only an explicit `kv.delete` writes that tombstone: a manager whose lease TTL-expires is removed by
   *  limits and leaves nothing behind, so the poisoning case was the ORDINARY one (stop a manager
   *  cleanly, then `spawn -f`), not the crash. Enumerating live entries collapses to the greatest
   *  revision PER KEY and drops keys whose final state is a marker, so a peer's DEL can only retire that
   *  peer's own key and can never mask a live one. */
  async readManagerLease(): Promise<ManagerLeaseInfo | undefined> {
    return this.durableBackstop.readManagerLease();
  }

  /** Privileged: one owner's NON-TOMBSTONED durable memberships as `{channel, generation, activated}` —
   *  the server-side delivery daemon serves this to a connecting agent (the `listMemberships` op on
   *  `ctl.delivery`). The agent seeds its leave mirror from the ACTIVATED ones (the confirmed backstops),
   *  but the non-activated ones are returned too so `leaveChannel` can discover + close a record that
   *  still routes under the pure-interval predicate (a crash-stuck pending activation) — without reading
   *  the privileged KV itself. */
  async ownerMemberships(owner: string, lifecycleUid: string): Promise<{ channel: string; generation: number; activated: boolean }[]> {
    return this.durableBackstop.ownerMemberships(owner, lifecycleUid);
  }

  /** Effective delivery class read AUTHORITATIVELY from the registry KV (not the watch cache) — so a
   *  `live`→`durable` flip is seen by fan-out without a cache-propagation gap (red-team MED-3), and a
   *  reader just started need not wait for the cache to fill. */
  async deliveryClassFresh(channel: string): Promise<DeliveryClass> {
    return this.durableBackstop.deliveryClassFresh(channel);
  }

  /**
   * Privileged durable-JOIN write (v3: the delivery daemon calls this from its `ctl.delivery` handler
   * after validating channel ⊆ the caller's read ACL): capture `joinCursor`, commit a `durable-active`
   * record (CAS + generation bump), then ACTIVATION CATCH-UP idempotently copies `(joinCursor, fence]`
   * into the owner inbox where `fence = max(frontier, fanoutDelivered)` — fan-out owns `seq > fence`.
   * Idempotent against a timeout-retry (an already-activated membership no-ops). Returns `{durable:false}`
   * only when a concurrent leave or rejoin superseded the activation. Catch-up copies what the stream
   * still holds and does not judge retention: a post the history limit removed before its copy was
   * taken is outside the durable guarantee (SPEC §4), and stream state cannot show which channel a
   * removed sequence belonged to.
   *
   * Runs on the daemon (which hosts the fan-out/reader loops + the members KV), so catch-up + the
   * activation fence read are in-process — no cross-process cursor read.
   *
   * `aclFence` (the `ctl.delivery` join always sets it) re-reads the lifecycle's exact ACL row
   * immediately before the write that creates or reopens its row, and again after it. When the channel
   * is no longer within that row, the join is refused, and a row it already wrote is removed first.
   * A retirement narrows that ACL row before it reads the lifecycle's inventory (fenceLifecycleAcl),
   * so a row written too late for the inventory removes itself, whichever daemon process wrote it.
   * Without the option the write is a privileged assertion that consults no ACL.
   */
  async durableJoinFor(
    owner: string,
    channel: string,
    lifecycleUid: string,
    opts: { aclFence?: boolean } = {},
  ): Promise<{ durable: boolean; reason?: string; generation?: number }> {
    return this.durableBackstop.durableJoinFor(owner, channel, lifecycleUid, opts);
  }

  /** The agent-side durable membership of this endpoint. Every dependency is read when it is used, so a
   *  field assigned after construction is seen. */
  private readonly durable: EndpointDurable = new EndpointDurable(this.identity, this.conn, this.lifecycle, this.delivery, {
    requireLifecycleUid: (what) => this.requireLifecycleUid(what),
    emitRecoverable: (err) => this.emitRecoverable(err),
  }, this.parts);

  /** Privileged durable-LEAVE write: tombstone the membership at `leaveCursor = frontier` so the
   *  backstop denies `seq > leaveCursor` while a pre-leave entry stays deliverable (SPEC §7 interval). */
  async durableLeaveFor(owner: string, channel: string, lifecycleUid: string, expectedGeneration?: number): Promise<void> {
    return this.durableBackstop.durableLeaveFor(owner, channel, lifecycleUid, expectedGeneration);
  }

  /** Start the Plane-3 fan-out writer + trusted reader on THIS (privileged, server-side delivery-daemon)
   *  endpoint, AND serve the `ctl.delivery` control service (runtime durable join/leave/list). `aclFor`
   *  maps an owner id to its current read ACL for the reader's re-authorization — read FRESH per entry
   *  from the durable ACL registry (async). Call once after connect; idempotent durable creation lets it
   *  resume on a daemon restart. Both the JS loops AND the `ctl.delivery` subscription are (re)bound by
   *  {@link EndpointDeliveryPlane.armPlane3} on EVERY (re)connect — a reconnect drains the old connection, so re-binding both
   *  is required, not optional (the responder would otherwise be lost on a broker blip). */
  async startPlane3(
    aclFor: (owner: string, lifecycleUid: string) => MaybePromise<string[] | undefined>,
    opts: Parameters<EndpointDeliveryPlane["startPlane3"]>[1] = {},
  ): Promise<void> {
    return this.deliveryPlane.startPlane3(aclFor, opts);
  }

  /** Stop serving Plane-3 WITHOUT tearing down the connection, so a daemon that has just learned its
   *  lease may no longer be its own can stop acting on the shard while it finds out for certain.
   *
   *  A COMPARE-AND-SWAP KEEPS ONE LEASE ROW; IT DOES NOT KEEP ONE SERVER. That distinction is the
   *  reason this exists, and it was a review finding. When a renew fails, the daemon re-reads the
   *  key and may then re-acquire it, and across that read-then-create it was still consuming the
   *  fan-out durable, still running the inbox reader, and still answering ctl.delivery. If a
   *  replacement acquired the shard in that window, both processes served the same durables until
   *  the loser's create was refused and its teardown finished. The old code did not have this
   *  window, because it began shutting down on the first renew failure; treating that failure as a
   *  question instead of a verdict is right, but asking the question while still serving is not.
   *
   *  So the daemon goes quiet FIRST and re-arms only once it has proof: `held` on a re-read, or a
   *  won atomic create. `unknown` stays quiet, the whole point is that not being able to ask is not
   *  permission to keep acting. Quiescing costs delivery latency for a few seconds; the alternative
   *  costs a SPLIT durable, which is a correctness failure rather than an availability one.
   *
   *  Deliberately not `stop()`: the connection, the lease KV handles and the control rails must stay
   *  up, because the daemon still has to ask the broker who owns the shard. */
  async quiescePlane3(): Promise<void> {
    return this.deliveryPlane.quiescePlane3();
  }

  /** Whether Plane-3 is currently quiesced: unbound, and refusing to re-bind until ownership is proven.
   *  Read-only. The flag is the daemon's own answer to "am I serving this shard", so a cell that asserts
   *  a recovery worked can check the endpoint's state rather than inferring it from a log line. */
  plane3IsQuiesced(): boolean {
    return this.deliveryPlane.plane3IsQuiesced();
  }

  /** Resume serving Plane-3 after {@link quiescePlane3}, once ownership has been re-established.
   *  Idempotent, and a no-op when the daemon was never quiesced.
   *
   *  The flag is cleared ONLY after every binding is up, and restored if any of them throws. Clearing
   *  it first looks equivalent and is not: `armPlane3` binds in four stages (`manager`, the two control
   *  responders, the fan-out consumer, the reader), so a failure at any one leaves the endpoint recorded
   *  as un-quiesced while some of those are missing. From there every later `rearmPlane3` returns at the
   *  `!plane3Quiesced` guard WITHOUT attempting to bind, and the caller goes on to flip the lease READY.
   *  That is a readiness lie surviving a transient broker error, the daemon claims a responder it does
   *  not have, which is the #1318 outage wearing the readiness flag instead of the exit path. */
  async rearmPlane3(): Promise<void> {
    return this.deliveryPlane.rearmPlane3();
  }

  /** The anycast request rail of this endpoint. Every dependency is read when it is used, so a field
   *  assigned after construction is seen. */
  private readonly anycastRail: EndpointAnycast = new EndpointAnycast(this.identity, this.conn, this.delivery, {
    authed: () => this.authed,
    emitRecoverable: (err) => this.emitRecoverable(err),
    notLiveMsg: () => this.notLiveMsg(),
    ref: () => this.ref(),
  }, this.parts);

  // ---- the peer-readable liveness surface (#1577) --------------------------

  /** The peer-readable liveness responders and the probe, of this endpoint. Every dependency is read
   *  when it is used, so a field assigned after construction is seen. */
  private readonly liveness = new EndpointLiveness(this.identity, this.conn, this.delivery, {
    notLiveMsg: () => this.notLiveMsg(),
    emitRecoverable: (err) => this.emitRecoverable(err),
    emit: (event, ...args) => this.emit(event, ...args),
  }, this.parts);

  /** Bind this endpoint as the liveness RESPONDER for one plane, answering presence and nothing
   *  else to any credentialed peer that asks (`live.<plane>.<owner>.<actor>`).
   *
   *  THE HANDLER IS THE PRIVACY BOUNDARY, and that is the entire reason this is a request/reply
   *  probe rather than a KV read grant. `readState` returns the responder's OWN verdict, derived
   *  from the lease it can already read; the LEASE ROW NEVER LEAVES THIS PROCESS. A peer therefore
   *  learns one enum about one plane and cannot learn the holder, the workspace root, the pid, the
   *  instance id, the runtime, or that any of those exist. Handing a peer the manager bucket instead
   *  would have handed it the operator's filesystem path and a pid to signal.
   *
   *  `queue`-grouped by plane, so several manager instances in one space answer a probe ONCE rather
   *  than N times. A queue group is correct here and would be wrong on a roster-style surface: the
   *  question is "is ANY responder bound", which any one member can answer.
   *
   *  THE ANSWER NAMES WHICH RESPONDER GAVE IT (`instance`), and that field exists because the queue
   *  group alone leaves a real ambiguity. Manager instances coexist per instance id by design, each
   *  member answers only about ITSELF, and the group delivers one probe to an arbitrary member. So
   *  when two instances hold opposite verdicts, identical probes alternate between them, and without
   *  a discriminator the two answers are indistinguishable from one instance changing state. With
   *  the field, a caller that probes more than once can see that two DIFFERENT responders answered
   *  and that the verdicts disagree. The field is the responder's own endpoint-scoped instance
   *  token, never the lease row's `instanceId`, its holder, its pid or its root: see
   *  {@link LivenessAnswer} for why none of those may cross the wire.
   *
   *  ONE PROBE STILL SAMPLES ONE MEMBER. This does not aggregate N instances, and a single probe
   *  cannot report a split; it makes the split OBSERVABLE to a caller that asks again, where before
   *  it was not observable at all.
   *
   *  BOUNDED REPLY, for the same confused-deputy reason `serveControl` documents: this responder
   *  holds a wildcard publish grant over `live.<plane>.*.*.reply.>`, so without the bound check an
   *  authenticated caller could name a PEER's reply lane as its reply target and have us publish
   *  into it. The broker does not permission-check a requester's embedded reply subject; we do.
   *
   *  A HANDLER THAT THROWS ANSWERS `unknown`, never silence and never health. Silence would reach
   *  the prober as a timeout, which it correctly grades `unknown` anyway — but only after burning
   *  the full deadline, and an operator staring at a hung probe learns less than one told plainly
   *  that the axis could not be checked.
   *
   *  THE BINDING IS KEPT AS INTENT and re-bound on every (re)connect, so a reconnect does not leave
   *  the plane answered by the broker's no-responders status while this endpoint is serving. A second
   *  call for the same plane replaces the first. */
  serveLiveness(plane: LivenessPlane, readState: () => Promise<ResponderState> | ResponderState): void {
    return this.liveness.serveLiveness(plane, readState);
  }

  /** Bind the liveness responder for the DELIVERY plane, grading itself from its own shard-0 lease
   *  through the shared classifier. The daemon is the one process that can answer this honestly: it
   *  knows its own incarnation, so a predecessor's `ready:true` corpse in the bucket classifies
   *  `stale` rather than as its own health.
   *
   *  It reads the lease at PROBE time rather than caching a flag set at bind time. A cached flag
   *  would answer `bound` for as long as this process lived, including after it had lost the shard
   *  and stood down — a responder that reports its intent instead of its state, which is the whole
   *  family of bug this issue is about. */
  serveDeliveryLiveness(shardIndex = 0): void {
    this.serveLiveness("delivery", async () =>
      responderFromLease(await this.readDeliveryLease(shardIndex), this.card.id));
  }

  /** Ask whether a responder is bound for `plane`, as a credentialed peer that need not own it.
   *
   *  EVERY WAY THIS CAN END IS CLASSIFIED, and the classification lives in ONE place
   *  ({@link responderFromProbe}) so no call site can invent its own mapping. Only the broker's own
   *  no-responders 503 becomes `unbound`. A timeout, a permission refusal, a transport failure and
   *  an unreadable reply ALL become `unknown`, because each is a failure to find out, and this
   *  issue exists because failures to find out were being reported as findings.
   *
   *  `noMux` with a named reply subject is required rather than stylistic: the muxed inbox would
   *  swallow the 503 into an ordinary timeout, and the 503 is the only outcome that carries a
   *  positive verdict. Collapsing it would leave a probe that can say `bound` or `unknown` and
   *  never `unbound` — an instrument that cannot report the failure it was built to report.
   *
   *  The reply rides `<request>.reply.<uuid>`, the sender's own subtree, so the responder's bound
   *  reply guard accepts it and the responder needs no broad inbox-publish grant to answer. */
  async probeLiveness(plane: string, timeoutMs = 2_000): Promise<LivenessAnswer> {
    return this.liveness.probeLiveness(plane, timeoutMs);
  }

  /**
   * Serve this process's `agent` endpoint on the principal route (SPEC 13.21, 13.22): the
   * `AGENT_CLUSTER` command set about this principal, addressed by its own principal, lifecycle UID
   * and runtime id, with no registration. `handlers` serves the cluster's commands with
   * `AGENT_CONTRACTS`; `describe` is built in.
   *
   * Serves under a user-auth or static credential, whose rows name who may call, and on an open mesh,
   * where the broker confines no caller (SPEC 13.21). Throws without a lifecycle UID, before the
   * endpoint has started, while it already serves `agent`, for an
   * `endpoint` or `cluster` field, which this entry point does not take, and for a set of handlers
   * that is not the cluster's commands with its contracts. It subscribes this process's own subject
   * with no queue group.
   *
   * `ready` is a positive check: it resolves only after the broker accepted the subscription
   * (subscribe, flush, and no permission violation for that subject), and rejects with the
   * refusal, which a credential minted before the rows existed gets. The serve is INTENT: every
   * replaced connection subscribes again and runs the check again, and a refusal there ends the
   * serve, resolves `failed` and clears the presence field. `stop` unsubscribes, aborts the
   * handlers' `signal`, and waits for each handler in flight until its request's deadline at most.
   */
  servePrincipal(spec: { handlers: EpPrincipalCommandDef[] }): PrincipalServe {
    return this.principalServe.servePrincipal(spec);
  }

  /** The principal serve and prompts of this endpoint. Every dependency is read when it is used, and
   *  every endpoint method is looked up at call time, so a member a caller replaced on the endpoint runs. */
  private readonly principalServe = new EndpointPrincipalServe(this.identity, this.conn, this.delivery, {
    principalServers: () => principalServers,
    emitRecoverable: (err) => this.emitRecoverable(err),
    requireLifecycleUid: (what) => this.requireLifecycleUid(what),
    notLiveMsg: () => this.notLiveMsg(),
  }, this.parts);

  /** Set this process's `prompts` presence field and write presence at once (SPEC §6): how many
   *  prompts it holds `open` or `sent`, and a counter that goes up by one each time a prompt opens or
   *  changes state. The field shows only while the `agent` endpoint is served and the broker accepted
   *  its subscription on the current connection. Until this is called it shows `open: 0` with the
   *  fresh `seq` the serve took from {@link nextPromptsSeq} when it started. Throws when the `agent`
   *  endpoint is not served, and a RangeError for a `seq` below one this runtime already used. */
  async setPromptsPresence(prompts: PresencePrompts): Promise<void> {
    return this.principalServe.setPromptsPresence(prompts);
  }

  /** Take the next `prompts` `seq` for this process's runtime (SPEC §6): 0 the first time, then one
   *  above every `seq` this process used under its runtime id, whichever endpoint object used it. A
   *  prompt desk takes every `seq` it shows from here. Throws without a lifecycle UID. */
  nextPromptsSeq(): number {
    return this.principalServe.nextPromptsSeq();
  }

  /** Set this process's `agentEndpoint` presence field (SPEC §6): the `agent` endpoint commands it
   *  serves now, shown under the same gate as `prompts`. Presence is written when the value changed.
   *  Throws when the `agent` endpoint is not served, and a TypeError for a flag that is not boolean. */
  async setAgentEndpointPresence(served: PresenceAgentEndpoint): Promise<void> {
    return this.principalServe.setAgentEndpointPresence(served);
  }

  /**
   * Call one command of a principal's own endpoint on the principal route (SPEC 13.21), as this
   * endpoint's caller triple with the authority word its row covers. `principal` is the addressed
   * process: owner, actor, lifecycle UID and the `runtime.id` its presence publishes. Presence is
   * advisory, and a wrong value reaches a subject nobody serves or one this caller's row does not
   * cover. It cannot widen authority.
   *
   * The `agent` endpoint's contracts and `describe`'s are built in; any other endpoint needs
   * `contract`. Resolves the reply, whose `ok: false` is the agent's own refusal; throws
   * `unavailable` (`not-executed`) when nothing serves that process, `permission-denied`
   * (`not-executed`) when this credential holds no row for the request, and `deadline-exceeded`
   * (`unknown`) when no reply came. See {@link epPrincipalCall}.
   */
  async callPrincipal(call: {
    endpoint: string;
    principal: EpPrincipal;
    command: string;
    authority: PrincipalAuthority;
    args?: Record<string, unknown>;
    deadlineMs: number;
    contract?: { input: CompiledContract; output: CompiledContract };
    signal?: AbortSignal;
  }): Promise<EndpointReply> {
    return this.principalServe.callPrincipal(call);
  }

  /** Agent-side: request a Plane-3 durable backstop for a channel via the server-side delivery daemon (ctl.delivery). Throws
   *  when no privileged writer is present (open / no delivery daemon). 30s timeout — activation catch-up may
   *  run before the reply (the window is small, but a busy channel can take more than the 5s default). */
  durableJoinChannel(channel: string): Promise<{ durable: boolean; reason?: string; generation?: number }> {
    return this.durable.durableJoinChannel(channel);
  }

  /** Agent-side: release a Plane-3 durable backstop (tombstone membership at the leave cursor). Passes
   *  the join generation so a stale leave can't tombstone a newer rejoin (the delivery daemon validates
   *  it) AND this incarnation's lifecycleUid — membership rows are lifecycle-keyed (SPEC 13.1), and a
   *  leave must resolve the selected principal-owned row even after the ACL row was narrowed or purged. */
  durableLeaveChannel(channel: string, generation?: number, lifecycleUid?: string): Promise<void> {
    return this.durable.durableLeaveChannel(channel, generation, lifecycleUid);
  }

  /** Channels with a Plane-3 durable membership whose §7 tombstone is still pending after a refused live
   *  sub (see {@link EndpointDurable.closeRefusedMembership}) — surfaced by the connector as a `durable-unclosed` state so
   *  it is never presented as ordinary "not subscribed". */
  pendingDurableLeaves(): string[] {
    return this.durable.pendingDurableLeaves();
  }

  /** The status of one of this endpoint's own anycast requests, from the delivery daemon's record
   *  or, with no record, from the queue (SPEC §8.1). `id` narrows the answer to that request. Throws
   *  on an open mesh, which runs no delivery daemon. */
  anycastStatus(seq: number, id?: string): Promise<AnycastStatus> {
    return this.anycastRail.anycastStatus(seq, id);
  }

  /** Cancel one of this endpoint's own anycast requests while it waits. A request a holder already
   *  took is refused, and the returned status names the taker. */
  cancelAnycast(seq: number, id?: string): Promise<AnycastStatus> {
    return this.anycastRail.cancelAnycast(seq, id);
  }

  /** The boot durable self-join and its reconcile, and the membership read the leave path uses, of
   *  this endpoint. Every dependency is read when it is used, and every endpoint method is looked up
   *  at call time, so a test that replaces one on the endpoint is seen here. */
  private readonly bootMemberships = new EndpointBootMemberships(this.identity, this.lifecycle, this.delivery, {
    requireLifecycleUid: (what) => this.requireLifecycleUid(what),
    emitRecoverable: (err) => this.emitRecoverable(err),
  }, this.parts);

  /** Agent-side: current lifecycle memberships, or all principal-owned rows for an explicit channel,
   *  from the delivery service. The agent holds no read on the privileged members KV. `undefined` ⇒ NO control responder
   *  (open / no delivery daemon, so there is no Plane-3 and no memberships). THROWS on a responder-present RPC
   *  failure, so a caller can FAIL-CLOSED rather than mistaking a transient error for "no membership". */
  async fetchMemberships(channel?: string): Promise<{ channel: string; generation: number; activated: boolean; lifecycleUid?: string }[] | undefined> {
    return this.bootMemberships.fetchMemberships(channel);
  }

  /** True if this session holds an established Plane-3 durable membership for `channel` (in `plane3Channels`).
   *  Drives the membership-aware delivery-health surface: a joined durable channel that is NOT yet a member
   *  (boot self-join pending / daemon down) must render degraded, never "active" off a live lease alone. */
  hasDurableMembership(channel: string): boolean {
    return this.bootMemberships.hasDurableMembership(channel);
  }

  /** The durable consumers of this endpoint. Every dependency is read when it is used, so a field
   *  assigned after construction is seen. */
  private readonly consumers: EndpointConsumers = new EndpointConsumers(this.identity, this.conn, this.lifecycle, this.delivery, {
    authed: () => this.authed,
    notLiveMsg: () => this.notLiveMsg(),
    requireLifecycleUid: (what) => this.requireLifecycleUid(what),
    armJoin: (channels) => this.armJoin(channels),
    emitRecoverable: (err) => this.emitRecoverable(err),
    emit: (event, ...args) => this.emit(event, ...args),
  }, this.parts);

  /** Current frontier (last sequence) of the chat stream — a channel's join watermark, the
   *  focus-watermark a connector captures on entering `focus` (recall reads ambient after it), and
   *  the backfill floor a preservation cut records for each retained seat. The manager reads it in
   *  open mode over its own `consume: false` endpoint, which binds no JetStream manager at start, so
   *  the manager is obtained lazily here rather than assumed. */
  async chatFrontier(): Promise<number> {
    return this.consumers.chatFrontier();
  }

  /** Whether this connection's account has a JetStream stream of this name. A missing stream is
   *  false. Any other failure is thrown, so a caller does not treat an unread broker as absence. */
  streamRecorded(name: string): Promise<boolean> {
    return this.consumers.streamRecorded(name);
  }

  /** The bytes this connection's account holds in JetStream file storage, as `$JS.API.INFO`
   *  reports them. A broker's `max_file_store` cap counts every account it serves, so this is a
   *  lower bound on what that cap measures. */
  storedBytes(): Promise<number> {
    return this.consumers.storedBytes();
  }

  /** Phase 1 of a join: capture each channel's current CHAT stream frontier before opening the
   *  core subscription. The frontier bounds the {@link EndpointHistory.backfillArmed} read (`seq <= frontier`),
   *  and the live subscription carries everything published after it. */
  private async armJoin(channels: string[]): Promise<Map<string, number>> {
    const frontiers = new Map<string, number>();
    for (const ch of channels) {
      frontiers.set(ch, await this.chatFrontier());
    }
    return frontiers;
  }

  /**
   * Replay-gated pull of a channel's retained ambient from `sinceSeq` (exclusive) forward — the
   * focus-recall read behind `cotal_inbox`. Returns the messages (NOT emitted — this is a pull,
   * not a push into context) plus `dropped: true` when the window may not be complete: the stream's
   * limits may have removed posts after the watermark ({@link EndpointHistory.chatMayHaveLost}: a sender at the
   * per-sender limit, or the stream's oldest post already past the watermark), or replay is off
   * for the channel below. Either way the caller must say so rather than silently reporting an
   * empty, complete window. `seqs[i]` is the chat
   * stream sequence of `messages[i]`, the one identity two identical messages do not share.
   * `unanswered` is true when no history read answered (replay is off, or the read failed), so
   * `messages` says nothing about what the channel retains.
   *
   * Honors the **same** per-channel replay gate as join-backfill ({@link EndpointHistory.joinPolicyFresh}): a
   * `replay=off` channel returns no messages, so `focus` can't become a history bypass for a
   * channel that denies replay to everyone else (the read ACL bounds *which* channels recall can
   * touch; this app gate bounds *whether* a permitted channel replays). Ingest still ack-drops
   * focus-mode ambient/mentions on this channel on the promise that they stay recallable (#977) —
   * the gate means that promise cannot be kept, so it reports `dropped: true` rather than pretend
   * the window was empty and complete.
   */
  async recallChannel(
    channel: string,
    sinceSeq: number,
  ): Promise<{ messages: CotalMessage[]; seqs: number[]; dropped: boolean; unanswered: boolean }> {
    return this.history.recallChannel(channel, sinceSeq);
  }

  /** #1356: the presence bucket has been refusing writes since this time, or `undefined` when the
   *  last publish succeeded. Cleared by a successful write that is the latest evidence on its
   *  epoch (#1461), so a survived blip reads as healthy and only a SUSTAINED failure carries a
   *  duration.
   *
   *  Presence writes are the CANARY, not the scope: the broker can disable JetStream account-wide
   *  while the NATS connection stays up, so a caller must not read this as "only presence is
   *  affected". It reports what was observed, not how far the fault extends. */
  presenceWriteFailure(): {
    since: number;
    forMs: number;
    error?: string;
    bucket: string;
    consecutiveFailures: number;
    stuck: boolean;
  } | undefined {
    return this.presence.presenceWriteFailure();
  }
}
