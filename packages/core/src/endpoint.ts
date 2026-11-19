import { EndpointHistory } from "./endpoint-history.js";
export { MULTI_FILTER_BATCH, MULTI_FILTER_READ_CONCURRENCY } from "./endpoint-history.js";
import { requestSafeReconnect } from "./request-safe-reconnect.js";
import { nativeBindingAfter, nativeConnectionBinding, type NativeConnectionBinding } from "./native-connection.js";
import { EventEmitter } from "node:events";
import { drainAndClose } from "./connection-cleanup.js";
import { randomUUID } from "node:crypto";
import { createConnection, isIP } from "node:net";
import {
  connect,
  tokenAuthenticator,
  nanos,
  AuthorizationError,
  PermissionViolationError,
  UserAuthenticationExpiredError,
  NoRespondersError,
  RequestError,
  TimeoutError,
  ConnectionError,
  type NatsConnection,
  type Msg,
  type Subscription,
} from "@nats-io/transport-node";
import { wsconnect } from "@nats-io/nats-core";
import {
  parseLivenessAnswer,
  responderFromLease,
  responderFromProbe,
  isLivenessPlane,
  LIVENESS_PLANES,
  type LivenessAnswer,
  type LivenessPlane,
  type ProbeOutcome,
  type ResponderState,
} from "./liveness.js";
import { EndpointPresence, type PresenceView } from "./endpoint-presence.js";
export { PresenceWriteStuckError, type PresenceView } from "./endpoint-presence.js";
import { credsClaims, credsFingerprint, credsRenewalDelayMs, idFromCreds } from "./identity.js";
import { nativeCredsAuthenticator } from "./creds-authenticator.js";
import { armRenewal, renewalDeadlineMs, jitteredBackoffMs } from "./renewal.js";
import { requireBrokerFloor } from "./broker-floor.js";
import { withDeadline } from "./deadline.js";
import { inspectCredHealth } from "./provision.js";
import {
  type SecretStoreIdentity,
} from "./secret-store.js";
import { BIND_SPLIT_REISSUES, resolveService, type ResolvedService, type SubmitAndFollowGoalOptions } from "./endpoint-invoke.js";
import { EpEnvelopeError, respondedButUnbound, replyRefusedBeforeEffect, replyTargetUnmapped } from "./endpoint-envelope.js";
import { isRepeatSafeCommand } from "./endpoint-grants.js";
import type { EpCaller, EpPrincipal, IssuedCaller, PrincipalAuthority } from "./endpoint-subjects.js";
import { assertGeneration, assertRuntimeToken, endpointToken } from "./endpoint-subjects.js";
import { servePrincipalRoute, describeContracts, type EpPrincipalCommandDef, type EpPrincipalServeHandle } from "./endpoint-serve.js";
import { epPrincipalCall } from "./endpoint-call.js";
import type { ClusterDocument } from "./endpoint-cluster.js";
import type { EndpointReply } from "./endpoint-envelope.js";
import type { CompiledContract } from "./schema-profile.js";
import { AGENT_CLUSTER, AGENT_CONTRACTS, AGENT_ENDPOINT } from "./agent-endpoint.js";
import { processRuntime } from "./process-runtime.js";
import { importNativeSubjectPermissions, issuedPermitsSubject, readAcceptedRow, type IssuedSubjectPermission } from "./issued-authority.js";
import type { RegistryEndpointsInput, RegistryEndpointsOutput } from "./registry-contract.js";
import { listRegistryEndpoints } from "./registry-client.js";
import type { EpVerbTarget, EpAttributedReply } from "./endpoint-verbs.js";
import { lastKvEntries } from "./kv-scan.js";
import { isConsumerNotFound, isJetStreamMissing, isStreamNotFound } from "./jetstream-missing.js";
import { assertValidKind } from "./agent-file.js";
import { assertValidName } from "./resolve.js";
import { nextHeartbeat } from "./presence-heartbeat.js";
import { anycastStoreDefinition, createSpaceStreams, dmDurableConfig, dlvDurableConfig, taskDurableConfig, PRESENCE_STORAGE } from "./streams.js";
import { DELIVERY_LIMIT_HEADER, PLANE3_MAX_MSGS_PER_SUBJECT } from "./backup-config.js";
import {
  jetstream,
  jetstreamManager,
  AckPolicy,
  DeliverPolicy,
  JetStreamApiCodes,
  type JetStreamClient,
  type JetStreamManager,
  type Consumer,
  type ConsumerMessages,
  type ConsumerInfo,
  type JsMsg,
  type JetStreamPublishOptions,
} from "@nats-io/jetstream";
import { type PushConsumer } from "@nats-io/jetstream";
import { Kvm, type KV, type KvEntry } from "@nats-io/kv";

import type {
  AgentCard,
  ChannelConfig,
  ChannelDefaults,
  ControlReply,
  ControlRequest,
  ControlRequestInit,
  AnycastTakeOutcome,
  Delivery,
  EndpointRef,
  MessageMeta,
  Part,
  Presence,
  PresencePrompts,
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
  Plane3Entry,
} from "./types.js";
import { listMembers } from "./members.js";
import { readAcl } from "./acls.js";
import type { DeliveryLeaseInfo, ManagerLeaseInfo } from "./lease.js";
import { EndpointDeliveryLease } from "./endpoint-delivery-lease.js";
import { EndpointDeliveryPlane, type MaybePromise } from "./endpoint-delivery-plane.js";
import { EndpointControlPlane } from "./endpoint-control-plane.js";
import { EndpointMessaging, assertPartsSerializable } from "./endpoint-messaging.js";
import { EndpointDurableBackstop } from "./endpoint-durable-backstop.js";
import { EndpointSubscriptions, membershipConsumerReleased, type MembershipFeedWatch } from "./endpoint-subscriptions.js";
import { ackWaitOf, authenticatedChannelMessage, durableDelivery, isRecord } from "./endpoint-inbound.js";
import {
  openChannelRegistry,
  effectiveReplay,
  effectiveReplayWindowMs,
  effectiveDeliveryClass,
  readChannelConfig,
  readChannelDefaults,
  decodeChannelEntry,
} from "./channels.js";
import { isCasLoss } from "./endpoint-records.js";
import {
  ANYCAST_CANCEL_OP,
  ANYCAST_NOTICE_KEY,
  ANYCAST_RECORDS_CREDENTIAL_OUTDATED,
  ANYCAST_STATUS_OP,
  ANYCAST_TAKES_OP,
  AnycastRequestAuthority,
  isAnycastSeq,
  type AnycastNotice,
  type AnycastStatus,
  type AnycastTakeReply,
  type AnycastTakeRequest,
} from "./anycast-requests.js";
import {
  assertValidRole,
  CHANNEL_DEFAULTS_KEY,
  chatStream,
  chatSubject,
  controlServiceSubject,
  livenessSubject,
  livenessServeFilter,
  CONTROL_DELIVERY,
  CONTROL_DELIVERY_ADMIN,
  dmStream,
  dmDurable,
  dlvStream,
  membershipInAllow,
  isConcreteChannel,
  isChannelFamily,
  MENTION_NOTICE_KEY,
  parseSubject,
  isPrincipalOwnerToken,
  assertInboxConnId,
  type ParsedSubject,
  presenceBucket,
  channelBucket,
  MEMBERSHIP_FEED_KEY,
  principalKey,
  parsePrincipalKey,
  assertLifecycleToken,
  mintLifecycleUid,
  lifecycleNameKey,
  DEV_OWNER,
  spacePrefix,
  spaceWildcard,
  subjectMatches,
  taskStream,
  taskDurable,
  takeServeFilter,
  takeSubject,
  parseTakeSubject,
  TAKE_ROUTE,
  token,
  unicastSubject,
  unicastRecvFilter,
} from "./subjects.js";

import { isPermissionDenied } from "./permission-denied.js";
export { isPermissionDenied };

export const DEFAULT_SERVER = "nats://127.0.0.1:4222";
/** Takes a daemon answers at once; one more is refused as busy, so the holder keeps its copy and
 *  asks again rather than queueing work the daemon cannot bound. */
const MAX_TAKES_IN_FLIGHT = 64;
/** How often the daemon runs the anycast records maintenance pass. */
const ANYCAST_SWEEP_MS = 10 * 60 * 1000;
/** How long a holder waits for the daemon to answer a take. */
const ANYCAST_TAKE_TIMEOUT_MS = 5_000;

/** The DLV count a stored copy was written under, from its {@link DELIVERY_LIMIT_HEADER} (SPEC §8):
 *  a whole number of at least 1, null for `none`, and 1000 when the header is absent, since only a
 *  daemon from before the count was configurable writes a copy without it and its count was 1000.
 *  Throws on any other value. */
export function deliveryLimitOf(value: string | undefined): number | null {
  if (value === undefined || value === "") return PLANE3_MAX_MSGS_PER_SUBJECT;
  if (value === "none") return null;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`plane-3 delivery: ${DELIVERY_LIMIT_HEADER} ${JSON.stringify(value)} is not a count`);
  return Number(value);
}

/** Space joined when none is given on the CLI (the `cotal-<space>` cmux tab, etc.). */
export const DEFAULT_SPACE = "main";

/** The longest delay `setTimeout` honors, 2^31-1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

export interface EndpointOptions {
  /** Trusted composition custody of each opened transport, including replacement epochs.
   * Called before binding so the owner can await its terminal closed signal on bind failure. */
  onConnection?: (nc: NatsConnection) => void;
  /** A planned credential swap dials a second connection, calls {@link onConnection}, and flushes
   *  before it reconnects the resident connection. The second connection closes after that
   *  reconnect. `onConnection` must accept a connection that exists only for the swap. Serve
   *  subscriptions that share an incarnation queue keep dispatch while the resident connection
   *  is down. Without this option the resident connection reconnects in place. */
  overlapOnConnectionRenewal?: boolean;
  /** Await local admission checks before presence, consumers and the ready event on each bind. */
  beforeBind?: () => Promise<void>;
  /** The collaboration to join. */
  space: string;
  /** Identity. `id` is generated if omitted. */
  card: Omit<AgentCard, "id"> & { id?: string };
  /** Opaque presence label. Omitted reads COTAL_ENVIRONMENT; null omits the label without reading it. */
  environment?: string | null;
  /** This incarnation's lifecycle UID (SPEC §13.1), minted ONCE per lifecycle by the provisioning
   *  authority (manager/CLI: `mintLifecycleUid()`) and PERSISTED with the agent — never re-minted per
   *  process, or a supervised restart would abandon the durable inbox. REQUIRED to bind/create the
   *  lifecycle-keyed messaging durables (`dm_…-<uid>`, `dlv_…-<uid>`, `chathist_…-<uid>`) — an
   *  endpoint without one (a pure operator/daemon connection) can not consume DM/chat history. */
  lifecycleUid?: string;
  /** The CHAT stream sequence this incarnation had reached before its preservation cut (a supervised
   *  preserve/resume, never a fresh join). The boot backfill reads only what came after it instead of
   *  the whole retained window. Core reads no environment variable for this — the caller (a launcher)
   *  resolves it and passes it explicitly. */
  backfillFloor?: number;
  /** The accepted-row token of this credential's issuance (SPEC 13.15). Set when the launcher
   *  minted the credential as an issuance: after connecting, the endpoint reads the generation the
   *  ISSUER bound under this token (a broker-enforced per-key read) and pins it into every caller
   *  rail it forms. A token that resolves to no row, or to another incarnation's reference, fails
   *  the connect: the rails would be refused at the broker anyway, and a silent legacy fallback is
   *  exactly what the versioned rail exists to rule out. */
  acceptedToken?: string;
  servers?: string;
  /** Connection token (soft-shared auth). Mutually exclusive with user/pass. */
  token?: string;
  /** Username/password auth (both required together). */
  user?: string;
  pass?: string;
  /** NATS user creds file *content* (JWT + nkey seed), or a SOURCE that mints/reads a fresh copy.
   *  When set, the endpoint authenticates as that user and adopts the creds' identity as its card.id.
   *
   *  A STRING is the ordinary static cred. A FUNCTION is the STANDING-RENEWAL seam for
   *  bounded-lifetime standing creds: the endpoint fetches before the first connect, re-fetches at
   *  75% of each JWT's lifetime (then swaps the connection onto the fresh cred with a controlled
   *  reconnect) and on rebuilds, and every (re)connect attempt presents the freshest copy — the
   *  broker's expiry-close is only the backstop for a missed swap.
   *  The two source shapes are the renewal classes: a seed-holder self-remints (the manager's
   *  supervisor), a seed-less daemon re-reads its manager-reminted creds file (delivery). A source
   *  requires explicit `card.id` (the pinned identity); every fetched cred MUST carry that same nkey
   *  or the endpoint fails loud — renewal may never silently swap identity. A fetch failure is
   *  emitted as a "warning" event and retried; the connection stays up until its current JWT expires,
   *  so a dead reminter is loud without instantly dropping the mesh. Node rethrows unhandled "error"
   *  events, so a retry notice must not use that channel (#891). Once the cached cred expires,
   *  the endpoint refuses to present it to the broker and keeps retrying the source with backoff. */
  creds?: string | (() => Promise<string>);
  /** USER-MODE auth: a validated Cotal user bearer (the JWT from `cotal login` → the IdP bridge), or a
   *  SOURCE that mints a fresh one. When set, the endpoint connects through the auth callout — presenting
   *  {@link sentinelCreds} + the bearer, the broker mints its scoped data-account JWT.
   *
   *  A STRING is a one-shot bearer for connection-lifetime ≤ bearer-lifetime callers (the CLI): the
   *  owner+actor PRINCIPAL is derived from it (`sub`, `act.actor`), and the connection dies at the
   *  bearer-bound JWT expiry. A FUNCTION is a bearer source for long-lived endpoints (spawned agents):
   *  the endpoint fetches before the first connect, renews at a random point between 50% and 80% of
   *  each token's lifetime (then swaps the connection onto it with a controlled reconnect) and on
   *  rebuilds, and every (re)connect attempt presents the freshest unexpired token — so reconnects
   *  outlive any single bearer, and none presents an expired one.
   *  A source requires explicit `card.owner` + `card.actor` (there is no bearer to derive them from at
   *  construction); every fetched bearer MUST carry that same principal or the endpoint fails loud.
   *  A fetch failure is emitted as one "warning" event per run of failures and retried on a jittered,
   *  capped backoff — the connection stays up until its current JWT expires, so a dead auth service
   *  surfaces loudly without instantly dropping the mesh. A failure that carries a numeric
   *  `retryAfterSeconds` is retried when those seconds have passed instead, not before.
   *  Node rethrows unhandled "error" events, so a retry notice must not use that channel (#891).
   *  Mutually exclusive with `creds`/`token`/`user`/`pass`; requires `sentinelCreds`. */
  bearer?: string | (() => Promise<string>);
  /** The shared, deny-all auth-account sentinel creds presented alongside {@link bearer} so the connect
   *  lands in the callout account (`createCalloutAuth().sentinelCreds`). Powerless on its own. */
  sentinelCreds?: string;
  /** Require a TLS connection to the server. */
  tls?: boolean;
  /** Native NATS PING interval for this endpoint's resident connection, in milliseconds.
   *  Defaults to 10 seconds. Pair with transportMaxPingOut. No probe connection. */
  transportPingIntervalMs?: number;
  /** Unanswered native PING count before the resident transport becomes stale. Defaults to 2.
   *  Pair with transportPingIntervalMs for bounded silent loss. */
  transportMaxPingOut?: number;
  /** How long the first connect may take before it fails with the transport's TimeoutError, in
   *  milliseconds. Omitted uses the transport's default. */
  transportConnectTimeoutMs?: number;
  /** Channels to subscribe to; the first concrete one is the default broadcast target. Omitted or
   *  empty ⇒ NO channels: the endpoint joins nothing, and {@link CotalEndpoint.multicast} refuses
   *  a call with no explicit channel rather than picking one. */
  channels?: string[];
  /** The credential's complete channel read ACL when the composition has it. An explicit empty list
   * means provisioning omitted the DLV durable. When omitted, static credentials select the optional
   * bind from their presented publish permissions; bearer callers need the resolved ACL. A denied
   * bind still refuses startup. */
  allowSubscribe?: string[];
  /** Presence heartbeat interval (ms). */
  heartbeatMs?: number;
  /** Presence liveness window (ms); a peer is considered gone after this. */
  ttlMs?: number;
  /** Publish our own presence (default true). */
  registerPresence?: boolean;
  /** Track the roster of peers with a live watch (default true). Every watcher receives every
   *  member's heartbeat, so a space of K watching members moves K² deliveries per heartbeat. An
   *  endpoint that only needs the roster when it acts sets this false and calls
   *  {@link CotalEndpoint.readPresence} instead (SPEC §6). */
  watchPresence?: boolean;
  /** Keep the channel registry cache (default true). An endpoint that watches presence watches the
   *  registry; a consumer that reads presence on demand reads the registry on demand too
   *  ({@link CotalEndpoint.readChannels}), and any other endpoint keeps no cache. A presence-only
   *  supervisor sets this false to track the roster WITHOUT opening the channel-registry cache — so
   *  its cred needs no channel-registry read grant (residual 2). A consumer always opens the
   *  registry, because the join-time replay decision reads it. */
  watchChannels?: boolean;
  /** Read presence and the channel registry ONCE at start instead of watching them (default false),
   *  for an endpoint that does one thing and stops (`cotal send`, a roster probe). Each read is a
   *  batched Direct Get of every key's last record, so it binds no consumer. A watch's ordered consumer
   *  outlives {@link CotalEndpoint.stop} by the broker's five-minute inactive threshold, because the
   *  operator and agent profiles hold no CONSUMER.DELETE on these buckets (#691), and one per
   *  short-lived process piles up until the broker refuses new consumers there (#4091). The roster
   *  and the channel cache hold the state at start and never update, and no sweep runs. Requires
   *  `consume` and `registerPresence` false. */
  readOnce?: boolean;
  /** Consume ONLY this endpoint's own existing DM durable, for a credential that can read nothing
   *  else. The endpoint binds `dm_<owner>-<actor>-<uid>` and opens no channel registry, presence,
   *  KV, channel subscription, `dlv_` durable, history reader or JetStream manager. It never creates
   *  the durable: a missing one fails start with {@link DmDurableMissingError}, a refused bind with
   *  {@link DmBindRefusedError}. Each authenticated DM goes to `handler`, one at a time; the next is
   *  not read until the previous handler settles. The `message` event does not fire in this mode.
   *  {@link CotalEndpoint.stop} resolves only after the connection is closed and the running handler
   *  has settled; a rejecting handler still lets the connection close, and stop throws, keeping
   *  custody, when closure or settlement within `settleTimeoutMs` (default 30000) is unproved.
   *  A copy received after stop begins or after a reconnect replaces the connection is never
   *  handed to the handler and stays unacked for broker redelivery; an ack, nak or in-progress
   *  signal on a closed connection throws.
   *  Requires static or sourced creds or a bearer, `consume` true, `registerPresence`,
   *  `watchPresence` and `watchChannels` false, and no channels, role, `readOnce` or `acceptedToken`. */
  dmOnly?: DmOnlyOptions;
  /** Create inbound stream consumers (DM / chat / anycast). Default true; a pure observer sets false. */
  consume?: boolean;
  /** Initial per-channel attention overrides to publish in presence from the first heartbeat (the
   *  connector's file-default seed). Mirror only — never read back into delivery. */
  channelModes?: Record<string, ChannelMode>;
  /** How long an unacked (un-surfaced) message waits before redelivery (ms). */
  ackWaitMs?: number;
  /** Retire this instance's durable consumers after it's been gone this long (ms). */
  inactiveThresholdMs?: number;
}

/** A peer subscribed to a channel — broker truth (a chat-stream consumer) joined with
 *  presence for liveness. `live: false` is a stale ghost: the durable lingers (reconnect
 *  grace) but presence says the peer is gone/offline. */
export interface ChannelMember {
  id: string;
  name: string;
  role?: string;
  live: boolean;
}

/** See {@link EndpointOptions.dmOnly}. */
export interface DmOnlyOptions {
  /** Receives each authenticated DM. A resolved promise does not ack: call `delivery.ack()`. A
   *  rejection is emitted as `error` and leaves the copy unacked, so the broker redelivers it. */
  handler: (msg: CotalMessage, delivery: Delivery, meta: MessageMeta) => void | Promise<void>;
  /** How long {@link CotalEndpoint.stop} waits for a running handler, in milliseconds. */
  settleTimeoutMs?: number;
}

/** This endpoint's own `dm_` durable does not exist. A DM-only endpoint, and any endpoint on an
 *  authenticated mesh, binds the durable its provisioner created and never creates one. */
export class DmDurableMissingError extends Error {
  readonly code = "dm-durable-missing" as const;
  constructor(readonly stream: string, readonly durable: string) {
    super(`dm-durable-missing: durable "${durable}" on stream "${stream}" does not exist; this endpoint binds an existing durable and never creates one`);
    this.name = "DmDurableMissingError";
  }
}

/** The broker refused a DM-only endpoint's bind of its own `dm_` durable. No other credential or
 *  read path is tried. */
export class DmBindRefusedError extends Error {
  readonly code = "dm-bind-refused" as const;
  constructor(readonly stream: string, readonly durable: string, cause: unknown) {
    super(`dm-bind-refused: binding durable "${durable}" on stream "${stream}" was refused (${cause instanceof Error ? cause.message : String(cause)})`, { cause });
    this.name = "DmBindRefusedError";
  }
}

/** Raw NATS transport liveness for the endpoint's CURRENT connection epoch. This is deliberately
 *  separate from the `connection` event, which means the full Cotal bind is ready. */
export interface TransportState {
  connected: boolean;
  /** The server nats.js named for this edge. Omitted when the runtime supplied none. */
  server?: string;
}

/**
 * Events: "message" (CotalMessage), "presence" (PresenceEvent), "roster" (Presence[]), "error" (Error),
 * "connection" ({ connected: boolean }) — true on every successful (re)bind (initial start, manual
 * reconnect, AND background self-heal), false the moment the connection drops (rebuild null window /
 * terminal close). Lets an in-process agent track connectedness off the endpoint's own (re)binds
 * instead of an imperative flag the self-heal path can't reach; "transport" ({ connected, server? })
 * is the lower-level NATS socket edge, true before the full bind finishes and false during an internal
 * nats.js reconnect without changing `connection` readiness. "stored-copies-full" ({ limit: number }): a
 * stored copy arrived with the store at the count the copy was written under ({@link deliveryLimitOf}),
 * so the store may have discarded older copies before this session read them; emitted for each such
 * copy. A lowering of the count or an age set on the store removes copies without this event.
 *
 * Callers MUST attach an "error" listener before `start()`: async faults (incl. NATS
 * permission denials, surfaced via `watchStatus`) are emitted as "error", and Node throws
 * synchronously on an unhandled "error" — a missing listener turns any such fault into a
 * process crash instead of a logged denial.
 */

/** One page of a mediated history read: the newest `limit` messages, oldest-first WITHIN the page.
 *
 *  `complete` is the honest-truncation signal and the reason this is not just `CotalMessage[]`:
 *  `true` means the page reaches the start of the channel's RETAINED history (nothing older is on
 *  the stream to read), `false` means older messages exist behind it. A caller that cannot tell
 *  those apart renders "there is more" as "this is the beginning of the conversation". It says
 *  nothing about messages already aged out by retention — no reader can see those. */
export type HistoryPage = { items: CotalMessage[]; complete: boolean };

/** The NEWEST prefix-from-the-end of `items` whose serialized `readHistory` reply fits `budget`
 *  bytes, order preserved. Returns `[]` when not even the newest single message fits — the caller
 *  must refuse loudly there rather than serve an empty page, which would read as "no history".
 *
 *  The `ControlReply` around the items rides the same NATS message, so it is charged too: items
 *  that fit on their own can still make a reply the broker refuses.
 *
 *  Measured in ENCODED bytes, not `string.length`: a page of multi-byte text would otherwise be
 *  undercounted and still overflow the broker. Same discipline as `assertFactFits`. */
export function fitHistoryPage(items: CotalMessage[], budget: number): CotalMessage[] {
  const enc = new TextEncoder();
  // The reply with no items, at its longer `complete` value.
  let used = enc.encode(JSON.stringify({ ok: true, data: { items: [], complete: false } satisfies HistoryPage })).length;
  let first = items.length; // index of the oldest kept item
  for (let i = items.length - 1; i >= 0; i--) {
    const size = enc.encode(JSON.stringify(items[i])).length + 1; // + the `,` separator
    if (used + size > budget) break;
    used += size;
    first = i;
  }
  return first === items.length ? [] : items.slice(first);
}

/** The highest `prompts` presence `seq` this process used under each runtime id (SPEC §6). A reader
 *  orders lists by `seq` within one `runtime.id`, and a runtime id lives as long as the process, so
 *  this does too: across a stopped serve, a stopped endpoint and a new endpoint for the lifecycle. */
const promptsSeqs = new Map<string, number>();

/** The principal endpoint each `{space, runtime id, endpoint}` is served by in this process. Two
 *  would subscribe the same subject and both answer one request (SPEC 13.21). */
const principalServers = new Map<string, PrincipalServeIntent>();

/** What {@link CotalEndpoint.servePrincipal} keeps to re-bind on every replaced connection. */
interface PrincipalServeIntent {
  readonly serve: { endpoint: string; cluster: ClusterDocument; handlers: EpPrincipalCommandDef[] };
  readonly self: EpPrincipal;
  /** Its key in {@link principalServers}. */
  readonly serverKey: string;
  /** The binding on the connection it was made on, and every binding not yet retired: the current
   *  one and those on replaced connections whose handlers are still finishing, so `stop` awaits
   *  them. */
  binding?: { nc: NatsConnection; handle: EpPrincipalServeHandle };
  readonly handles: EpPrincipalServeHandle[];
  /** The connection on which the broker last accepted the subscription. */
  readyOn?: NatsConnection;
  /** Ended: stopped, or refused by the broker. */
  ended: boolean;
  readySettled: boolean;
  resolveReady(): void;
  rejectReady(e: Error): void;
  resolveFailed(e: Error): void;
}

/** A served principal endpoint (SPEC 13.21). */
export interface PrincipalServe {
  /** Resolves once the broker accepted this process's subscription; rejects with its refusal. */
  readonly ready: Promise<void>;
  /** Resolves with the refusal that ended the serve, including one that arrives on a replaced
   *  connection after `ready` resolved. Never rejects, and never resolves after `stop`. */
  readonly failed: Promise<Error>;
  /** Unsubscribe, abort every handler's `signal`, and wait for each handler in flight until its
   *  request's deadline at most, which the route caps at 30 s. A reply that comes after that is
   *  dropped. */
  stop(): Promise<void>;
}

export class CotalEndpoint extends EventEmitter {
  readonly card: AgentCard;
  readonly space: string;
  readonly channels: string[];
  private readonly allowSubscribe?: string[];

  private readonly servers: string;
  private readonly token?: string;
  private readonly user?: string;
  private readonly pass?: string;
  /** The creds source, when standing renewal is on (bounded supervisor/daemon creds); undefined for
   *  a static string. Mirrors {@link bearerSource} exactly — same fetch-ahead + pin + retry shape. */
  private readonly credsSource?: () => Promise<string>;
  /** The freshest creds — what every (re)connect attempt presents. Static callers set it once. */
  private currentCreds?: string;
  private credsTimer?: NodeJS.Timeout;
  /** Publish permissions presented on each watch's connection, refreshed only when it authenticates.
   *  Missing context preserves broker-checked cleanup for other supported authentication forms. */
  private readonly watchDeletePermissions = new WeakMap<object, () => IssuedSubjectPermission | undefined>();
  /** True in user mode (bearer string OR source) — gates the callout-shaped connect. */
  private readonly userMode: boolean = false;
  /** The bearer source, when auth refreshes (spawned agents); undefined for a one-shot string. */
  private readonly bearerSource?: () => Promise<string>;
  /** The freshest bearer — what every (re)connect attempt presents. */
  private currentBearer?: string;
  /** The expiry, in seconds, of the credential the latest connect attempt presented. The issuer
   *  keys a listing generation on it (SPEC 13.15), so a listing reads the row bound to the
   *  credential the broker admitted, never one adopted since. */
  private presentedExp?: number;
  /** Cancels the armed bearer renewal or retry. */
  private cancelBearerRenewal?: () => void;
  /** Consecutive failed bearer renewals: the retry's step, and whether this run of failures has
   *  already been surfaced. */
  private bearerRenewalFailures = 0;
  /** Whether the expired-bearer refusal has been surfaced for this outage. */
  private bearerRefusalSurfaced = false;
  /** When the held bearer was adopted: its lifetime's start when it carries no `iat`. */
  private bearerAdoptedAtMs = 0;
  /** Arms against the credential authenticated on the current wire. nats-core 3.4.0 discards the
   *  promise returned by its async transport-close continuation; if that continuation enters the
   *  reconnect dial loop with an expired JWT, its terminal auth error becomes an unhandled rejection.
   *  Cotal knows the JWT expiry, so it disables the library reconnect before the broker closes the
   *  transport. The endpoint's observed `closed()` supervisor remains responsible for rebuilding. */
  private authExpiryReconnectTimer?: NodeJS.Timeout;
  private readonly sentinelCreds?: string;
  private readonly tls: boolean;
  private readonly transportPingIntervalMs?: number;
  private readonly transportMaxPingOut?: number;
  private readonly transportConnectTimeoutMs?: number;
  private readonly heartbeatMs: number;
  private readonly ttlMs: number;
  private readonly doRegister: boolean;
  private readonly doWatch: boolean;
  private readonly doWatchChannels: boolean;
  private readonly readOnce: boolean;
  private readonly doConsume: boolean;
  private readonly dmOnly?: DmOnlyOptions;
  /** The DM-only handler now running, if any; stop awaits it. */
  private dmOnlyInFlight?: Promise<void>;
  private readonly ackWaitMs: number;
  private readonly inactiveThresholdMs: number;

  private nc?: NatsConnection;
  private readonly requestsAwaitingReply = new Map<NatsConnection, Set<(error: Error) => void>>();
  private readonly onConnection?: (nc: NatsConnection) => void;
  private readonly overlapOnConnectionRenewal: boolean;
  private readonly beforeBind?: () => Promise<void>;
  private js?: JetStreamClient;
  private jsm?: JetStreamManager;
  private kv?: KV;
  private channelKv?: KV;
  private channelWatchIter?: Awaited<ReturnType<KV["watch"]>>;
  /** Consumer deletes of retired presence and channel-registry watches still in flight. A stop
   *  alone leaves each watch's ordered consumer on the broker for its five-minute inactive
   *  threshold (#3914), so {@link stop} and a live-epoch rebuild await these before they close the
   *  connection that carries them, as they do for the lease watch. */
  private readonly kvWatchDeletes = new Set<Promise<void>>();
  /** Presence and channel-registry watch binds still awaiting the broker. One that lands after
   *  {@link stop} or a rebuild moved the epoch retires its watch and starts that delete itself, so
   *  the same two paths wait for these first. */
  private readonly kvWatchBinds = new Set<Promise<unknown>>();
  /** Plane-3 durable-membership registry KV — lazily opened by the privileged delivery daemon (or a
   *  short-lived provisioner). */
  private membersKv?: KV;
  private aclKv?: KV;
  private managerLeaseKv?: KV;
  /** Our revision of the per-space daemon-credential renewal lease (#1634), or undefined when we do
   *  not hold it. Cleared with the bound KV handle: a revision from a dead connection is not a lease
   *  we can prove we still hold. */
  private daemonRenewalLeaseRevision?: number;
  private membershipFeedKv?: KV;
  /** Caller-owned membership watches survive a connection rebuild as INTENT. Their iterators are
   *  connection-scoped and are stopped/re-created around the epoch swap. */
  private readonly membershipFeedWatches = new Set<MembershipFeedWatch>();
  /** The plane-3 delivery daemon side of this endpoint (fan-out writer, trusted reader, control
   *  responders) and the agent's DELIVER pump. Every dependency is read when it is used. */
  private readonly deliveryPlane = new EndpointDeliveryPlane({
    ackWaitMs: () => this.ackWaitMs,
    actor: () => this.actor,
    owner: () => this.owner,
    allowSubscribe: () => this.allowSubscribe,
    anycastUnavailable: () => this.anycastUnavailable,
    card: () => this.card,
    js: () => this.js,
    jsm: () => this.jsm,
    nc: () => this.nc,
    ownLifecycleUid: () => this.ownLifecycleUid,
    residentSwap: () => this.residentSwap,
    space: () => this.space,
    stopped: () => this.stopped,
    streamMsgs: () => this.streamMsgs,
    subs: () => this.subs,
    userMode: () => this.userMode,
    watchDeletePermissions: () => this.watchDeletePermissions,
    maxPayload: () => this.maxPayload,
    aclForAlias: (...args) => this.aclForAlias(...args),
    channelHistory: (...args) => this.channelHistory(...args),
    deliveryClassFresh: (...args) => this.deliveryClassFresh(...args),
    durableJoinFor: (...args) => this.durableJoinFor(...args),
    durableLeaveFor: (...args) => this.durableLeaveFor(...args),
    ownerMemberships: (...args) => this.ownerMemberships(...args),
    ownsDeliveryLease: (...args) => this.ownsDeliveryLease(...args),
    readDeliveryLease: (...args) => this.readDeliveryLease(...args),
    readDeliveryLeaseEntry: (...args) => this.readDeliveryLeaseEntry(...args),
    reloadCreds: (...args) => this.reloadCreds(...args),
    serveControl: (...args) => this.serveControl(...args),
    aclRegistry: (...args) => this.aclRegistry(...args),
    membersRegistry: (...args) => this.membersRegistry(...args),
    armAnycastRequests: (...args) => this.armAnycastRequests(...args),
    deliveryAnycast: (...args) => this.deliveryAnycast(...args),
    dropAnycastRequests: (...args) => this.dropAnycastRequests(...args),
    manager: (...args) => this.manager(...args),
    notLiveMsg: (...args) => this.notLiveMsg(...args),
    plane3MsgId: (...args) => this.plane3MsgId(...args),
    publishDinbox: (...args) => this.publishDinbox(...args),
    resolveOwnerByName: (...args) => this.resolveOwnerByName(...args),
    scheduleResidentSwap: (...args) => this.scheduleResidentSwap(...args),
    sendMentionNotice: (...args) => this.sendMentionNotice(...args),
    emit: (event, ...args) => this.emit(event, ...args),
  });
  /** The anycast take responder, the request records it writes, and their maintenance timer
   *  (delivery daemon, SPEC §8.1). Bound with the other Plane-3 responders and dropped with them. */
  private takeServeSub?: import("@nats-io/transport-node").Subscription;
  private anycastAuthority?: AnycastRequestAuthority;
  /** The TASK stream's creation time for the role consumer this endpoint pumps, stamped on each copy
   *  it delivers and carried by that copy's take (SPEC §8.1). */
  private taskEpoch?: string;
  /** Why the records are not open, when this daemon's credential cannot open them. */
  private anycastUnavailable?: string;
  private anycastSweep?: ReturnType<typeof setInterval>;
  private takesInFlight = 0;
  /** Local cache of the channel registry (key = channel token), kept by a KV watch or, on an
   *  endpoint that reads it on demand, by {@link readChannels}. */
  private readonly channelConfigs = new Map<string, ChannelConfig>();
  private channelDefaults: ChannelDefaults = {};
  /** The {@link readChannels} in flight; calls made before it settles share it. */
  private channelRead?: Promise<void>;
  /** Orders {@link readChannels} results: a read that settles after a newer one was applied is dropped. */
  private channelReadGeneration = 0;
  private channelReadApplied = 0;
  private readonly history = new EndpointHistory({
    connection: () => this.nc,
    jetstream: () => this.js,
    manager: () => this.jsm,
    setManager: (manager) => { this.jsm = manager; },
    space: () => this.space,
    owner: () => this.owner,
    actor: () => this.actor,
    userMode: () => this.userMode,
    connectionId: () => this.connId,
    card: () => this.card,
    notLiveMsg: () => this.notLiveMsg(),
    requireLifecycleUid: (operation) => this.requireLifecycleUid(operation),
    requestDelivery: (op, args) => this.requestDelivery(op, args),
    deleteConsumerIfPresent: (stream, name) => this.deleteConsumerIfPresent(stream, name),
    joinPolicyFresh: (channel) => this.joinPolicyFresh(channel),
    chatMayHaveLost: (subject, sinceSeq) => this.chatMayHaveLost(subject, sinceSeq),
    emit: (event, ...args) => this.emit(event, ...args),
    decodeHistory: historyMessageFromDelivery,
    isRecord,
    isUsableMessageId,
    isFromSubjectSender,
    authenticatedMessage,
    isPublishPermissionDenied,
  });
  private readonly subs: Subscription[] = [];
  /** The observer feeds {@link tap} was asked for. This is INTENT, re-subscribed by {@link bindTap}
   *  on every (re)connect: a rebuild after an outage the library could not ride out closes the old
   *  connection and every subscription on it, so a tap bound once went silent while the endpoint
   *  reported itself connected again. */
  private readonly taps: { readonly handler: (subject: string, msg: CotalMessage | undefined) => void; readonly subject: string }[] = [];
  /** The liveness responders {@link serveLiveness} was asked for, by plane. This is INTENT, re-bound
   *  by {@link bindLiveness} on every (re)connect: a rebuild closes the old connection and every
   *  subscription on it, so a responder bound once would leave its plane to the broker's
   *  no-responders answer, which a peer grades `unbound`, while this endpoint is connected and serving. */
  private readonly livenessResponders = new Map<LivenessPlane, { readState: () => Promise<ResponderState> | ResponderState; sub?: Subscription }>();
  /** The principal endpoints {@link servePrincipal} serves, by endpoint name: INTENT, re-bound on
   *  every replaced connection. */
  private readonly principalServes = new Map<string, PrincipalServeIntent>();
  /** The `prompts` presence field {@link setPromptsPresence} last set. Shown only while the `agent`
   *  endpoint is served and its subscription was accepted on the current connection. */
  private promptsPresence?: PresencePrompts;
  private readonly streamMsgs: ConsumerMessages[] = [];
  /** Per-channel native core subscriptions (SPEC v0.3) — the manager-free live read path for boot +
   *  runtime channels (there is no per-instance chat durable). Keyed by channel so leave unsubscribes
   *  just one. */
  private readonly chatSubs = new Map<string, Subscription>();
  /** Channels whose core-sub the broker refused (async sub.allow violation) — read by the
   *  broker-confirmed join: a denied subscribe is NOT a successful join (SPEC conformance #13). */
  private readonly chatSubDenied = new Set<string>();
  /** Channels this session has a Plane-3 durable backstop for (per-channel join GENERATION, from
   *  durableJoin, so leave passes it back for the stale-leave guard). A durable channel's core-sub is
   *  NOT coverage-dropped — it stays a live wake-hint, dedup-coalesced with the Plane-3 durable copy by
   *  id-dedup. Drives the durable-state surface + routes leave to `durableLeave`. PERSISTS across
   *  reconnect (like `this.channels`): the membership record + the `dlv_<id>` durable are persistent so
   *  the backstop survives a reconnect on its own; the agent can't re-read the privileged members KV,
   *  so this in-memory mirror is kept, not rebuilt. Cleared only on full stop. */
  private readonly plane3Channels = new Map<string, number>();
  /** Channels whose live sub was REFUSED while they held a Plane-3 durable membership, whose §7
   *  tombstone has not yet confirmed (channel → join generation). {@link closeRefusedMembership} retries
   *  the tombstone until it lands; until then this is a `durable-unclosed` state surfaced via
   *  {@link pendingDurableLeaves} (the connector shows it in `cotal_channels`, never as ordinary
   *  absence). Persists across reconnect; cleared on tombstone success or full stop. */
  private readonly pendingDurableLeave = new Map<string, number>();
  /** Boot durable channels whose self-join hasn't yet established a membership (daemon down/absent at
   *  first connect, or a transient `durable:false`). {@link reconcileBootJoin} retries with capped
   *  backoff until the membership exists or the channel is left — so a first-connect daemon outage
   *  self-heals on recovery instead of leaving the channel silently live-only. Surfaced to the connector
   *  via {@link hasDurableMembership} (a joined durable channel NOT yet a member renders degraded). */
  private readonly pendingBootJoins = new Set<string>();
  /** The refusals a channel's live subscription callback received. nats.js hands a subscription
   *  refusal to the refused subscription's callback and then dispatches that same instance on the
   *  connection status, so the callback owns it (see {@link subscribeChat}) and watchStatus skips it. */
  private readonly chatSubRefusals = new WeakSet<PermissionViolationError>();
  /** Service iterators and connection status can receive the same subscription denial. */
  private readonly reportedSubRefusals = new WeakSet<PermissionViolationError>();
  /** `$JS.API.CONSUMER.DELETE.<stream>.<prefix>_` for each of this connection's own KV watches and
   *  running membership scans (see {@link recordOwnWatchConsumer}). */
  private readonly ownWatchDeletePrefixes = new Set<string>();
  /** True until the first successful connect completes its boot backfill — distinguishes first-connect
   *  (backfill the boot channels' history) from a reconnect (reopen the core-subs, no re-backfill).
   *  Persists across reconnect (NOT connection-scoped). Replaces the legacy chat-durable consumed-cursor
   *  signal now that there is no per-instance chat durable. */
  private firstConnect = true;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private readonly deliveryLease = new EndpointDeliveryLease({
    card: () => this.card,
    space: () => this.space,
    connection: () => this.nc,
    epoch: () => this.presenceEpoch,
    notLiveMsg: () => this.notLiveMsg(),
    deleteWatchConsumer: (iter) => this.deleteOwnConsumer(kvWatchConsumer(iter)),
    recoverable: (error) => this.emitRecoverable(error),
    emit: (event, error) => this.emit(event, error),
  });
  private readonly presence = new EndpointPresence({
    card: () => this.card,
    space: () => this.space,
    bucket: () => this.kv,
    connection: () => this.nc,
    lifecycleUid: () => this.ownLifecycleUid,
    prompts: () => this.servedPrompts(),
    ttlMs: () => this.ttlMs,
    registers: () => this.doRegister,
    watches: () => this.doWatch,
    readsOnce: () => this.readOnce,
    stopped: () => this.stopped,
    reconnecting: () => this.reconnecting,
    epoch: () => this.presenceEpoch,
    notLiveMsg: () => this.notLiveMsg(),
    bindWatch: (kv) => this.bindKvWatch(kv),
    retireWatch: (iter) => this.retireKvWatch(iter),
    emit: (event, value) => this.emit(event, value),
    recoverable: (error) => this.emitRecoverable(error),
    isPublishPermissionDenied,
  });
  /** Bumped by every connection-scoped teardown and by {@link stop}. A presence or lease-watch bind
   *  that was awaiting the broker when the epoch moved belongs to a retired epoch: it releases the
   *  iterator it got and installs nothing (see {@link startPresenceWatch} and
   *  {@link bindDeliveryLeaseWatch}). */
  private presenceEpoch = 0;
  private stopped = false;
  private stopPromise?: Promise<void>;
  private startPromise?: Promise<void>;
  /** Includes detached predecessors until their actual connection reports closed. */
  private readonly ownedConnections = new Set<NatsConnection>();
  /** Whether the current connection has a binding to report: the last `transport` edge, cleared
   *  when a reconnect is requested on it. Read by {@link nativeConnections}. */
  private nativeBound = false;
  /** Credential transactions running now. Each one opens a disposable connection for its proof. */
  private credsTxnsRunning = 0;
  /** In-flight rebuild (drain+rebind) — serializes manual reconnect, the supervisor's
   *  closed(), and reestablishLoop so only ONE rebuild runs at a time (a second trigger
   *  coalesces onto the shared promise, never starts a parallel connectAndBind). */
  private rebuildPromise?: Promise<void>;
  /** True only during the null window of a rebuild (this.nc unset) — user-facing ops then
   *  throw a "reconnecting" message instead of the misleading "endpoint not started". */
  private reconnecting = false;
  /** One reestablishLoop at a time; concurrent triggers coalesce via rebuild(). */
  private reestablishing = false;
  /** Interruptible backoff for reestablishLoop — reconnect()/stop() resolves this to retry
   *  now instead of awaiting the full retryMs. */
  private backoffResolve?: () => void;
  private backoffTimer?: ReturnType<typeof setTimeout>;
  /** Wakes for the membership retry loops' pauses (see {@link membershipPause}); stop() runs them all. */
  private readonly membershipPauses = new Set<() => void>();
  private readonly retryMs = 3000;
  /** Consecutive failed rebuilds, driving {@link nextRetryDelayMs}. Reset on every success. */
  private retryAttempt = 0;

  /** The connection's authenticated nkey — dev: the creds' identity; user mode: the per-connection
   *  ephemeral. Distinct from the {@link owner}+{@link actor} principal: it names the CONNECTION (the
   *  broker-authenticated user), and scopes the private reply inbox (`_INBOX_<connId>`) + the credId
   *  equality check. The principal (owner+actor) is what the WIRE grammar and every per-agent key use. */
  private readonly connId: string;
  /** This endpoint's owner token (principal half 1) — `"local"` in the dev default. */
  private readonly owner: string;
  /** This endpoint's actor token (principal half 2) — the connection id in the dev default. */
  private readonly actor: string;
  /** True when {@link actor} was SELF-MINTED at construction — a fresh random token, because the
   *  card declared no actor and no id and no creds named one. Such a principal differs on every
   *  restart, so nothing can be granted to it in advance and nothing durable may be keyed on it.
   *  Exposed via {@link actorIsEphemeral} so a caller deriving a per-agent resource name can refuse
   *  the mode instead of silently keying on a value that will not survive the process. */
  readonly actorIsEphemeral: boolean;
  /** This incarnation's lifecycle UID (opts.lifecycleUid) — see {@link EndpointOptions.lifecycleUid}. */
  private readonly ownLifecycleUid?: string;
  /** See {@link EndpointOptions.backfillFloor}. */
  private readonly backfillFloor?: number;
  private readonly acceptedToken?: string;
  /** The issuer-bound generation, learned once per connection from the accepted row. */
  private issuedGeneration?: string;
  /** Full per-endpoint-name {@link resolveService} cache for {@link describeService}. Narrow command
   *  handles never enter it, so discovery cannot inherit a truncated invocation surface. */
  private readonly resolvedServices = new Map<string, ResolvedService>();
  /** Requests still resolving, preparing observation or awaiting their command's answer. */
  private readonly serviceInvocations = new WeakMap<NatsConnection, Set<Promise<void>>>();
  /** Narrow invocation handles, keyed by endpoint and the sorted command set they verify. Kept
   *  separate from full discovery handles so alternating commands neither overwrite each other nor
   *  poison {@link describeService}. */
  private readonly resolvedCommandServices = new Map<string, Map<string, ResolvedService>>();
  /** Active goal followers awaiting outcome, tracked so endpoint stop can cancel them immediately
   *  and connection replacement / reconnect can trigger reconciliation. */
  private readonly activeGoalFollowers = new Set<{ cancel: () => void; reconnected: (nc: NatsConnection) => void }>();
  /** How many calls {@link invokeService} has silently recovered from a bind refusal (§13.2) or a
   *  member holding no mapping for the target (§13.3) — the class-queue splits this endpoint hit
   *  and survived.
   *
   *  Counted because it is recovered: handling the split is what makes it invisible, so this is the
   *  only evidence the split rate exists. Always on, never behind a flag — a counter you have to
   *  enable is not there when the thing you needed it for happened. */
  private splitsRecovered = 0;

  /** This endpoint's wire principal (owner + actor tokens, §13.2) — what its minted grant rows
   *  pin. Public so a caller can build owner-mode target blocks for {@link invokeService}. */
  get principal(): { owner: string; actor: string } {
    return { owner: this.owner, actor: this.actor };
  }

  /** Class-queue splits this endpoint has hit and silently survived ({@link splitsRecovered}).
   *  Pull it, or listen for `split-recovered` — the event can be missed, the count cannot. */
  get splitRecoveryCount(): number {
    return this.splitsRecovered;
  }

  /** Mis-keyed or malformed presence rows this reader rejected. The warning event may be missed; the count cannot. */
  get presenceBindingDropCount(): number {
    return this.presence.bindingDropCount;
  }

  /** The endpoint's own lifecycle UID, REQUIRED for every lifecycle-keyed messaging resource; absent
   *  ⇒ loud refusal naming the operation (the hard cut of SPEC §13.1 — no alias-keyed fallback). */
  private requireLifecycleUid(what: string): string {
    if (!this.ownLifecycleUid)
      throw new Error(
        `${what} requires this endpoint's lifecycleUid (EndpointOptions.lifecycleUid): dm/dlv/chathist broker resources are lifecycle-keyed names (SPEC 13.1)`,
      );
    return this.ownLifecycleUid;
  }

  constructor(opts: EndpointOptions) {
    super();
    this.on("transport", (state: TransportState) => { this.nativeBound = state.connected; });
    /** Did the dev/static branch fall through to a random connId? Set on every path that assigns
     *  `connId` so the ephemeral verdict below can never read an unassigned value. */
    let selfMintedConnId = false;
    this.space = opts.space;
    // A display name is the client-side handle a peer is addressed by; reject the reserved `/`
    // (the future owner/name separator) and surrounding whitespace at the one identity choke
    // point every join/spawn path flows through. A role is an address too, refused here before
    // presence can advertise it.
    assertValidName(opts.card.name);
    assertValidKind(opts.card.kind);
    if (opts.card.role !== undefined) assertValidRole(opts.card.role);
    // Auth mode is EITHER static creds (dev/no-login) OR a user bearer (login → callout) — never both.
    if (opts.bearer) {
      if (opts.creds || opts.token || opts.user || opts.pass)
        throw new Error("bearer (user-mode auth) is mutually exclusive with creds/token/user/pass");
      if (!opts.sentinelCreds)
        throw new Error("user-mode bearer requires sentinelCreds (the shared auth-account creds presented alongside it)");
    }
    if (opts.bearer) {
      // USER MODE. The owner+actor PRINCIPAL comes from the bearer (server-authored: owner is callout-
      // derived, actor is the spawn-ledger actor) — never from the card. The connection nkey is minted
      // per-connect by NATS and is unknown to the client pre-connect, so the client cannot key its inbox
      // on it; instead it picks its OWN random inbox NONCE (the connId), passes it as the connect `name`,
      // and the callout scopes `_INBOX_<connId>.>` on that. `card.id`, if given, must match the bearer.
      this.userMode = true;
      if (typeof opts.bearer === "function") {
        // Bearer SOURCE: no token exists yet, so the principal must be declared up front; every
        // fetched bearer is checked against it (refreshBearer), keeping the card honest for life.
        if (!opts.card.owner || !opts.card.actor)
          throw new Error("a bearer source requires explicit card.owner + card.actor (no bearer to derive them from at construction)");
        this.owner = opts.card.owner;
        this.actor = opts.card.actor;
        this.bearerSource = opts.bearer;
      } else {
        const claims = decodeBearerPrincipal(opts.bearer);
        if (opts.card.owner && opts.card.owner !== claims.owner)
          throw new Error(`card.owner ${opts.card.owner} != bearer owner ${claims.owner}`);
        if (opts.card.actor && opts.card.actor !== claims.actor)
          throw new Error(`card.actor ${opts.card.actor} != bearer actor ${claims.actor}`);
        this.owner = claims.owner;
        this.actor = claims.actor;
        this.currentBearer = opts.bearer;
      }
      this.connId = assertInboxConnId(`ibx${randomUUID().replace(/-/g, "")}`);
      this.sentinelCreds = opts.sentinelCreds;
      // User mode's actor is SERVER-AUTHORED (bearer claims or a declared card checked against
      // them), never self-minted — the ephemeral value here is the inbox nonce, which is the
      // connection id and not the principal.
      this.actorIsEphemeral = false;
    } else {
      // DEV / STATIC. Connection identity precedence: an explicit card.id, else the creds' identity, else
      // a random (dash-free, valid-actor-token) id. When both an id and creds are given they MUST name the
      // same nkey — else the connection would authenticate as one user while its grants name another. The
      // owner+actor PRINCIPAL defaults to owner = DEV_OWNER ("local"), actor = the connection id.
      if (typeof opts.creds === "function") {
        // Creds SOURCE (standing renewal): no cred exists yet, so the identity must be declared up
        // front; every fetched cred is checked against it (refreshCreds), so a renewal can never
        // silently swap the connection's nkey.
        if (!opts.card.id)
          throw new Error("a creds source requires an explicit card.id (no cred to derive the identity from at construction)");
        this.credsSource = opts.creds;
        this.connId = opts.card.id;
        selfMintedConnId = false;
      } else {
        const credId = opts.creds ? idFromCreds(opts.creds) : undefined;
        if (opts.card.id && credId && opts.card.id !== credId)
          throw new Error(`card.id ${opts.card.id} != creds identity ${credId} - they must be the same nkey`);
        this.currentCreds = opts.creds;
        selfMintedConnId = opts.card.id === undefined && credId === undefined;
        this.connId = opts.card.id ?? credId ?? randomUUID().replace(/-/g, "");
      }
      this.owner = opts.card.owner ?? DEV_OWNER;
      this.actor = opts.card.actor ?? this.connId;
      // The actor is EPHEMERAL only when it inherited a self-minted connId — a declared `card.actor`
      // is stable even on an otherwise identity-less connection. Recorded here, at the one site the
      // fallback fires, so no caller has to re-derive the precedence rule from the outside.
      this.actorIsEphemeral = opts.card.actor === undefined && selfMintedConnId;
    }
    // The incarnation's lifecycle UID (SPEC §13.1). AUTH mode (JWT creds/bearer) REQUIRES the
    // launcher to supply it — the dm/dlv/chathist durable names must match the exact names the
    // provisioner minted into the credential, so a self-minted uid would name a durable the cred
    // cannot bind; absent, `requireLifecycleUid` fails loud at the first consuming path. OPEN/token
    // mode is self-identifying (one process is one lifecycle, no provisioner, no ledger, no
    // same-alias respawn), so it mints its OWN uid here exactly as it self-assigns `connId`/`actor`
    // — NOT an alias fallback (a fresh CSPRNG uid), just the open-mode identity source.
    this.ownLifecycleUid =
      opts.lifecycleUid !== undefined
        ? assertLifecycleToken(opts.lifecycleUid)
        : this.authed
          ? undefined
          : mintLifecycleUid();
    if (opts.backfillFloor !== undefined) {
      if (!Number.isInteger(opts.backfillFloor) || opts.backfillFloor < 0)
        throw new Error(`EndpointOptions.backfillFloor must be a non-negative integer stream sequence, got ${opts.backfillFloor}`);
      this.backfillFloor = opts.backfillFloor;
    }
    if (opts.acceptedToken !== undefined) {
      if (!opts.creds) throw new Error("EndpointOptions.acceptedToken names a static issuance and needs creds beside it (SPEC 13.15)");
      this.acceptedToken = assertGeneration(opts.acceptedToken, "acceptedToken");
    }
    // `card.id` is the principal DOT-FORM `<owner>.<actor>` — the wire identity every `from.id` carries;
    // principalKey validates both tokens.
    const principal = principalKey(this.owner, this.actor);
    this.card = { ...opts.card, id: principal.key, owner: this.owner, actor: this.actor };
    this.presence.configureEnvironment(
      (opts.environment === undefined ? process.env.COTAL_ENVIRONMENT : opts.environment)?.trim() || undefined);
    this.servers = opts.servers ?? DEFAULT_SERVER;
    this.token = opts.token;
    this.user = opts.user;
    this.pass = opts.pass;
    this.tls = opts.tls ?? false;
    for (const [label, value] of [["transportPingIntervalMs", opts.transportPingIntervalMs], ["transportMaxPingOut", opts.transportMaxPingOut], ["transportConnectTimeoutMs", opts.transportConnectTimeoutMs]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
        throw new Error(`EndpointOptions.${label} must be a positive safe integer`);
    }
    if ((opts.transportPingIntervalMs === undefined) !== (opts.transportMaxPingOut === undefined))
      throw new Error("EndpointOptions transportPingIntervalMs and transportMaxPingOut must be configured together");
    this.onConnection = opts.onConnection;
    this.overlapOnConnectionRenewal = opts.overlapOnConnectionRenewal === true;
    this.beforeBind = opts.beforeBind;
    this.transportPingIntervalMs = opts.transportPingIntervalMs ?? 10_000;
    this.transportMaxPingOut = opts.transportMaxPingOut ?? 2;
    this.transportConnectTimeoutMs = opts.transportConnectTimeoutMs;
    // No implicit channel: an endpoint reads exactly what its caller lists. Omitted means none.
    this.channels = opts.channels ?? [];
    this.allowSubscribe = opts.allowSubscribe;
    this.heartbeatMs = opts.heartbeatMs ?? 2000;
    this.ttlMs = opts.ttlMs ?? 6000;
    this.doRegister = opts.registerPresence ?? true;
    this.doWatch = opts.watchPresence ?? true;
    this.doWatchChannels = opts.watchChannels ?? true;
    this.doConsume = opts.consume ?? true;
    this.readOnce = opts.readOnce ?? false;
    if (this.readOnce && (this.doConsume || this.doRegister))
      throw new Error("EndpointOptions.readOnce requires consume and registerPresence false: a one-time read cannot keep a consumer's channel cache or its own presence current");
    if (opts.dmOnly !== undefined) {
      if (typeof opts.dmOnly.handler !== "function")
        throw new Error("EndpointOptions.dmOnly.handler must be a function");
      const settle = opts.dmOnly.settleTimeoutMs;
      if (settle !== undefined && (!Number.isSafeInteger(settle) || settle <= 0))
        throw new Error("EndpointOptions.dmOnly.settleTimeoutMs must be a positive safe integer");
      if (!this.authed)
        throw new Error("EndpointOptions.dmOnly requires creds or a bearer: it binds a provisioned durable and never creates one");
      if (!this.doConsume || this.doRegister || this.doWatch || this.doWatchChannels || this.readOnce)
        throw new Error("EndpointOptions.dmOnly requires consume true and registerPresence, watchPresence, watchChannels and readOnce false");
      if (this.channels.length || opts.card.role || opts.acceptedToken !== undefined)
        throw new Error("EndpointOptions.dmOnly takes no channels, role or acceptedToken: the endpoint reads only its own DM durable");
      this.requireLifecycleUid("EndpointOptions.dmOnly");
      this.dmOnly = opts.dmOnly;
    }
    // Seed the presence mirror so file-default channel modes are visible from the first publish
    // (not only after the first runtime toggle). Mirror only — delivery reads the connector's state.
    this.presence.seedChannelModes(opts.channelModes);
    this.ackWaitMs = opts.ackWaitMs ?? 60_000;
    this.inactiveThresholdMs = opts.inactiveThresholdMs ?? 600_000;
  }

  ref(): EndpointRef {
    return { id: this.card.id, name: this.card.name, role: this.card.role };
  }

  /** True on any AUTHED broker (static creds OR user-mode bearer) — the gate every open-vs-auth
   *  branch keys on: authed endpoints OPEN pre-created streams/KVs and BIND pre-provisioned
   *  durables (creates are denied to agents); only the open dev broker lazy-creates. */
  private get authed(): boolean {
    return Boolean(this.currentCreds || this.credsSource) || this.userMode;
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    const flight = this.startOnce().finally(() => {
      if (this.startPromise === flight) this.startPromise = undefined;
    });
    this.startPromise = flight;
    return flight;
  }

  private async startOnce(): Promise<void> {
    // A stopped dial is not a teardown failure. The stopped fence still closes any late epoch.
    try {
      await this.connectAndBind();
    } catch (error) {
      if (!this.stopped) throw error;
    }
    // stop() can finish while the INITIAL connectAndBind is still awaiting its broker work. The
    // rebuild path already closes that race; initial start needs the same fence or the late bind
    // leaves a fresh nc, heartbeat, consumers, and presence live on an endpoint already stopped.
    // superviseConnection below: nats.js auto-reconnects transient drops, and when it exhausts its
    // attempts and the connection closes for good we rebuild from scratch, so an in-process agent
    // (e.g. the OpenCode plugin) recovers without a host respawn. Armed only after a successful
    // first connect; a first-connect failure throws to the caller's connect-retry loop instead.
    if (await this.tearDownIfStopped()) return;
    this.superviseConnection();
  }

  /** The floor on a bearer renewal's delay. A token whose whole lifetime sits under it is renewed at
   *  this cadence (`expiry-renewal` mints 5s bearers). */
  private static readonly BEARER_MIN_RENEWAL_MS = 5_000;
  /** A failed bearer renewal retries after about this long, doubling per failure up to the cap. */
  private static readonly BEARER_RETRY_MS = 5_000;
  private static readonly BEARER_RETRY_CAP_MS = 60_000;

  /**
   * A condition the endpoint is already surviving. Node rethrows `error` when no listener is
   * attached, so emitting retry notices on `error` killed hosts that the endpoint intended to
   * keep running (#891). `warning` is observable and never fatal without a listener.
   */
  private emitRecoverable(err: Error): void {
    this.emit("warning", err);
  }

  /** Fetch a fresh bearer from the source, pin its principal to ours, arm the next renewal. On a
   *  fetch/principal failure: THROWS when `initial` (start() must fail loud before first connect);
   *  otherwise retries on a jittered, capped backoff, and warns once for the whole run of failures —
   *  the live connection keeps working until its current JWT expiry, so a dead auth service is
   *  loud without instantly dropping the mesh, and without a line per attempt. */
  private async refreshBearer(initial = false): Promise<void> {
    try {
      const bearer = await this.bearerSource!();
      const claims = decodeBearerPrincipal(bearer);
      if (claims.owner !== this.owner || claims.actor !== this.actor)
        throw new Error(`bearer source returned principal ${claims.owner}.${claims.actor}, expected ${this.owner}.${this.actor}`);
      // Two refusals, answering different questions, and both of them are about protecting what is
      // ALREADY held. So both are scoped to there BEING something held, which is the same set as
      // `!initial` but names the thing the rules actually depend on: on the first fetch there is no
      // cache to lose, `start()` has to come up on whatever the source has, and the pre-dial guard
      // in {@link bindConnection} is what speaks for a dead first token.
      const expiryMs = bearerExpiryMs(bearer);
      const held = this.currentBearer;
      if (held !== undefined) {
        // ALREADY DEAD, whatever else is true of it. Advancement is deliberately not part of this
        // test: a candidate expiring at now-5s does advance a held one that died at now-60s, so an
        // advance-only rule adopts it - overwriting the cache with material nothing can dial,
        // skipping the recoverable warning because the fetch did not throw, and arming the next
        // read off a non-positive delay. The creds path draws its line on expiry alone too, in
        // {@link presentableCreds} (#1572).
        if (expiryMs <= Date.now())
          throw new Error("the bearer source returned a token that has already expired - nothing adopted");
        // THE SAME BYTES BACK AGAIN from a source whose token is already past its renewal window:
        // the renewal it arms is floored to 5s, and the next read returns that same token - a 5s
        // loop against the auth service for the rest of its life, with the retry backoff bypassed
        // because the fetch did not FAIL. It succeeded and returned nothing new (#1561).
        //
        // The test is byte identity, not expiry, and not advancement. `exp` carries one second of
        // resolution, so a key rotation re-signing the same claims under a new key - and a healthy
        // short-TTL source read twice inside one wall-clock second - both hand back a token whose
        // `exp` has not moved. That is genuinely re-issued material, which an advancement test
        // refuses and this one adopts. It is the question the creds path asks with
        // `credsFingerprint`: did the source re-issue ANYTHING (#1572).
        if (bearer === held && Date.now() >= bearerRenewalDeadlineMs(held, this.bearerAdoptedAtMs))
          throw new Error("the bearer source re-served the token already held and it cannot carry another cycle (the auth service has not issued a fresh one) - nothing adopted");
      }
      if (bearer !== held) this.bearerAdoptedAtMs = Date.now();
      this.currentBearer = bearer;
      this.bearerRenewalFailures = 0;
      // The renewal point is drawn from the middle of the token's lifetime, spaced from this
      // process's other renewals in the space: a fixed margin before `exp` kept every endpoint
      // issued in one second renewing, and rebinding through the callout, in one second for life.
      const { issuedAtMs, expiresAtMs } = bearerLifetimeMs(bearer, this.bearerAdoptedAtMs);
      this.armBearerTimer(armRenewal(this.space, issuedAtMs, expiresAtMs, () => void this.renewBearerOnTimer(), CotalEndpoint.BEARER_MIN_RENEWAL_MS));
    } catch (e) {
      if (initial) throw e;
      if (this.bearerRenewalFailures === 0)
        this.emitRecoverable(new Error(`bearer refresh failed (${e instanceof Error ? e.message : String(e)}) - retrying with backoff; this connection dies at its current token's expiry if the auth service stays down`));
      // A wait the source named is kept as named: never retried inside it, nor stretched by the backoff.
      const named = retryAfterMs(e);
      const delay = named > 0 ? named : jitteredBackoffMs(this.bearerRenewalFailures, CotalEndpoint.BEARER_RETRY_MS, CotalEndpoint.BEARER_RETRY_CAP_MS);
      this.bearerRenewalFailures++;
      const timer = setTimeout(() => void this.renewBearerOnTimer(), delay);
      timer.unref?.();
      this.armBearerTimer(() => clearTimeout(timer));
    }
  }

  private armBearerTimer(cancel: () => void): void {
    this.cancelBearerRenewal?.();
    this.cancelBearerRenewal = cancel;
    if (this.stopped) cancel();
  }

  /** The timed renewal. A new token moves the live connection onto itself at once, through the
   *  same controlled reconnect the creds path uses, so the broker never has to expire a connection
   *  this endpoint could renew. With no live connection, it ends the rebuild loop's wait instead:
   *  that loop refuses to dial an expired token and leaves the retries to this timer. */
  private async renewBearerOnTimer(): Promise<void> {
    const held = this.currentBearer;
    await this.refreshBearer();
    if (this.stopped || this.currentBearer === held) return;
    if (this.nc && !this.nc.isClosed()) await this.swapConnectionOntoFreshCreds();
    else this.kickBackoff();
  }

  /** The cached bearer, checked: every (re)connect attempt reads it, the reconnects nats.js runs
   *  on its own included, so none presents an expired token, which the callout could only deny
   *  after a full round trip. The bearer counterpart of {@link credsForWire}. */
  private bearerForWire(): string {
    const bearer = this.currentBearer;
    if (bearer !== undefined && bearerExpiryMs(bearer) > Date.now()) return bearer;
    throw new Error(
      this.bearerSource
        ? "this endpoint's user bearer has expired and renewal through the auth exchange is failing - not presenting the expired token to the broker; retrying with backoff"
        : "this endpoint's user bearer has expired and it holds no bearer source to renew it - re-authenticate and rebuild the endpoint (construct it with a bearer FUNCTION for standing renewal)",
    );
  }

  /** How soon a FAILED creds refresh retries. Successful refreshes schedule by lifetime fraction
   *  (75% of iat→exp), not a fixed margin — standing creds span hours to days, bearers minutes. */
  private static readonly CREDS_RETRY_MS = 60_000;

  /** THE ONE PLACE a credential is cleared for presentation to a broker.
   *
   *  The property is unconditional — this endpoint never presents a credential it has already
   *  decoded as expired — so it is a property of the SUPPLY, not of any one dial site. It used to
   *  live inside {@link bindConnection}, which only `start()` and `doRebuild` reach; the
   *  authenticator nats.js re-evaluates on ITS OWN reconnects read the cache directly and so
   *  presented whatever was last fetched, expired included. Two such reconnects exist and neither
   *  passes through bindConnection: the one the broker forces at JWT `exp`, and an ALREADY RUNNING
   *  dial loop from an earlier drop that crosses `exp` while it retries (the pre-expiry
   *  reconnect fence flips a policy flag nats-core only reads when it observes a NEW drop, so it
   *  cannot stop a loop already in flight).
   *
   *  Putting the refusal here instead means a future caller cannot miss it: the only way to reach a
   *  dial is through {@link credsForWire}, and the one presentation that does not read the cache
   *  (the adoption preflight, which presents a fresh CANDIDATE) calls this same function on it.
   *
   *  An unbounded credential (no numeric `exp`) is presentable: bounded lifetimes are the renewal
   *  seam's concern, and a cred with no expiry has none to be past. */
  private static presentableCreds(creds: string, opts: { renewable: boolean }): string {
    const { exp } = credsClaims(creds); // throws on a structurally-unusable file (fail-loud)
    if (typeof exp === "number" && exp * 1000 <= Date.now())
      throw new Error(
        opts.renewable
          ? "this endpoint's creds have expired and renewal is failing - not presenting the expired credential to the broker; retrying with backoff"
          : "this endpoint's creds have expired and it holds no creds source to renew them - replace the credential and rebuild the endpoint (pass a creds FUNCTION for standing renewal)",
      );
    return creds;
  }

  /** The connect attempt's credential getters: what {@link credsForWire} and {@link bearerForWire}
   *  return, with its expiry recorded as {@link presentedExp}. */
  private presentCreds(): string {
    const creds = this.credsForWire();
    this.presentedExp = credsClaims(creds).exp;
    return creds;
  }

  private presentBearer(): string {
    const bearer = this.bearerForWire();
    this.presentedExp = bearerExpiryMs(bearer) / 1000;
    return bearer;
  }

  /** The cached credential, checked. Handed to nats.js as the authenticator's source on EVERY auth
   *  mode (renewed or static), so each (re)connect attempt — ours or the library's — re-reads a
   *  CHECKED value. A refusal throws out of the authenticator, which nats-core turns into a closed
   *  connection rather than a CONNECT carrying dead material; the endpoint's own supervisor then
   *  rebuilds on capped backoff, and {@link bindConnection} re-fetches from the source on each of
   *  those attempts, so a renewal that starts working recovers the endpoint without presenting
   *  anything expired in the meantime. Deliberately side-effect free: kicking the renewal timer
   *  from here would retry the source once per dial attempt, which is the flat load on a dead
   *  broker that {@link RETRY_BACKOFF_CAP_MS} exists to prevent. */
  private credsForWire(): string {
    if (!this.currentCreds)
      throw new Error(
        this.credsSource
          ? "this endpoint has no credential to present yet (the creds source has not returned one) - not dialing without auth material"
          : "this endpoint was constructed with an empty creds string - not dialing without auth material (an empty credential is not anonymous access)",
      );
    return CotalEndpoint.presentableCreds(this.currentCreds, { renewable: Boolean(this.credsSource) });
  }

  /** The credential this endpoint presents on its next connect, checked as {@link credsForWire}
   *  checks it. A second connection under the same identity reads it on every attempt, so it
   *  presents each credential this endpoint adopts and never an expired one. */
  wireCreds(): string {
    return this.credsForWire();
  }

  /** Refuses a fetched generation there is nothing to renew FROM, so the caller's failure posture
   *  ({@link CREDS_RETRY_MS}) applies instead of the renewal schedule (issue #1523).
   *
   *  A source that hands back the SAME generation past its own renewal point has not re-signed yet:
   *  that is a missed remint, not a candidate. Adopting it re-arms from a non-positive delay, which
   *  {@link armCredsRefresh} floors to 1s, which fetches again, which is the same generation — a 1s
   *  read loop against a store that is already having a bad day, for the JWT's remaining 25% of life,
   *  with the 60s backoff that exists for exactly this bypassed because the fetch did not FAIL.
   *
   *  The membership feed's rw-cred renewal already refuses it this way (`membership-feed.ts`,
   *  `adoptRwCreds`: "the rw source still holds the previous generation past its renewal point");
   *  this is the same rule on the endpoint's `delivery.creds` seam, so the two renewal paths answer
   *  a dead source identically.
   *
   *  An ALREADY-EXPIRED generation is refused whatever it is: the delay is non-positive for it too,
   *  but it is dead rather than merely due, so it is named separately and refused even when the
   *  source keeps returning a different one. */
  private static assertRenewableGeneration(candidate: string, current: string | undefined, delayMs: number): void {
    const { exp } = credsClaims(candidate);
    if (typeof exp === "number" && exp * 1000 <= Date.now())
      throw new Error("the creds source returned an already-expired credential (its `exp` is in the past) - nothing adopted; the renewal owner has not re-signed it, or the store is serving a stale generation");
    // Compared by GENERATION, not by envelope. `EndpointOptions.creds` takes opaque file content and
    // promises no canonical whitespace: `jwtFromCreds` pads with `\s*` and trims, so a store, editor or
    // filesystem round trip that adds a newline re-serves the SAME credential in bytes `===` calls
    // different - and the refusal would be skipped for the one case it exists to catch. The envelope
    // also carries the nkey seed, which is why `credsFingerprint` hashes the JWT instead.
    if (current !== undefined && credsFingerprint(candidate) === credsFingerprint(current) && delayMs <= 0)
      throw new Error("the creds source still holds the previous generation past its renewal point (the renewal owner has not re-signed it) - nothing adopted");
  }

  /** The disposable-preflight connect bound for the EXPLICIT reload proof (D5 class-2 adoption). A
   *  rogue or unreachable candidate must resolve well UNDER the manager's delivery-admin request
   *  bound, so this stays a few seconds and never blocks the responder. */
  private static readonly PREFLIGHT_MS = 4_000;

  /** How long the resident wire swap is deferred past the reply on the EXPLICIT reload path. The
   *  delivery-admin responder rides THIS connection, so `nc.reconnect()` must not run until the
   *  reply has flushed on the still-live old cred; the old cred stays valid until its exp, so a short
   *  deferral is safe. */
  private static readonly RESIDENT_SWAP_DEFER_MS = 250;

  /** How long a delivery-admin request read after a reload waits for the resident swap's reconnect.
   *  nats.js drops a publish made while the connection is down when it redials, so a reply sent
   *  during the swap is lost and its caller waits out its whole request timeout. Past this bound the
   *  request is answered anyway, as it was before the gate. */
  private static readonly RESIDENT_SWAP_GATE_MS = 5_000;

  /** The resident swap a reload scheduled, until its connection is back or the gate's bound ends. */
  private residentSwap?: Promise<void>;

  /** The daemon-side deadline for the WHOLE prove-then-adopt transaction (source fetch + preflight +
   *  commit), kept strictly BELOW the manager's delivery-admin request bound so a slow or hung hosted
   *  store returns a structured component failure rather than an ambiguous client timeout, and a late
   *  fetch can never commit after the caller gave up. */
  private static readonly RELOAD_DEADLINE_MS = 12_000;

  /** Fetch fresh creds from the source, pin their identity to ours, cache them, and arm the next
   *  refresh at 75% of the new JWT's lifetime. THROWS on fetch/pin failure — the callers decide the
   *  failure posture (loud-and-retry for the timer, a structured error reply for an explicit
   *  {@link reloadCreds}). This is the PASSIVE-BACKSTOP fetch; the explicit auditable path
   *  ({@link reloadCreds}) does its own fetch so it can preflight the candidate on a disposable
   *  connection BEFORE mutating this live cache. */
  private async fetchFreshCreds(): Promise<{ iat?: number; exp?: number }> {
    const creds = await this.credsSource!();
    const id = idFromCreds(creds);
    if (id !== this.connId)
      throw new Error(`creds source returned identity ${id}, expected ${this.connId} - renewal may not swap the connection's nkey`);
    // Before the commit, so a refusal leaves the cache holding the last generation that was renewable
    // from (and, on the initial fetch, fails loud rather than dialling with dead material).
    const delay = credsRenewalDelayMs(creds);
    CotalEndpoint.assertRenewableGeneration(creds, this.currentCreds, delay);
    this.currentCreds = creds;
    this.armCredsRefresh(delay);
    const { iat, exp } = credsClaims(creds);
    return { iat, exp };
  }

  /** Swap the live connection onto the freshest cached cred or bearer with a controlled
   *  `nc.reconnect()` (nats.js re-evaluates the authenticator per attempt). Swapping now, instead of
   *  waiting for the broker to close the connection at `exp`, means the wire never carries a
   *  near-dead JWT and the operator never sees a spurious "authentication expired". After the
   *  reconnect succeeds, re-arm the expiry fence for the credential now authenticated on the wire. */
  private async swapConnectionOntoFreshCreds(): Promise<void> {
    const nc = this.nc;
    if (!(nc && !this.stopped)) return;
    const overlap = this.overlapOnConnectionRenewal && this.onConnection
      ? await this.openRenewalOverlap().catch(() => undefined)
      : undefined;
    try {
      // reconnect() resolves when the disconnect is requested, before subscriptions return.
      // A flush started now is sent after those subscriptions, so it resolves only once they
      // are on the broker. The overlap stays up until then.
      await nc.reconnect().catch(() => {});
      if (overlap && !nc.isClosed())
        await withDeadline(nc.flush(), 10_000, () => new Error("resident renewal flush did not finish")).catch(() => {});
      if (this.nc === nc && !this.stopped) this.armAuthExpiryReconnectFence(nc);
    } finally {
      if (overlap && !overlap.isClosed()) await this.closeWithoutLibraryReconnect(overlap).catch(() => {});
    }
  }

  /** A second connection whose `onConnection` subscriptions are flushed before the resident
   *  reconnect. Its inbox is not the resident connection's inbox. A flush that does not finish
   *  closes it and leaves the caller to reconnect in place. */
  private async openRenewalOverlap(): Promise<NatsConnection> {
    const overlap = await dialerFor(this.servers)({
      servers: this.servers,
      noAsyncTraces: true,
      name: `cotal:${this.card.name}:renewal`,
      inboxPrefix: `_INBOX_renew_${randomUUID()}`,
      maxReconnectAttempts: 0,
      ...authOpts({
        token: this.token, user: this.user, pass: this.pass,
        creds: this.currentCreds !== undefined || this.credsSource ? () => this.presentCreds() : undefined,
        bearer: this.userMode ? () => this.presentBearer() : undefined,
        sentinelCreds: this.sentinelCreds, tls: this.tls,
      }),
    });
    this.ownedConnections.add(overlap);
    try {
      this.onConnection?.(overlap);
      await withDeadline(overlap.flush(), 5_000, () => new Error("renewal overlap flush did not finish"));
      return overlap;
    } catch (error) {
      await this.closeWithoutLibraryReconnect(overlap).catch(() => {});
      throw error;
    }
  }

  /** nats-core keeps its reconnect switch on the protocol handler. This pinned internal shape is the
   *  same last-resort surface used by {@link closeFailedBind}; there is no public API for changing the
   *  reconnect policy of an existing connection. Disabling it does not disable Cotal self-heal: the
   *  `nc.closed()` supervisor below rebuilds the endpoint with freshly checked auth material. */
  private disableLibraryReconnect(nc: NatsConnection): void {
    const protocol = (nc as unknown as { protocol?: { options?: { reconnect?: boolean } } }).protocol;
    if (protocol?.options) protocol.options.reconnect = false;
  }

  /** Close a connection whose library reconnect has already been disabled. `drain()` flushes with a
   *  PING and waits for the matching PONG; nats-core only rejects that waiter inside reconnect
   *  `prepare()`, so a half-open socket with reconnect=false leaves drain pending until the 2-minute
   *  ping interval times out. `close()` tears the transport down without that round-trip, which is
   *  the same public path {@link closeFailedBind} already uses when there is no graceful delivery
   *  contract left. */
  private async closeWithoutLibraryReconnect(nc: NatsConnection | undefined): Promise<void> {
    if (!nc) return;
    this.disableLibraryReconnect(nc);
    await nc.close();
    if (!nc.isClosed()) throw new Error("endpoint connection closure is unproved; consumer custody must be retained");
    this.ownedConnections.delete(nc);
  }

  /** Disable nats-core reconnect shortly before the JWT authenticated on this wire expires. The small
   *  lead makes the policy change precede the broker's expiry close even when both timers wake in the
   *  same event-loop turn. A credential adoption does not move this fence until the resident reconnect
   *  is requested, so the old wire remains protected during the prove-then-adopt window. */
  private armAuthExpiryReconnectFence(nc: NatsConnection): void {
    clearTimeout(this.authExpiryReconnectTimer);
    this.authExpiryReconnectTimer = undefined;
    const credsExp = this.currentCreds && credsClaims(this.currentCreds).exp;
    const expiryMs = this.userMode && this.currentBearer
      ? bearerExpiryMs(this.currentBearer)
      : typeof credsExp === "number"
        ? credsExp * 1000
        : undefined;
    if (expiryMs === undefined || this.stopped) return;
    // Node fires a delay above 2^31-1 ms (about 24.8 days) after 1 ms, which would disable reconnect
    // at once. A later expiry waits in steps of that bound, and the fence is armed again from there.
    const delay = Math.max(0, expiryMs - Date.now() - 500);
    this.authExpiryReconnectTimer = delay > MAX_TIMER_MS
      ? setTimeout(() => { if (this.nc === nc) this.armAuthExpiryReconnectFence(nc); }, MAX_TIMER_MS)
      : setTimeout(() => { if (this.nc === nc) this.disableLibraryReconnect(nc); }, delay);
    this.authExpiryReconnectTimer.unref?.();
  }

  /** The connectAndBind PRE-CONNECT fetch: pull the freshest source cred and pin it into
   *  {@link currentCreds} so the connect() that immediately follows presents it — that connect IS the
   *  proof, so NO preflight and NO live swap here. THROWS when `initial` (no cred to start from), else
   *  emits and retries. The LIVE-SWAP paths — the 75% timer {@link renewCredsOnTimer} and the explicit
   *  {@link reloadCreds} — preflight the candidate on a disposable connection instead, so they never
   *  reconnect the live connection onto an unproven cred. */
  private async refreshCreds(initial = false): Promise<void> {
    try {
      await this.fetchFreshCreds();
    } catch (e) {
      if (initial) throw e;
      this.emitRecoverable(new Error(`creds refresh failed (${e instanceof Error ? e.message : String(e)}) - retrying; this connection dies at its current JWT's expiry if renewal keeps failing`));
      this.armCredsRefresh(CotalEndpoint.CREDS_RETRY_MS);
    }
  }

  /** Serializes every prove-then-adopt transaction (the 75% timer and the explicit reload) so a timer
   *  tick and an explicit reload can never interleave their fetch/preflight/commit — the design's
   *  single-flight requirement. Runs `fn` after any in-flight transaction settles, whatever its
   *  outcome; the internal chain never rejects. */
  private credsTxn: Promise<unknown> = Promise.resolve();
  private runCredsTxn<T>(fn: () => Promise<T>): Promise<T> {
    const counted = async (): Promise<T> => {
      this.credsTxnsRunning++;
      try { return await fn(); } finally { this.credsTxnsRunning--; }
    };
    const next = this.credsTxn.then(counted, counted);
    this.credsTxn = next.then(() => undefined, () => undefined);
    return next;
  }

  /** The one PROVE-then-adopt transaction shared by the 75% timer and the explicit reload (run under
   *  {@link runCredsTxn}). Fetch (deadline-bounded) → identity-pin → optional `expected` fingerprint →
   *  PREFLIGHT the candidate on a disposable connection → fence a late commit against the deadline →
   *  commit {@link currentCreds} → arm the next 75% timer. Because currentCreds is written ONLY after
   *  the preflight proves broker acceptance, the resident authenticator getter can never present an
   *  unproven cred (not even on an incidental reconnect), and a rejected candidate leaves the resident
   *  connection untouched on BOTH the timer and explicit paths. THROWS (structured) on any failure. */
  private async adoptFreshCreds(opts: { expected?: string; deadline?: number } = {}): Promise<{ iat?: number; exp?: number }> {
    // ABSOLUTE deadline, captured at the CALLER's entry (reloadCreds / renewCredsOnTimer) BEFORE the
    // single-flight enqueue, so the queue wait behind an in-flight transaction counts against it. A
    // reload queued behind a hung-store timer tick can never receive a FRESH budget and commit after
    // the renewal owner's request bound already elapsed.
    const deadline = opts.deadline ?? Date.now() + CotalEndpoint.RELOAD_DEADLINE_MS;
    // Fence BEFORE any source I/O: if the queue wait already burned the budget, fail structured now and
    // never touch the store, the preflight, or currentCreds.
    if (Date.now() > deadline)
      throw new Error("reloadCreds: the request deadline elapsed while queued behind another credential transaction; nothing adopted");
    const candidate = await withDeadline(this.credsSource!(), deadline - Date.now(), () => new Error("reloadCreds: the creds source did not return before the daemon deadline; nothing adopted"));
    const id = idFromCreds(candidate);
    if (id !== this.connId)
      throw new Error(`creds source returned identity ${id}, expected ${this.connId} - renewal may not swap the connection's nkey`);
    // Non-material message ON PURPOSE: this text flows to the manager's persisted
    // `RenewalRecord.adoption.error`, so neither the observed nor the expected digest may appear.
    if (opts.expected !== undefined && credsFingerprint(candidate) !== opts.expected)
      throw new Error("reloadCreds: re-read credential generation did not match the expected re-signed generation (a different store, or a torn/stale read); nothing adopted");
    // PREFLIGHT = the proof. A disposable connection presenting exactly the candidate BEFORE the live
    // cache is touched; a refused cred throws here, leaving the resident connection untouched.
    // The candidate goes through the SAME checkpoint the resident getter uses: this is the one
    // presentation that does not read the cache, so routing it here is what makes the refusal a
    // property of every path rather than of the cached one. An already-dead re-signed generation is
    // refused locally instead of spending a round trip to be told so, and — because this throws
    // BEFORE the commit below — it can never become the resident connection's next-presented cred.
    const proven = CotalEndpoint.presentableCreds(candidate, { renewable: true });
    const probe = await probeConnect(this.servers, { creds: proven, tls: this.tls, timeoutMs: Math.max(500, Math.min(CotalEndpoint.PREFLIGHT_MS, deadline - Date.now())) });
    if (!probe.ok)
      throw new Error(`reloadCreds: the broker did not accept the re-signed credential (${probe.reason}); nothing adopted`);
    if (Date.now() > deadline)
      throw new Error("reloadCreds: the proof exceeded the daemon deadline; nothing adopted"); // fence a late commit
    // Validate the bounded-window renewal delay BEFORE the commit: credsRenewalDelayMs throws on a cred
    // lacking a numeric `exp`, and that throw must not leave currentCreds flipped to a candidate the
    // authenticator would present on the next reconnect (a post-preflight validation failure is a no-op).
    const delay = credsRenewalDelayMs(candidate);
    CotalEndpoint.assertRenewableGeneration(candidate, this.currentCreds, delay);
    this.currentCreds = candidate;
    this.armCredsRefresh(delay);
    this.emit("creds-adopted", credsClaims(candidate));
    return credsClaims(candidate);
  }

  /** The 75%-of-lifetime renewal timer tick: prove + adopt + swap the LIVE connection. Preflights (it
   *  reconnects a live connection, so the candidate must be broker-proven first) and is serialized
   *  with the explicit reload. Never throws — a failed renewal logs and retries while the old cred
   *  stays live until its expiry. */
  private async renewCredsOnTimer(): Promise<void> {
    // Deadline captured HERE, before the enqueue, for the same reason as the explicit reload.
    const deadline = Date.now() + CotalEndpoint.RELOAD_DEADLINE_MS;
    try {
      await this.runCredsTxn(() => this.adoptFreshCreds({ deadline }));
      await this.swapConnectionOntoFreshCreds();
    } catch (e) {
      this.emitRecoverable(new Error(`creds refresh failed (${e instanceof Error ? e.message : String(e)}) - retrying; this connection dies at its current JWT's expiry if renewal keeps failing`));
      this.armCredsRefresh(CotalEndpoint.CREDS_RETRY_MS);
    }
  }

  /** Fetch, broker-prove and adopt the source credential, then refresh the same connection
   * once outgoing mux and named-reply requests are quiet. A busy timeout retains the connection
   * and adopted credential. Call again to retry. This does not tear down endpoint bindings.
   * A dropped connection that is being re-established carries no request, so it redials now
   * instead of after its backoff; the rebuild re-fetches a stale credential from the source. */
  async refreshCredsRequestSafe(): Promise<void> {
    if (!this.credsSource) throw new Error("credential refresh requires a creds source");
    const nc = this.nc;
    if (!nc && !this.stopped && (this.reconnecting || this.reestablishing)) return await this.reconnect();
    if (!nc || this.stopped) throw new Error("credential refresh requires a running endpoint");
    const deadline = Date.now() + CotalEndpoint.RELOAD_DEADLINE_MS;
    await this.runCredsTxn(async () => {
      await this.adoptFreshCreds({ deadline });
      if (this.nc !== nc || this.stopped) throw new Error("endpoint connection changed during credential refresh");
      await requestSafeReconnect(nc, () => this.requestsAwaitingReply.get(nc)?.size ?? 0);
      if (this.nc === nc && !this.stopped) this.armAuthExpiryReconnectFence(nc);
    });
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
  async reloadCreds(expected?: string): Promise<{ identity: string; iat?: number; exp?: number }> {
    if (!this.credsSource)
      throw new Error("reloadCreds: this endpoint has no creds source (a static cred cannot be renewed in place)");
    // Capture the ABSOLUTE deadline at ENTRY, before enqueue, so a reload queued behind a hung-store
    // 75% timer tick is bounded by the SAME window (queue wait included) and cannot commit/swap after
    // the renewal owner's request bound has already elapsed and it recorded "no responder".
    const deadline = Date.now() + CotalEndpoint.RELOAD_DEADLINE_MS;
    // The prove-then-adopt transaction (fetch + preflight + commit) runs under the single-flight so it
    // cannot interleave with the 75% timer; the wire swap is scheduled by {@link handleDeliveryAdmin}
    // after the aggregate reply (the responder rides this connection).
    const { iat, exp } = await this.runCredsTxn(() => this.adoptFreshCreds({ expected, deadline }));
    return { identity: this.connId, iat, exp };
  }

  /** Arm the resident wire swap for the delivery-admin `reloadCreds` path. Called by
   *  {@link handleDeliveryAdmin} ONLY after BOTH component proofs have settled and immediately before
   *  the reply is returned+responded — never from inside {@link reloadCreds} while the aggregate is
   *  still open, or a slow co-component proof would let `nc.reconnect()` reconnect the admin rail
   *  before the reply flushes and silently strand it. The short deferral lets the reply flush on the
   *  still-live old cred first. Best-effort — the proof was the preflight; a transient swap failure is
   *  retried by the 75% timer and the broker's own expiry-close, both presenting the adopted candidate.
   *  Until the swapped connection is back, {@link residentSwap} holds the delivery-admin requests that
   *  arrive after this reply. */
  private scheduleResidentSwap(): void {
    if (this.stopped) return;
    const swap: Promise<void> = new Promise<void>((resolve) => { setTimeout(resolve, CotalEndpoint.RESIDENT_SWAP_DEFER_MS).unref?.(); })
      .then(async () => {
        const back = this.transportBack(CotalEndpoint.RESIDENT_SWAP_GATE_MS);
        await this.swapConnectionOntoFreshCreds();
        await back;
      })
      .finally(() => { if (this.residentSwap === swap) this.residentSwap = undefined; });
    this.residentSwap = swap;
  }

  /** Resolve when this endpoint reports its transport connected again, or after `ms`. */
  private transportBack(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.off("transport", seen); resolve(); };
      const seen = (state: TransportState) => { if (state.connected) done(); };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      this.on("transport", seen);
    });
  }

  private armCredsRefresh(delayMs: number): void {
    if (this.stopped) return;
    clearTimeout(this.credsTimer);
    // 1s floor (vs the bearer's 5s): standing-renewal smokes exercise second-scale TTLs; production
    // lifetimes are hours+ so the floor never engages there. Node fires a delay above 2^31-1 ms after
    // 1 ms, and a terminal seat's credential can run to 2106, so a later renewal waits in steps of
    // that bound.
    this.credsTimer = delayMs > MAX_TIMER_MS
      ? setTimeout(() => this.armCredsRefresh(delayMs - MAX_TIMER_MS), MAX_TIMER_MS)
      : setTimeout(() => void this.renewCredsOnTimer(), Math.max(1_000, delayMs));
    this.credsTimer.unref?.();
  }

  /** Open the connection and bind everything that hangs off it: status watch, presence
   *  watch + heartbeat, channel registry, and the durable consumers. Re-runnable — a
   *  reconnect calls it again after {@link clearConnectionScoped}; every binding is
   *  idempotent (durables bind by name, JetStream dedups by msgID, KV opens are idempotent). */
  private async connectAndBind(): Promise<void> {
    try {
      await this.bindConnection();
    } catch (error) {
      await this.closeFailedBind();
      throw error;
    }
  }

  private async bindConnection(): Promise<void> {
    this.clearConnectionScoped();
    // Bearer-source endpoints fetch before the FIRST connect, and renew first on a rebuild whose
    // cached token is past its renewal window (a rebuild after a long outage would otherwise
    // present a dead bearer). While renewals are failing, their retry timer owns the source: a
    // fetch here too would add one call to the exchange per rebuild attempt.
    if (this.bearerSource) {
      if (!this.currentBearer) await this.refreshBearer(true);
      else if (this.bearerRenewalFailures === 0 && Date.now() >= bearerRenewalDeadlineMs(this.currentBearer, this.bearerAdoptedAtMs)) await this.refreshBearer();
    }
    // Creds-source endpoints likewise fetch before the FIRST connect, and re-fetch on a rebuild
    // whose cached cred is expired or inside its renewal window.
    if (this.credsSource) {
      const stale = !this.currentCreds || credsRenewalDelayMs(this.currentCreds) <= 0;
      if (stale) await this.refreshCreds(!this.currentCreds);
    }
    // Never dial with material we can already prove is dead. The refresh above is best-effort (a
    // failed renewal emits and retries rather than throwing, so a dead auth service does not
    // instantly drop a still-live mesh), which used to leave the connect below presenting an
    // EXPIRED bearer: a guaranteed denial that still costs a full auth-callout round trip, repeated
    // by the reestablish loop at a flat rate for as long as the process lives. Refuse here instead.
    // The loop's capped backoff paces the retries and re-enters this method, and a renewal that
    // starts working ends its wait; an endpoint with no bearer source cannot renew at all, and says
    // so. The refusal is surfaced once per outage: the loop retries a repeat without a notice.
    if (this.userMode) {
      try {
        this.bearerForWire();
        this.bearerRefusalSurfaced = false;
      } catch (e) {
        if (!this.bearerRefusalSurfaced) {
          this.bearerRefusalSurfaced = true;
          throw e;
        }
        throw new RepeatedRefusal((e as Error).message);
      }
    }
    // The CREDS refusal is NOT repeated here. It lives on the supply itself ({@link credsForWire}),
    // which the authenticator below re-reads per attempt, so it covers this dial AND the reconnects
    // nats.js runs on its own. Raising it early here too would only duplicate it on the one path
    // that was already covered, and a fourth dial site added later would silently miss the copy.
    // The refusal still surfaces on this path: the authenticator throws during the CONNECT, the
    // library closes that attempt, and the reestablish loop's capped backoff re-enters here — where
    // the source re-fetch above is what recovers a renewable endpoint.
    let watchDeletePermission: IssuedSubjectPermission | undefined;
    this.nc = await dialerFor(this.servers)({
      servers: this.servers,
      // Keep native failures without eagerly capturing a request-origin stack on every operation.
      noAsyncTraces: true,
      // In USER MODE the connection `name` carries the client-chosen inbox nonce (= connId) the callout
      // scopes `_INBOX_<connId>.>` on (see EndpointOptions.bearer); otherwise it's the display handle.
      name: this.userMode ? this.connId : `cotal:${this.card.name}`,
      // Per-CONNECTION inbox namespace (the "Private Inbox" pattern), keyed on the connection nkey
      // (NOT the owner+actor principal): the reply inbox is per-connection plumbing, and under the auth
      // callout the principal is unknown to the client pre-connect (owner is derived server-side) while
      // the connection id always is. nats.js routes ALL generated inboxes — request replies, JetStream
      // pull delivery, kv.watch ordered-consumer delivery — through this prefix. Paired with
      // sub.allow=[_INBOX_<connId>.>] it stops a peer from subscribing the wildcard inbox to sniff
      // others' DM deliveries. Set unconditionally so the prefix can never drift from the ACL.
      inboxPrefix: `_INBOX_${this.connId}`,
      ...(this.transportPingIntervalMs === undefined ? {} : { pingInterval: this.transportPingIntervalMs }),
      ...(this.transportMaxPingOut === undefined ? {} : { maxPingOut: this.transportMaxPingOut }),
      ...(this.transportConnectTimeoutMs === undefined ? {} : { timeout: this.transportConnectTimeoutMs }),
      // The bearer rides the CHECKED getter: nats.js re-evaluates the token authenticator per
      // (re)connect attempt, so internal reconnects present whatever refreshBearer last fetched,
      // and refuse a token that has expired since, as the creds getter does.
      // Creds ALWAYS ride the CHECKED getter, renewed or static, so every attempt — including the
      // reconnects nats.js performs on its own (the one the broker forces at JWT `exp`, and a dial
      // loop from an earlier drop that crosses `exp` mid-retry) — re-reads a credential that has
      // just been proven unexpired rather than whatever the cache happens to hold.
      // The gate is `!== undefined`, NOT truthiness. An EMPTY creds string is a caller that meant to
      // authenticate and supplied nothing; on a truthiness gate it fell through to `creds: undefined`
      // and dialed ANONYMOUSLY, so the broker answered `Authorization Violation` and the real fault
      // (an empty credential) was never named. Routing it into the checked getter fails it loud
      // instead. Anonymous access stays reachable the only way it should be: by passing no creds.
      ...authOpts({ token: this.token, user: this.user, pass: this.pass, creds: this.currentCreds !== undefined || this.credsSource ? () => this.presentCreds() : undefined, bearer: this.userMode ? () => this.presentBearer() : undefined, sentinelCreds: this.sentinelCreds, tls: this.tls,
        onCreds: (creds) => {
          watchDeletePermission = undefined;
          try {
            const nats = credsClaims(creds).nats;
            if (nats?.pub !== undefined)
              watchDeletePermission = importNativeSubjectPermissions({ pub: nats.pub }).publish;
          } catch {
            // Unknown/malformed claims cannot prove a denial. Keep the existing broker check.
          }
        },
      }),
    });
    // SPEC §13.12: the control surface requires nats-server >= 2.12; this runs on every
    // fresh connection, including the reconnects the library performs on its own here.
    this.watchDeletePermissions.set(this.nc, () => watchDeletePermission);
    this.ownedConnections.add(this.nc);
    const owned = this.nc;
    void owned.closed().then(() => this.ownedConnections.delete(owned));
    this.onConnection?.(this.nc);
    requireBrokerFloor(this.nc);
    this.armAuthExpiryReconnectFence(this.nc);
    this.watchStatus();
    this.js = jetstream(this.nc);

    // DM-only (EndpointOptions.dmOnly): the own DM durable is the whole binding. Nothing below runs:
    // no accepted-row read, presence, channel registry, JetStream manager, lease, membership,
    // Plane-3 or liveness responder, so the credential needs no row for any of them.
    if (this.dmOnly) {
      await this.beforeBind?.();
      if (this.stopped) return;
      await this.bindDmOnly(this.dmOnly);
      if (this.stopped) return;
      this.emit("connection", { connected: true });
      return;
    }

    // Discovery of the issued generation (SPEC 13.15): the ISSUER wrote the accepted reference
    // under the token this launch was handed; the broker admits the read only under this
    // connection's own per-key grant. What comes back must name this incarnation, and a fresh
    // connection re-reads it: the generation is bound to the credential the transport presented,
    // never to a file that may have been replaced under it.
    if (this.acceptedToken !== undefined) {
      const ref = await readAcceptedRow(this.nc, this.space, this.acceptedToken);
      const uid = this.requireLifecycleUid("an issued endpoint");
      if (ref.owner !== this.owner || ref.actor !== this.actor || ref.uid !== uid)
        throw new Error(`the accepted row names ${ref.owner}.${ref.actor} (uid ${ref.uid}), not this endpoint ${this.owner}.${this.actor} (uid ${uid}); refusing to ride a foreign issuance (SPEC 13.15)`);
      this.issuedGeneration = ref.generation;
    }

    await this.beforeBind?.();
    if (this.stopped) return;

    if (this.doWatch || this.doRegister) {
      const kvm = new Kvm(this.nc);
      // The presence bucket is a JetStream stream. Open mode lazily creates it; auth mode
      // OPENs it (it's pre-created at `cotal up`; KV stream-create is denied to agents).
      this.kv = this.authed
        ? await kvm.open(presenceBucket(this.space))
        : await kvm.create(presenceBucket(this.space), { ttl: this.ttlMs, storage: PRESENCE_STORAGE });
    }

    if (this.doWatch && this.readOnce) await this.readPresenceOnce();
    else if (this.doWatch) {
      await this.startPresenceWatch();
      this.sweepTimer = setInterval(
        () => this.sweep(),
        Math.max(500, Math.floor(this.ttlMs / 3)),
      );
    }

    // Open the channel registry bucket when we either watch it (live cache for the connector's
    // pull/display) or consume (the join-time replay decision reads it fresh). A presence-only
    // supervisor (watchChannels:false, consume:false) skips it entirely — it needs no channel cache,
    // so its scoped cred holds no channel-registry read (residual 2). Auth mode OPENs the bucket
    // pre-created at `cotal up`; open mode lazily creates it.
    const watchChannels = this.doWatch && this.doWatchChannels;
    if (watchChannels || this.doConsume) {
      this.channelKv = await openChannelRegistry(this.nc, this.space, { create: !this.authed });
      if (watchChannels) await (this.readOnce ? this.readChannelsOnce() : this.startChannelWatch());
      // A seat reads the registry on demand, as it reads the roster; this first read fills the cache
      // its boot briefing renders from.
      else if (this.readsChannelsOnDemand) await this.readChannels();
    }

    // Rebind the daemon's lease-loss watch onto the fresh connection (#1596). The intent survived
    // clearConnectionScoped; a bind that completes after a stop or another rebuild finds the epoch
    // moved and retires itself. The replay re-delivers the row's current state, so a change that
    // landed in the null window still reaches the trigger.
    if (this.deliveryLease.hasWatchIntent) await this.bindDeliveryLeaseWatch();

    // FAIL BEFORE PRESENCE (SPEC 13.1): an AUTHED endpoint that will register on the roster or
    // bind lifecycle-keyed consumers must hold its launcher-supplied lifecycle uid BEFORE anything
    // makes it visible - a missing uid must never leave a roster ghost that could not bind (false
    // readiness). Non-registering, non-consuming infra endpoints (a provisioner window, the
    // delivery daemon, one-shot CLI probes) bind no lifecycle-keyed names and stay outside the
    // rule; open/token mode self-minted at construction, so this only ever throws for a
    // mis-launched AUTH endpoint.
    if (this.authed && (this.doConsume || this.doRegister))
      this.requireLifecycleUid(this.doConsume ? "an authed consuming endpoint" : "an authed presence-registering endpoint");

    // Consumers bind BEFORE presence publishes: the durable bind is the broker's proof that this
    // incarnation's lifecycle-keyed names match its minted grants, so a wrong-uid launch dies
    // with NO presence ghost instead of advertising an agent that can never receive.
    if (this.doConsume) {
      this.jsm = await jetstreamManager(this.nc);
      // Open mode: lazily create the streams on the first endpoint. Auth mode: they are
      // pre-created at `cotal up` and STREAM.CREATE is denied to agents, so skip.
      if (!this.authed) await this.ensureStreams();
      await this.startConsumers();
    }

    // The register-only broker proof: a consuming agent proved its lifecycle by binding a
    // durable above, but an authed AGENT that only REGISTERS presence (consume:false) has bound
    // nothing yet, so a wrong-but-valid uid would grammar-pass requireLifecycleUid and then
    // advertise a ghost that can receive nothing. Prove the incarnation at the broker FIRST — an
    // exact info on this agent's own pre-provisioned dm_<owner>-<actor>-<uid> durable (the
    // manager/self-provision minted it under the SAME uid). A wrong uid names a durable that
    // does not exist, so the info throws and presence never publishes. Only for `kind: "agent"`
    // (a peer on the roster); pure `kind: "endpoint"` infra (manager, delivery, feedback intake)
    // holds no dm_ durable and stays exempt.
    if (this.doRegister && !this.doConsume && this.authed && this.card.kind === "agent") {
      const jsm = this.jsm ?? (this.jsm = await jetstreamManager(this.nc));
      const uid = this.requireLifecycleUid("an authed presence-registering agent");
      try {
        await jsm.consumers.info(dmStream(this.space), dmDurable(this.owner, this.actor, uid));
      } catch (e) {
        throw new Error(
          `lifecycle proof failed for ${this.card.id} (uid ${uid}): its dm_ durable is not present at the broker, so this incarnation's uid does not match its provisioned resources - refusing to publish presence (SPEC 13.1 fail-before-presence): ${(e as Error)?.message ?? String(e)}`,
        );
      }
    }

    if (this.doRegister) {
      // #1356: this await is bounded already — a refused presence write returns no response at all,
      // so it surfaces as the JetStream request TIMEOUT (~5s), once, with no retry here. What it did
      // NOT do was say what failed: the bare `timeout` names no bucket, no space and no subsystem,
      // and a launcher that catches it has nothing to act on. The lifecycle-proof failure a few lines
      // above throws a fully explanatory message; this one is held to the same standard. Still fails
      // rather than degrading — SPEC 13.1 fail-before-presence means a registering agent that cannot
      // publish presence must not come up as though it had.
      try {
        await this.publishPresence();
      } catch (e) {
        const detail = (e as Error)?.message ?? String(e);
        throw new Error(
          `presence registration failed for ${this.card.id}: the space's presence KV bucket "${presenceBucket(this.space)}" did not accept this endpoint's first write (${detail}). The bucket can be OPENED and WATCHED while refusing every write, so a healthy-looking connection does not rule this out; a broker whose store has latched refuses until it is restarted, and no client can clear it (#1356).`,
        );
      }
      // Beat at this endpoint's own phase. A repeating timer re-arms from the instant its callback
      // ran, and every timer run in one timers pass re-arms to the same instant, so the heartbeats of
      // many endpoints in one process that once coincided stay coincident and the loop takes the whole
      // batch in one tick (5088 endpoints in one process: 1 to 2 s stalls, with the put deadlines
      // expiring inside them). Re-arming from the scheduled beat keeps each endpoint's phase.
      const phase = Date.now();
      let beat = 0;
      const arm = () => {
        const next = nextHeartbeat(phase, this.heartbeatMs, beat, Date.now());
        beat = next.beat;
        const handle = setTimeout(() => {
          this.publishPresence().catch((e) => this.emitRecoverable(e as Error));
          if (this.heartbeatTimer === handle) arm();
        }, next.delayMs);
        this.heartbeatTimer = handle;
      };
      arm();
    }

    // Caller-owned membership watches are INTENT rather than one-connection iterators. Re-open them
    // before reporting the endpoint connected, so a successful reconnect does not leave the graph stale.
    await this.rearmMembershipWatches();

    // Re-arm Plane-3 (delivery-daemon-hosted fan-out + trusted reader + ctl.delivery) on every (re)connect — no-op unless this
    // endpoint hosts it. The first arm comes from startPlane3 (after start()); this re-binds the loops
    // a reconnect's clearConnectionScoped() tore down, so a broker blip doesn't silently kill the backstop.
    await this.armPlane3();

    // Re-bind the liveness responders on this connection, for armPlane3's reason: the rebuild closed
    // the old connection and the responders with it.
    for (const plane of this.livenessResponders.keys()) this.bindLiveness(plane);
    // The principal serves subscribe again on the new connection and run their check again.
    this.rebindPrincipalServes(false);
    for (const tap of this.taps) this.bindTap(tap);

    // Bound and live — covers initial start, manual reconnect, AND background self-heal (every
    // path lands here). The single signal an in-process agent's connected flag tracks.
    //
    // The stopped guard: stop() can land in any await above. Both callers tear the fresh
    // connection back down (tearDownIfStopped), but an event has no undo, so a late
    // `connection: true` would be the last edge a listener ever sees on a stopped endpoint and
    // nothing follows it to correct the record. It belongs here rather than in a consumer because
    // every listener reads the same edge; MeshAgent carries its own `stopping` guard and so was
    // never the one exposed, which is the point.
    //
    // Measured for the start() caller by the broker suite's mid-bind cell. doRebuild is
    // also measured, by a separate cell that holds the rebuild's connectAndBind at
    // armPlane3 after a successful first bind and lands stop() in that window (#1028).
    // Shared-line reasoning is no longer the rebuild proof.
    if (this.stopped) return;
    this.emit("connection", { connected: true });
    if (this.nc) {
      for (const follower of this.activeGoalFollowers) {
        follower.reconnected(this.nc);
      }
    }
  }

  /** Tear down everything {@link connectAndBind} (re)creates, so a rebind can't leak a
   *  second heartbeat, double-pump a consumer, or keep stale roster ghosts. Caller-owned
   *  subs (tap/serve) are left alone — they aren't rebuilt here. */
  private clearConnectionScoped(): void {
    if (this.authExpiryReconnectTimer) {
      clearTimeout(this.authExpiryReconnectTimer);
      this.authExpiryReconnectTimer = undefined;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    for (const msgs of this.streamMsgs) {
      try {
        msgs.stop();
      } catch {
        /* already closed with the connection */
      }
    }
    this.streamMsgs.length = 0;
    this.presenceEpoch++;
    this.presence.cancelRebind();
    this.presence.retireWatch();
    if (this.channelWatchIter) this.retireKvWatch(this.channelWatchIter);
    this.channelWatchIter = undefined;
    this.stopDeliveryLeaseWatch();
    for (const sub of this.chatSubs.values()) {
      try {
        sub.unsubscribe();
      } catch {
        /* already closed with the connection */
      }
    }
    this.chatSubs.clear();
    this.chatSubDenied.clear();
    this.ownWatchDeletePrefixes.clear();
    this.presence.resetConnection();
    this.channelConfigs.clear();
    this.channelDefaults = {};
    // A read in flight on the old connection must not land in the new connection's cache.
    this.channelRead = undefined;
    this.channelReadGeneration++;
    this.channelReadApplied = this.channelReadGeneration;
    for (const watch of this.membershipFeedWatches)
      watch.arm = watch.arm.catch(() => {}).then(() => this.disarmMembershipWatch(watch)).catch((err) => { this.emit("error", err as Error); });
  }

  /** A transport can connect before a later JetStream/KV/subscription bind fails. The caller will
   * retry the whole start, so release that partial epoch first instead of overwriting `nc` and
   * leaving one established socket behind per retry. `close()` is deliberate: a failed bind has no
   * graceful delivery contract to drain, and cleanup itself must not extend the retry failure.
   *
   * A throwing `close()` is not hypothetical: nats.js `NatsConnectionImpl.close()` awaits the
   * protocol close, which itself flushes outbound + tears down subscription state; any of those
   * that reject leaves the underlying TCP transport ESTABLISHED even though every client handle
   * on this endpoint has been cleared. The next `start()` on the same object then dials a fresh
   * connection while the old socket stays live on the broker (`/varz.connections` climbs once per
   * failed attempt). The recovery path is layered, from most graceful to most surgical, matching
   * nats-core's public surface (nats.d.ts: `close`, `drain`, `isClosed`; protocol.d.ts owns the
   * `transport` handle whose `close(err?)` is the socket teardown; transport.d.ts exposes a
   * synchronous `disconnect()` for the case where even close rejects). We only touch a private
   * (`nc.protocol.transport`) when the public API has already refused, and the ORIGINAL bind
   * error is re-raised at every layer. The close error is diagnostic noise. The bind error is
   * what the caller must see.
   *
   * The delivery-serve subs and `this.subs` array are handles created by a successful
   * `armDeliveryControl` on a PREVIOUS epoch; a bind failure on the retry never rewrites them
   * because arming is a late step. Left in place they point at a dead protocol and survive into
   * the next retry. The reviewer flagged this as an untested handle class. Zero them here so a
   * retry starts with the same empty state as a first attempt. */
  private async closeFailedBind(): Promise<void> {
    const failedNc = this.nc;
    if (failedNc) this.disableLibraryReconnect(failedNc);
    this.clearConnectionScoped();
    this.nc = undefined;
    this.js = undefined;
    this.jsm = undefined;
    this.kv = undefined;
    this.channelKv = undefined;
    this.membersKv = undefined;
    this.aclKv = undefined;
    this.membershipFeedKv = undefined;
    this.deliveryLease.resetConnection();
    this.managerLeaseKv = undefined;
    this.daemonRenewalLeaseRevision = undefined;
    // Handles that armDeliveryControl created on a previous connection: null them so a rebind
    // does not carry a dead protocol's subs forward. Best-effort unsubscribe first (the sub is
    // dead with its connection either way; unsubscribing an already-dead sub is a noop).
    if (this.deliveryPlane.deliveryServeSub) {
      try { this.deliveryPlane.deliveryServeSub.unsubscribe(); } catch { /* dead with the old connection */ }
      this.deliveryPlane.deliveryServeSub = undefined;
    }
    if (this.deliveryPlane.deliveryAdminServeSub) {
      try { this.deliveryPlane.deliveryAdminServeSub.unsubscribe(); } catch { /* dead with the old connection */ }
      this.deliveryPlane.deliveryAdminServeSub = undefined;
    }
    this.dropAnycastRequests();
    for (const sub of this.subs) {
      try { sub.unsubscribe(); } catch { /* dead with the old connection */ }
    }
    this.subs.length = 0;
    if (!failedNc) return;
    // The old status iterator is stale after nc is cleared, so its close cannot report this edge.
    // As in doRebuild, teardown itself must announce the no-nc window before closing the socket.
    this.emit("transport", { connected: false } satisfies TransportState);
    this.emit("connection", { connected: false });
    // Layered teardown, comments kept OUT of the code span below on purpose: the mutation fixture
    // bin/smoke/mutations/failed-bind-cleanup.json anchors on that span verbatim and the fixture
    // census (bin/smoke/mutation-fixtures.smoke.ts) reddens an anchor that crosses a comment line.
    //   Fast path: the public close resolved, the broker drops the connection on its own.
    //   Layer 1: nats.js exposes drain() as the sanctioned "close on error" path. It flushes
    //   outbound then closes, and unlike close() has its own idempotent guard against a half-closed
    //   protocol. If drain resolves the socket is gone.
    //   Layer 2: last resort. nats.js `NatsConnectionImpl.protocol.transport` (see
    //   node_modules/@nats-io/nats-core/lib/{nats,protocol,transport}.d.ts) is the TCP socket the
    //   dialer produced. Its `close(err?)` returns a Promise once the socket is torn down; its
    //   synchronous `disconnect()` forces the FIN without waiting. Reached only after the public
    //   API has already refused, guarded only against the shape not being what the pinned version
    //   documents.
    try {
      await failedNc.close();
      return;
    } catch { /* fall through to the layered fallback */ }
    if (!failedNc.isClosed?.()) {
      try {
        await drainAndClose(failedNc);
        return;
      } catch { /* both graceful paths refused, drop to the transport */ }
    }
    const proto = (failedNc as unknown as { protocol?: { transport?: {
      close?: (err?: Error) => Promise<void>;
      disconnect?: () => void;
      isClosed?: boolean;
    } } }).protocol;
    const transport = proto?.transport;
    if (transport && !transport.isClosed) {
      try {
        await transport.close?.();
      } catch { /* transport close itself threw, force it down synchronously below */ }
      if (!transport.isClosed) {
        try { transport.disconnect?.(); } catch { /* nothing left to try */ }
      }
    }
  }

  /** If stop() ran during a rebuild's `await connectAndBind`, the just-bound connection +
   *  heartbeat + supervisor would be left live on a stopped endpoint. Tear that fresh
   *  connection back down and report it. Reads `this.nc` in its own scope (a bare `this.nc`
   *  in doRebuild narrows to `never` via TS inlining connectAndBind's assignment). Returns
   *  true iff it tore something down (caller bails out of the rebuild). */
  private async tearDownIfStopped(): Promise<boolean> {
    if (!this.stopped) return false;
    const nc = this.nc;
    if (nc) this.disableLibraryReconnect(nc);
    this.clearConnectionScoped();
    await this.closeWithoutLibraryReconnect(nc);
    this.nc = undefined;
    return true;
  }

  /** Watch for a terminal close (nats.js has exhausted its own reconnect) and rebuild.
   *  Our own stop()/drain also resolves closed(), so the `stopped` guard keeps a clean
   *  shutdown from re-establishing. The identity guard (`this.nc !== nc`) no-ops a STALE
   *  supervisor — one whose connection reconnect()/rebuild already replaced — so only a
   *  close of the CURRENT connection triggers a rebuild. The rebuild itself is serialized
   *  with the manual path via {@link rebuild}. */
  private superviseConnection(): void {
    const nc = this.nc;
    if (!nc) return;
    void nc.closed().then((err) => {
      if (this.stopped) return;
      if (this.nc !== nc) return; // epoch-stale — a rebuild already swapped this connection
      // ORDER IS PART OF THE DIAGNOSTIC CONTRACT. MeshAgent retains endpoint errors only while it is
      // not bound, so readiness must turn false before the matching terminal-close error is emitted.
      // Reversing these two lines silently loses the only post-drop reason an agent can report.
      this.emit("connection", { connected: false });
      this.emit(
        "error",
        new Error(`mesh connection closed${err ? `: ${err.message || err.name}` : ""} - re-establishing`),
      );
      void this.reestablishLoop();
    });
  }

  /** Single serialized rebuild: drain the old connection and rebind via {@link connectAndBind},
   *  guarded so concurrent triggers (manual {@link reconnect}, the supervisor's closed(), the
   *  retry loop) coalesce onto ONE in-flight rebuild instead of racing two connectAndBinds and
   *  leaking a connection. Returns the shared promise; a second caller gets the in-flight one. */
  private rebuild(): Promise<void> {
    if (this.rebuildPromise) return this.rebuildPromise;
    const p = this.doRebuild().finally(() => {
      if (this.rebuildPromise === p) this.rebuildPromise = undefined;
    });
    this.rebuildPromise = p;
    return p;
  }

  /** The transition: stop the connection-scoped timers FIRST (so nothing live touches
   *  this.nc during the null window), drop the connection refs, close the old nc, then
   *  rebind + re-arm the supervisor on the fresh connection. clearConnectionScoped is
   *  idempotent, so connectAndBind's own call here is a noop. */
  private async doRebuild(): Promise<void> {
    const oldNc = this.nc;
    if (oldNc) this.disableLibraryReconnect(oldNc);
    this.reconnecting = true;
    try {
      this.clearConnectionScoped();
      // Manual reconnect still has a live old epoch: complete broker-consumer cleanup before close.
      // Terminal self-heal has an already-closed epoch: disarm retains stream/name for fresh cleanup,
      // and the KV watch consumers that closed with it are left to the broker's inactive threshold.
      if (oldNc && !oldNc.isClosed())
        await Promise.all([...[...this.membershipFeedWatches].map((watch) => watch.arm), this.settleDeliveryLeaseWatches(), this.settleKvWatches()]);
      this.nc = undefined;
      this.js = undefined;
      this.jsm = undefined;
      this.kv = undefined;
      this.channelKv = undefined;
      // Plane-3 KV handles are bound to the old connection too — drop them so the daemon re-opens them on
      // the fresh nc (else durableJoin/leave/list, the reader's ACL re-auth, and lease renew use a dead
      // handle after a reconnect).
      this.membersKv = undefined;
      this.aclKv = undefined;
      this.membershipFeedKv = undefined;
      this.deliveryLease.resetConnection();
      // The manager's liveness-lease handle too: left bound to the old connection, every renew and
      // re-read after a reconnect times out, and the manager reports its lease unknown for good.
      this.managerLeaseKv = undefined;
      this.daemonRenewalLeaseRevision = undefined;
      // This is an application-requested epoch teardown, not a transient nats.js blip. The old
      // status iterator is now stale by construction and its close is epoch-dropped, so this line is
      // the authoritative raw-liveness edge for the no-nc window until the new watcher seeds true.
      this.emit("transport", { connected: false } satisfies TransportState);
      this.emit("connection", { connected: false });
      await this.closeWithoutLibraryReconnect(oldNc);
      // stop() can arrive while the old epoch closes. Do not start another authentication
      // handshake after it: a terminal credential may already have expired in that window.
      // Keep old-epoch and late-epoch close failures outside this dial-only catch.
      if (this.stopped) return;
      try {
        await this.connectAndBind();
      } catch (error) {
        if (!this.stopped) throw error;
      }
      // stop() may have run during the await — don't leave a live connection + heartbeat +
      // supervisor on a stopped endpoint. (Reads this.nc in its own scope — a bare `this.nc`
      // here in doRebuild narrows to `never` via TS inlining connectAndBind's assignment.)
      // Re-arm on the fresh nc only after this stopped fence accepts it.
      if (await this.tearDownIfStopped()) return;
      this.superviseConnection();
    } finally {
      this.reconnecting = false;
    }
  }

  /** The ceiling {@link nextRetryDelayMs} grows to. A failure that outlives a couple of retries is
   *  a standing one (a down broker, a credential nothing can renew), and retrying it every few
   *  seconds forever is what turns one stuck client into a permanent flat load on the broker and its
   *  auth callout. */
  private static readonly RETRY_BACKOFF_CAP_MS = 60_000;

  /** The wait before the next rebuild attempt: {@link retryMs}, doubling per consecutive failure up
   *  to {@link RETRY_BACKOFF_CAP_MS}, then a random half of it taken off. A transient drop still
   *  recovers within retryMs, and endpoints refused together, as a broker restart or an auth limit
   *  refuses a host's agents, spread their retries instead of arriving at the callout at once. */
  private nextRetryDelayMs(): number {
    const delay = Math.min(this.retryMs * 2 ** this.retryAttempt, CotalEndpoint.RETRY_BACKOFF_CAP_MS);
    this.retryAttempt++;
    return Math.round(delay / 2 + Math.random() * (delay / 2));
  }

  /** Rebuild with backoff until it sticks or we're stopped. Interruptible: a manual
   *  {@link reconnect} kicks the backoff so the next attempt runs immediately instead of
   *  awaiting the full delay. One loop at a time ({@link reestablishing}); concurrent
   *  triggers coalesce via {@link rebuild}. */
  private async reestablishLoop(): Promise<void> {
    if (this.reestablishing) return;
    this.reestablishing = true;
    try {
      while (!this.stopped) {
        try {
          await this.rebuild();
          this.retryAttempt = 0; // reconnected — the next drop starts from retryMs again
          return; // success — re-armed; the supervisor re-triggers on the next terminal close
        } catch (e) {
          const delay = this.nextRetryDelayMs();
          // The broker never says why the auth callout refused a bearer, so a user-mode refusal is
          // named as one, with where the reason is, and paced like any other failure.
          if (!this.stopped && !(e instanceof RepeatedRefusal))
            this.emitRecoverable(this.userMode && isAuthRejection(e)
              ? new Error(`the broker refused this endpoint's bearer for ${this.owner}.${this.actor} - retrying in ${Math.ceil(delay / 1000)}s; the space's auth service logs why`, { cause: e })
              : e as Error);
          // A warning listener may stop the endpoint. A backoff armed after that holds the process
          // open for the whole delay, because the stop has already kicked the backoff it saw.
          if (this.stopped) return;
          await new Promise<void>((resolve) => {
            this.backoffResolve = resolve;
            this.backoffTimer = setTimeout(resolve, delay);
          });
        }
      }
    } finally {
      this.reestablishing = false;
    }
  }

  /** Run the next rebuild attempt now if the endpoint is waiting out a {@link reestablishLoop}
   *  backoff, for a caller with work waiting on the link. After a long outage that backoff can run
   *  for up to a minute past the broker's return, and a send made in it waited for an attempt
   *  nobody had scheduled (#7408). Idle endpoints keep their spread-out retries. A no-op otherwise:
   *  a rebuild in flight is already the attempt, and a link nats.js is still reconnecting keeps
   *  its buffered publishes. */
  retryNow(): void {
    if (!this.stopped && this.reestablishing && !this.rebuildPromise) this.kickBackoff();
  }

  /** Cut an in-flight reestablish backoff short so the next attempt runs immediately, and
   *  clear its timer so it can't fire later on a stopped/restarted loop. */
  private kickBackoff(): void {
    this.backoffResolve?.();
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = undefined;
    }
  }

  /** Capped exponential pause between membership retries. stop() ends it early, so a loop waiting
   *  on an absent delivery daemon never holds a stopped endpoint's process open for the delay. */
  private membershipPause(attempt: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const wake = (): void => {
        clearTimeout(timer);
        this.membershipPauses.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, Math.min(30_000, 1000 * 2 ** attempt));
      this.membershipPauses.add(wake);
    });
  }

  /** Manual reconnect: tear down the current connection and rebuild, WITHOUT the permanent
   *  stop (stopped/stopping stay false). Serialized with the self-heal supervisor via
   *  {@link rebuild}, and interruptible — if a backoff is in flight, kick it so the attempt
   *  is now, not in retryMs. Throws if stopped. On failure, leaves {@link reestablishLoop}
   *  running in the background so the endpoint never stays dead, and rethrows so the caller
   *  can report it. */
  async reconnect(): Promise<void> {
    if (this.stopped) throw new Error("endpoint stopped - cannot reconnect");
    this.kickBackoff();
    try {
      await this.rebuild();
    } catch (e) {
      void this.reestablishLoop(); // background retry until success or stop
      throw e;
    }
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
   *  (see {@link startPresenceWatch}). */
  stop(): Promise<void> {
    return this.stopPromise ??= this.stopOnce();
  }

  private async stopOnce(): Promise<void> {
    if (this.nc) this.disableLibraryReconnect(this.nc);
    this.stopped = true;
    for (const follower of this.activeGoalFollowers) {
      follower.cancel();
    }
    this.activeGoalFollowers.clear();
    this.presenceEpoch++;
    // Every principal serve ends now, so a `ready` still waiting for the broker rejects and no new
    // request is taken. Its handlers in flight finish below, before the connection they reply on
    // closes, or their requests' deadlines pass.
    const principalStops = [...this.principalServes.values()].map((intent) => this.stopPrincipalServe(intent, false));
    this.presence.cancelRebind();
    // Wake a reestablishLoop sitting in backoff so it sees `stopped` and exits instead of
    // sleeping out retryMs; also clears the timer so it can't fire later.
    this.kickBackoff();
    for (const wake of [...this.membershipPauses]) wake();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.cancelBearerRenewal?.();
    if (this.credsTimer) clearTimeout(this.credsTimer);
    if (this.authExpiryReconnectTimer) clearTimeout(this.authExpiryReconnectTimer);
    for (const watch of this.membershipFeedWatches) {
      watch.stopped = true;
      watch.arm = watch.arm.catch(() => {}).then(async () => {
        await this.disarmMembershipWatch(watch);
        await this.deleteRetainedMembershipConsumer(watch);
      });
    }
    // Permanent endpoint shutdown has no future epoch. Try strict cleanup on the current live epoch;
    // if the broker is already gone, terminate local ownership rather than hanging shutdown forever.
    await Promise.all([...this.membershipFeedWatches].map((watch) => watch.arm.catch((err) => {
      if (this.nc && !this.nc.isClosed()) throw err;
    })));
    for (const watch of this.membershipFeedWatches) {
      watch.resolveStop?.();
      watch.resolveStop = undefined;
      watch.rejectStop = undefined;
    }
    this.membershipFeedWatches.clear();
    for (const msgs of this.streamMsgs) {
      try {
        msgs.stop();
      } catch {
        /* already closed */
      }
    }
    this.presence.retireWatch();
    if (this.channelWatchIter) this.retireKvWatch(this.channelWatchIter);
    this.channelWatchIter = undefined;
    this.stopDeliveryLeaseWatch();
    await Promise.all(principalStops);
    try {
      if (this.doRegister) {
        await this.presence.publishOffline();
      }
    } catch {
      /* best-effort graceful leave */
    }
    await Promise.all([this.settleDeliveryLeaseWatches(), this.settleKvWatches()]);
    // DM-only: the pull above is stopped, so no new copy reaches the handler. Let a running handler
    // settle while the connection is still open, so its ack can reach the broker; close either way.
    let dmOnlyUnsettled = false;
    if (this.dmOnly && this.dmOnlyInFlight) {
      const settleMs = this.dmOnly.settleTimeoutMs ?? 30_000;
      dmOnlyUnsettled = await withDeadline(this.dmOnlyInFlight.then(() => false), settleMs, () => new Error("unsettled"))
        .catch(() => true);
    }
    await this.closeWithoutLibraryReconnect(this.nc);
    // #1356: stop() does its own teardown and never runs clearConnectionScoped, so clear here too —
    // AFTER the best-effort offline publish above, which would otherwise re-record a refusal on its
    // way out. A stopped endpoint has no live basis for "this bucket is refusing writes", and the
    // duration is computed from `Date.now()`, so a retained record does not merely go stale: it keeps
    // COUNTING UP for as long as the dead object is held.
    this.clearPresenceWriteFailure();
    // Custody callers must not observe stop completion while a concurrent rebind can still
    // publish a late consuming connection. doRebuild closes its stopped epoch before resolving.
    await this.rebuildPromise;
    await this.startPromise;
    if ([...this.ownedConnections].some((nc) => !nc.isClosed()))
      throw new Error("endpoint stop could not prove its connection closed; local consumer custody must be retained");
    if (dmOnlyUnsettled)
      throw new Error(`endpoint stop closed the connection but the DM-only handler did not settle within ${this.dmOnly?.settleTimeoutMs ?? 30_000}ms; its copy stays unacked and handler custody must be retained`);
  }

  /** The native binding of every connection this endpoint holds. A host compares the list with a
   *  complete native census of the account to show that no other connection uses it. The list
   *  proves neither liveness nor the absence of other connections. A stopped endpoint whose
   *  connections all closed reports none. It throws while there is no settled answer: before
   *  start, during a start, rebuild or stop, while a credential transaction or its connection swap
   *  is pending, and while the connection is down or redialing. */
  nativeConnections(): NativeConnectionBinding[] {
    const unsettled = (why: string) => new Error(`endpoint connection inventory is unsettled: ${why}`);
    if (this.startPromise !== undefined || this.rebuildPromise !== undefined || this.reconnecting)
      throw unsettled("a start or rebuild is in flight");
    const open = [...this.ownedConnections].filter((nc) => !nc.isClosed());
    if (this.stopped) {
      if (open.length > 0) throw unsettled("the endpoint stopped but a connection has not closed");
      return [];
    }
    if (this.credsTxnsRunning > 0 || this.residentSwap !== undefined)
      throw unsettled("a credential adoption is in flight");
    if (!this.nc || !this.nativeBound) throw unsettled("the connection is down or redialing");
    return open.map((nc) => nativeConnectionBinding(nc, "endpoint connection"));
  }

  // ---- messaging -----------------------------------------------------------

  /** The messaging verbs of this endpoint: multicast, unicast, anycast and the event-payload
   *  channel. Every dependency is read when it is used, so a field assigned after construction is seen. */
  private readonly messaging = new EndpointMessaging({
    nc: () => this.nc,
    js: () => this.js,
    jsm: () => this.jsm,
    space: () => this.space,
    owner: () => this.owner,
    actor: () => this.actor,
    channels: () => this.channels,
    notLiveMsg: () => this.notLiveMsg(),
    ref: () => this.ref(),
    publishMsg: (subject, msg) => this.publishMsg(subject, msg),
    streamHistory: (...args) => this.streamHistory(...args),
    emitRecoverable: (err) => this.emitRecoverable(err),
  });

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
   *  Any other frame reaches the handler as decoded. An exception from the handler is emitted as
   *  `error`, and the feed keeps reading (#7060). */
  tap(
    handler: (subject: string, msg: CotalMessage | undefined) => void,
    opts?: { subject?: string },
  ): void {
    const tap = { handler, subject: opts?.subject ?? spaceWildcard(this.space) };
    this.taps.push(tap);
    this.bindTap(tap);
  }

  /** Subscribe one {@link tap} on the current connection; with none, the next bind subscribes it. */
  private bindTap(tap: (typeof this.taps)[number]): void {
    if (!this.nc) return;
    const sub = this.nc.subscribe(tap.subject);
    this.subs.push(sub);
    void (async () => {
      for await (const m of sub) {
        let decoded: CotalMessage | undefined;
        try {
          decoded = m.json<CotalMessage>();
        } catch {
          decoded = undefined;
        }
        const parsed = parseSubject(m.subject);
        if (decoded !== undefined && (parsed?.kind === "chat" || parsed?.kind === "evp" || parsed?.kind === "inst" || parsed?.kind === "svc")) {
          if (!isFromSubjectSender(decoded, parsed)) continue;
          // A message whose parts cannot be read is dropped, as history drops it (#7060).
          if (parsed.kind !== "evp" && (!Array.isArray(decoded.parts) || !decoded.parts.every(isReadableMessagePart))) continue;
          decoded = authenticatedMessage(decoded, parsed);
        }
        // A handler that throws is reported and the feed goes on. Leaving this loop would stop every
        // later frame while the process keeps running (#7060).
        try {
          tap.handler(m.subject, decoded);
        } catch (e) {
          this.emit("error", e as Error);
        }
      }
    })().catch((e) => this.emit("error", e as Error));
  }

  // ---- control plane (request/reply) --------------------------------------

  /** The control plane and the service-invocation client of this endpoint. Every dependency is
   *  read when it is used, so a field assigned after construction is seen. */
  private readonly controlPlane = new EndpointControlPlane({
    nc: () => this.nc,
    space: () => this.space,
    owner: () => this.owner,
    actor: () => this.actor,
    stopped: () => this.stopped,
    authed: () => this.authed,
    connId: () => this.connId,
    presentedExp: () => this.presentedExp,
    issuedGeneration: () => this.issuedGeneration,
    acceptedToken: () => this.acceptedToken,
    rebuildPromise: () => this.rebuildPromise,
    subs: () => this.subs,
    resolvedServices: () => this.resolvedServices,
    resolvedCommandServices: () => this.resolvedCommandServices,
    serviceInvocations: () => this.serviceInvocations,
    requestsAwaitingReply: () => this.requestsAwaitingReply,
    activeGoalFollowers: () => this.activeGoalFollowers,
    splitsRecovered: () => this.splitsRecovered,
    setSplitsRecovered: (count) => { this.splitsRecovered = count; },
    notLiveMsg: () => this.notLiveMsg(),
    requireLifecycleUid: (what) => this.requireLifecycleUid(what),
    reportSubscriptionDenial: (error) => this.reportSubscriptionDenial(error),
    ref: () => this.ref(),
    reconnect: () => this.reconnect(),
    emit: (event, ...args) => this.emit(event, ...args),
  });

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

  /** Forwards to the control plane's {@link EndpointControlPlane.requestBoundReply}. */
  private async requestBoundReply(nc: NatsConnection, subject: string, body: string, reply: string, timeoutMs: number): Promise<Msg> {
    return this.controlPlane.requestBoundReply(nc, subject, body, reply, timeoutMs);
  }

  /** Send a control request to a service and await its reply (client side). Like {@link requestDelivery},
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

  /** Send a durable-membership request to the SERVER-SIDE delivery daemon (`ctl.delivery`) and await its
   *  reply. The reply rides a subject UNDER `ctl.delivery.<id>.>` (not the per-id `_INBOX`), so the
   *  scoped delivery cred can answer without broad inbox-publish — see
   *  CONTROL_DELIVERY. `noMux` lets us name the reply subject while keeping NoResponders detection (so a
   *  caller can fail-closed vs. degrade to live-only when no daemon is present). */
  private async requestDelivery(op: string, args: Record<string, unknown>, timeoutMs = 5000): Promise<ControlReply> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    const reqSubject = controlServiceSubject(this.space, CONTROL_DELIVERY, this.owner, this.actor); // ctl.delivery.<owner>.<actor>
    // Reply rides the sender's OWN subtree so the daemon's serveControl boundReply guard accepts it
    // (`${reqSubject}.reply.…`). The sender-bound guard is the COMPLETE confused-deputy closure. The
    // random suffix is genuine defense-in-depth (NOT cosmetic): `noMux` subscribes this SPECIFIC named
    // reply subject (not a standing `.reply.>` wildcard), so a predictable suffix would let a peer target
    // an in-flight reply subscription — randomUUID brings it to parity with the nuid-protected `_INBOX`
    // model. Keep both; don't regress to a counter. (Confirmed by the review panel's fact-check.)
    const reply = `${reqSubject}.reply.${randomUUID()}`;
    const body: ControlRequest = { op, args, from: this.ref() };
    const m = await this.requestBoundReply(this.nc, reqSubject, JSON.stringify(body), reply, timeoutMs);
    return m.json<ControlReply>();
  }

  /** Send a PRIVILEGED delivery-admin request to the server-side delivery daemon and await its reply
   *  (the D5 rail-split: `reloadCreds` now, the eviction executor next). Same bounded-reply shape as
   *  {@link requestDelivery}; the cred layer is the real gate — only the manager's supervisor profile
   *  holds the request-publish grant, so an agent calling this gets a broker denial, not a handler
   *  refusal. NoResponders (no daemon) surfaces as the thrown request error — callers decide whether
   *  that degrades (renewal falls back to the daemon's 75% re-read backstop) or fails. */
  async requestDeliveryAdmin(op: string, args: Record<string, unknown>, timeoutMs = 5000): Promise<ControlReply> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    const reqSubject = controlServiceSubject(this.space, CONTROL_DELIVERY_ADMIN, this.owner, this.actor);
    const reply = `${reqSubject}.reply.${randomUUID()}`;
    const body: ControlRequest = { op, args, from: this.ref() };
    const m = await this.requestBoundReply(this.nc, reqSubject, JSON.stringify(body), reply, timeoutMs);
    return m.json<ControlReply>();
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
   *  republish presence. For connectors that learn their actual selection only after launch (e.g.
   *  Claude Code's `SessionStart` hook). The mutated card is read live by every later publish, so even
   *  a pre-connect call surfaces on the first presence write. `provider` is the effective provider
   *  the connector reported serving the model; when omitted an existing `meta.provider` is left
   *  untouched (unlike `variant`, it is never deleted, since a caller that does not know the
   *  provider says nothing about whether one still applies). */
  async setCardModel(model: string, variant?: string, provider?: string): Promise<void> {
    const m = model.trim();
    const v = variant?.trim();
    const p = provider?.trim();
    if (!m || (this.card.meta?.model === m && this.card.meta.variant === v && (p === undefined || this.card.meta?.provider === p)))
      return;
    const meta: Record<string, unknown> = { ...(this.card.meta ?? {}), model: m };
    if (v) meta.variant = v;
    else delete meta.variant;
    if (p) meta.provider = p;
    this.card.meta = meta;
    await this.publishPresence();
  }

  /** Overlay the session's working directory onto the card's display-only `meta.cwd`, then
   *  republish presence. For connectors that learn the directory from the harness after launch (e.g.
   *  Claude Code's `SessionStart` hook) rather than from their own process. Advisory display data,
   *  never a routing or access input. The pathname is kept byte for byte: a directory name may hold
   *  or end in whitespace, so it is never trimmed or normalized. An empty string names no directory
   *  and leaves the card unchanged. */
  async setCardCwd(cwd: string): Promise<void> {
    if (!cwd || this.card.meta?.cwd === cwd) return;
    this.card.meta = { ...(this.card.meta ?? {}), cwd };
    await this.publishPresence();
  }

  // ---- channel discovery ---------------------------------------------------

  /** A consumer that reads presence on demand reads the channel registry on demand too: it holds no
   *  watch on either, so a seat binds no consumer per member on these buckets (SPEC §6, §7). */
  private get readsChannelsOnDemand(): boolean {
    return this.doConsume && this.doWatchChannels && !this.doWatch;
  }

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
    if (!this.readsChannelsOnDemand)
      throw new Error("readChannels is for a consumer that reads presence on demand; this endpoint watches the channel registry or keeps no cache of it");
    const kv = this.channelKv;
    if (!kv) throw new Error(this.notLiveMsg());
    if (this.channelRead) return this.channelRead;
    const generation = ++this.channelReadGeneration;
    const read = (async () => {
      let entries: KvEntry[];
      try {
        entries = await lastKvEntries(kv);
      } catch (e) {
        if (!isPublishPermissionDenied(e)) throw e;
        throw new Error(
          `channel registry read refused for ${this.card.id}: this credential may not publish $JS.API.DIRECT.GET.KV_${channelBucket(this.space)}, the on-demand registry read (SPEC Appendix B). A credential minted by an older issuer can lack this grant even when newly minted; upgrade the manager or auth service that issues credentials, then mint a new credential. Reusing credentials or reconnecting does not add the grant.`,
          { cause: e },
        );
      }
      if (generation <= this.channelReadApplied) return;
      this.channelReadApplied = generation;
      this.channelConfigs.clear();
      this.channelDefaults = {};
      for (const e of entries) this.handleChannelEntry(e);
    })();
    this.channelRead = read;
    const settled = () => { if (this.channelRead === read) this.channelRead = undefined; };
    read.then(settled, settled);
    return read;
  }

  /** This channel's registry config from the local cache (undefined if unset). */
  getChannelConfig(channel: string): ChannelConfig | undefined {
    return this.channelConfigs.get(channel);
  }

  /** Effective replay-on-join policy for a channel: per-channel override ?? space default ??
   *  true. Reads the live cache, so it reflects runtime registry edits. */
  channelReplay(channel: string): boolean {
    return effectiveReplay(this.channelConfigs.get(channel), this.channelDefaults);
  }

  /** Effective replay window for a channel (per-channel override ?? space default), or undefined
   * for the full retained window. Only meaningful when {@link channelReplay} is true. */
  channelReplayWindow(channel: string): string | undefined {
    return this.channelConfigs.get(channel)?.replayWindow ?? this.channelDefaults.replayWindow;
  }

  /** A channel's effective replay policy read straight from the registry bucket, for a caller that
   *  reads it right after start, before any watch cache has caught up, or that watches nothing. A
   *  wildcard reads the space defaults only. A space with no registry bucket has the built-in policy.
   *  `registered` says whether the channel has its own registry entry. */
  async channelReplayPolicy(channel: string): Promise<{ replay: boolean; window: string | null; registered: boolean }> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    const kv = this.channelKv ?? (await openChannelRegistry(this.nc, this.space, { create: false }));
    let cfg: ChannelConfig | undefined;
    let defaults: ChannelDefaults | undefined;
    try {
      [cfg, defaults] = await Promise.all([
        isConcreteChannel(channel) ? readChannelConfig(kv, channel) : Promise.resolve(undefined),
        readChannelDefaults(kv),
      ]);
    } catch (e) {
      // `open` binds lazily, so a space with no registry bucket surfaces on the first read.
      if (!isJetStreamMissing(e, JetStreamApiCodes.StreamNotFound)) throw e;
    }
    return { replay: effectiveReplay(cfg, defaults), window: cfg?.replayWindow ?? defaults?.replayWindow ?? null, registered: cfg !== undefined };
  }

  /** Effective delivery class for a channel (per-channel override ?? space default ?? "durable"),
   *  from the live watch cache — drives the non-gating delivery-health surface (only durable-class
   *  channels have a Plane-3 backstop to report on). */
  channelDeliveryClass(channel: string): DeliveryClass {
    return effectiveDeliveryClass(this.channelConfigs.get(channel), this.channelDefaults);
  }

  // ---- dynamic subscription (join / leave mid-session) ---------------------

  /** Join, leave and channel listing, and the membership feed watches, of this endpoint. Every
   *  dependency is read when it is used, so a field assigned after construction is seen. */
  private readonly subscriptions = new EndpointSubscriptions({
    nc: () => this.nc,
    jsm: () => this.jsm,
    space: () => this.space,
    card: () => this.card,
    stopped: () => this.stopped,
    authed: () => this.authed,
    channels: () => this.channels,
    channelConfigs: () => this.channelConfigs,
    channelDefaults: () => this.channelDefaults,
    chatSubDenied: () => this.chatSubDenied,
    plane3Channels: () => this.plane3Channels,
    readsChannelsOnDemand: () => this.readsChannelsOnDemand,
    membershipFeedKv: () => this.membershipFeedKv,
    setMembershipFeedKv: (kv) => { this.membershipFeedKv = kv; },
    membershipFeedWatches: () => this.membershipFeedWatches,
    watchDeletePermissions: () => this.watchDeletePermissions,
    notLiveMsg: () => this.notLiveMsg(),
    readChannels: () => this.readChannels(),
    armJoin: (channels) => this.armJoin(channels),
    backfillArmed: (frontiers, floorSeq) => this.backfillArmed(frontiers, floorSeq),
    subscribeChat: (channel) => this.subscribeChat(channel),
    unsubscribeChat: (channel) => this.unsubscribeChat(channel),
    confirmChatSub: () => this.confirmChatSub(),
    durableJoinChannel: (channel) => this.durableJoinChannel(channel),
    durableLeaveChannel: (...args) => this.durableLeaveChannel(...args),
    fetchMemberships: (channel) => this.fetchMemberships(channel),
    recordOwnWatchConsumer: (info) => this.recordOwnWatchConsumer(info),
    watchConsumerDeleteDenied: (stream, name, owner) => this.watchConsumerDeleteDenied(stream, name, owner),
    deleteMembershipConsumer: (jsm, stream, name) => this.deleteMembershipConsumer(jsm, stream, name),
    emit: (event, ...args) => this.emit(event, ...args),
  });

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
    const members = (await listMembers(await this.membersRegistry())).filter(
      (r) => r.leaveCursor === undefined && r.activated === true,
    );
    const byId = new Map<string, Presence>();
    for (const p of this.presence.values()) byId.set(p.card.id, p);
    const memberForId = (id: string): ChannelMember => {
      const p = byId.get(id);
      return p
        ? { id: p.card.id, name: p.card.name, role: p.card.role, live: p.status !== "offline" }
        : { id, name: id, live: false };
    };
    const byName = (a: ChannelMember, b: ChannelMember) => a.name.localeCompare(b.name);

    if (channel !== undefined) {
      const stored = (await this.deliveryClassFresh(channel)) === "durable";
      const ids = new Set(
        members
          .filter((r) => r.channel === channel || (stored && isChannelFamily(r.channel) && subjectMatches(r.channel, channel)))
          .map((r) => r.owner),
      );
      return [...ids].map(memberForId).sort(byName);
    }

    const map = new Map<string, ChannelMember[]>();
    for (const r of members) {
      const arr = map.get(r.channel);
      const m = memberForId(r.owner);
      if (arr) {
        if (!arr.some((x) => x.id === m.id)) arr.push(m);
      } else {
        map.set(r.channel, [m]);
      }
    }
    for (const arr of map.values()) arr.sort(byName);
    return map;
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

  /** Forwards to the subscriptions component's {@link EndpointSubscriptions.deleteRetainedMembershipConsumer}. */
  private async deleteRetainedMembershipConsumer(watch: MembershipFeedWatch): Promise<void> {
    return this.subscriptions.deleteRetainedMembershipConsumer(watch);
  }

  /** Record the consumer behind one of this connection's own KV watches or membership scans, and
   *  return the delete-subject prefix it recorded. nats.js names it `<prefix>_<serial>` and,
   *  rebuilding it after a stall or a sequence gap, deletes the predecessor itself with no hook before
   *  the send, so a profile without the delete row (#691) has that delete refused. A stalled link can
   *  time that delete out before its refusal arrives, and nats.js then hands the refusal to no request,
   *  so {@link trackRequestDenials} cannot own it and the consumer's name has to. A watch's prefix
   *  stays recorded for the connection because a retired watch's last rebuild can be refused after
   *  the watch has stopped; {@link readMembership} retires its scan's after its own last delete,
   *  which goes out once nats.js has stopped the consumer and so is answered after every predecessor
   *  delete. */
  private recordOwnWatchConsumer({ stream_name, name }: ConsumerInfo): string {
    const prefix = `$JS.API.CONSUMER.DELETE.${stream_name}.${name.slice(0, name.lastIndexOf("_") + 1)}`;
    this.ownWatchDeletePrefixes.add(prefix);
    return prefix;
  }

  /** Whether `subject` deletes `<prefix>_<serial>` of a consumer {@link recordOwnWatchConsumer} recorded. */
  private isOwnWatchDelete(subject: string): boolean {
    const cut = subject.lastIndexOf("_") + 1;
    return /^\d+$/.test(subject.slice(cut)) && this.ownWatchDeletePrefixes.has(subject.slice(0, cut));
  }

  /** Skip only a delete the authenticated connection's well-formed publish claims exclude.
   *  This is request avoidance, not authority: the broker still enforces every request we send. */
  private watchConsumerDeleteDenied(stream: string, name: string, owner: object | undefined): boolean {
    const permission = owner && this.watchDeletePermissions.get(owner)?.();
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

  /** Forwards to the subscriptions component's {@link EndpointSubscriptions.disarmMembershipWatch}. */
  private async disarmMembershipWatch(watch: MembershipFeedWatch): Promise<void> {
    return this.subscriptions.disarmMembershipWatch(watch);
  }

  /** Forwards to the subscriptions component's {@link EndpointSubscriptions.rearmMembershipWatches}. */
  private async rearmMembershipWatches(): Promise<void> {
    return this.subscriptions.rearmMembershipWatches();
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
    opts?: { limit?: number; signal?: AbortSignal },
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
  async dmHistoryOf(principals: readonly string[], opts?: { limit?: number; signal?: AbortSignal }): Promise<DmHistoryRead> {
    const keys = [...new Set(principals)].map((p) => {
      const key = parsePrincipalKey(p);
      if (!key) throw new Error(`dmHistoryOf: "${p}" is not a principal <owner>.<actor>`);
      return key;
    });
    if (!keys.length) return { state: "read", items: [] };
    const limit = opts?.limit ?? 100;
    const read = (subjects: string[]) => this.streamHistory(dmStream(this.space), subjects, limit, undefined, opts?.signal);
    let rows: { seq: number; msg: HistoryMessage }[];
    try {
      // A consumer refuses overlapping filters, and a DM between two of these principals matches a
      // recipient filter and a sender filter, so each direction is its own read.
      rows = (await Promise.all([
        read(keys.map((k) => unicastRecvFilter(this.space, k.owner, k.actor))),
        read(keys.map((k) => unicastSubject(this.space, "*", "*", k.owner, k.actor))),
      ])).flat();
    } catch (e) {
      if (isPermissionDenied(e)) return { state: "denied", reason: (e as Error).message };
      throw e;
    }
    const bySeq = new Map(rows.map((r) => [r.seq, r.msg]));
    return { state: "read", items: [...bySeq].sort(([a], [b]) => a - b).slice(-limit).map(([, msg]) => msg) };
  }

  /**
   * The `limit` MOST RECENT messages matching `subject`, oldest-first within the page.
   *
   * **This used to return the OLDEST N.** `js.consumers.get(stream, {...})` builds an ORDERED
   * consumer, which defaults to `DeliverPolicy.StartSequence` with `opt_start_seq: 1` — the very
   * beginning of the stream. Capping the fetch at `limit` therefore took the first N messages ever
   * sent, while this method is documented as "recent" and every caller (the dashboard feed, the
   * agent-facing history tools) presents the result as the latest. Confirmed live against a
   * 123-message channel: `limit=10` returned the ten oldest, not the ten newest.
   *
   * Fixing it by draining from the start and keeping the tail would be correct and ruinous: it
   * transfers the entire backlog to show one screen. Instead, find the newest matching sequence and
   * consume a WINDOW ending there, widening geometrically until the window holds `limit` matches.
   * A filtered subject's sequences are non-contiguous (other channels interleave in the same
   * stream), so the window cannot be computed arithmetically. A FAILED attempt holds fewer than a
   * page by definition, so wasted transfer stays page-sized and geometric growth keeps the number of
   * attempts logarithmic. A channel with fewer than `limit` matches used to keep widening until
   * sequence 1 and drain the stream's whole retained set (#840). The walk now stops at the
   * subject's FIRST matching sequence (the mirror of the last-matching ceiling), probed on the
   * same CREATE surface, and only after a short drain so a dense page never pays for the floor.
   *
   * `before` pages toward the past: pass the `seq` of the oldest message you already have.
   */
  private async streamHistory(
    stream: string,
    subjects: string[],
    limit: number,
    before?: number,
    signal?: AbortSignal,
  ): Promise<{ seq: number; subject: string; msg: HistoryMessage }[]> {
    return this.history.streamHistory(stream, subjects, limit, before, signal);
  }

  // ---- internals -----------------------------------------------------------

  /**
   * Surface the connection's async status errors on our `error` event. NATS reports
   * publish permission violations *only* here (subscription ones too), never on the
   * failing call — so without this an over-tight ACL silently drops the agent's
   * traffic and it just looks "absent". A denied request is the exception: nats.js also
   * rejects that request with the denial, so its caller owns it (see {@link trackRequestDenials}).
   * So is a refused channel subscription, whose callback owns it (see {@link subscribeChat}).
   * We annotate permission denials explicitly so a denial is never mistaken for absence
   * (which already has a benign cause: MCP reconnect).
   */
  private watchStatus(): void {
    const nc = this.nc;
    if (!nc) return;
    const handedToRequest = this.trackRequestDenials(nc);
    void (async () => {
      for await (const s of nc.status()) {
        // A rebuild can replace `this.nc` before the old iterator finishes. Late disconnect/close
        // from that old epoch says nothing about the replacement and must not flip its liveness.
        if (this.nc !== nc) continue;
        // A requested reconnect is reported before the socket closes and `disconnect` follows.
        if (nativeBindingAfter(s.type) === false) this.nativeBound = false;
        if (s.type === "disconnect") {
          this.emit("transport", { connected: false, server: s.server } satisfies TransportState);
          continue;
        }
        if (s.type === "reconnect") {
          this.armAuthExpiryReconnectFence(nc);
          // The library re-subscribed on a connection the broker authorized again: re-run the check.
          this.rebindPrincipalServes(true);
          this.emit("transport", { connected: true, server: s.server } satisfies TransportState);
          for (const follower of this.activeGoalFollowers) {
            follower.reconnected(nc);
          }
          continue;
        }
        if (s.type === "close") {
          this.emit("transport", { connected: false } satisfies TransportState);
          continue;
        }
        if (s.type !== "error") continue;
        if (s.error instanceof PermissionViolationError && this.chatSubRefusals.has(s.error)) continue;
        // A refused principal-route request publish or subscription belongs to the call that throws
        // it or the serve that ends on it (SPEC 13.21). A refused reply publish has no owner, so it
        // is reported below.
        if (s.error instanceof PermissionViolationError && this.ownedPrincipalRouteRefusal(s.error)) continue;
        if (s.error instanceof PermissionViolationError && handedToRequest.has(s.error)) continue;
        // The predecessor nats.js deleted while rebuilding one of this connection's watches, scans or
        // history reads, whose refusal can arrive after that delete timed out.
        if (s.error instanceof PermissionViolationError && s.error.operation === "publish"
          && this.isOwnWatchDelete(s.error.subject))
          continue;
        if (!this.reportSubscriptionDenial(s.error)) this.emit("error", describeStatusError(s.error));
      }
    })().catch((e) => {
      // Defensive symmetry with the reachable in-loop epoch guard above. Measured against five real
      // broker loss/reconnect/terminal-close cycles on pinned nats.js 3.4.0: status iterators ended
      // normally and this catch never fired. Keep an old epoch from surfacing an error if a runtime or
      // future client version can reject here, but do not treat this as a currently reachable edge.
      if (!this.stopped && this.nc === nc) this.emit("error", e as Error);
    });
    // The transport is already live when connect() returns, while the Cotal bind below is still in
    // progress. Seed this contract explicitly rather than requiring consumers to combine it with the
    // later, differently-scoped `connection:true` event.
    //
    // The same stopped race as the readiness emit at the end of connectAndBind, and it reaches here
    // FIRST: connectAndBind calls watchStatus right after the dial, so a stop() landing while the
    // dial is still pending has this seed fire on an endpoint that is already stopped. Measured
    // through a real pending dial, a stopped endpoint announced a live transport it never had.
    if (this.stopped) return;
    this.emit("transport", { connected: true, server: nc.getServer() } satisfies TransportState);
  }

  /** Report a subscription denial once by error identity, whichever reporting path receives it first. */
  private reportSubscriptionDenial(error: unknown): boolean {
    if (!(error instanceof PermissionViolationError) || error.operation !== "subscription") return false;
    if (!this.reportedSubRefusals.has(error)) {
      this.reportedSubRefusals.add(error);
      this.emit("error", describeStatusError(error));
    }
    return true;
  }

  /** Wrap `nc.request` to record each publish denial nats.js rejects one of this connection's requests
   *  with, and to keep one class of request off the wire. nats.js rejects the pending request on the
   *  denied subject with the denial and then dispatches that same error instance on the connection
   *  status, so the caller that received it (an empty history read, a refused consumer delete) owns it
   *  and the status loop skips it. nats.js settles the request before it dispatches the status and this
   *  reaction sits directly on the promise it returns, so it runs before the status loop body, which is
   *  further microtasks away behind the status iterator. Any other denial is a different instance and is
   *  not recorded, including one on the same subject and one that arrives after its request timed out.
   *  A refused request inbox is rejected into every pending request but breaks every later one, so it
   *  is not recorded either.
   *
   *  The request that never reaches the broker is a delete of this connection's own watch consumer
   *  whose subject the credential's publish claims exclude (#4123). nats.js rebuilds an ordered
   *  consumer after a stall or a delivery gap by deleting its predecessor itself, with no hook before
   *  the send and the refusal ignored, so the endpoint's own cleanup checks never see it. The claims
   *  that exclude the subject are the same ones {@link watchConsumerDeleteDenied} reads, and unknown
   *  claims still send: the broker remains the authority for every request that leaves. The rejection
   *  handed back is the one a broker refusal produces, so the caller that ignores a refusal ignores
   *  this one and the status loop treats it as a refusal it already owns. */
  private trackRequestDenials(nc: NatsConnection): WeakSet<PermissionViolationError> {
    const handed = new WeakSet<PermissionViolationError>();
    const request = nc.request.bind(nc);
    nc.request = (subject, payload, opts) => {
      if (typeof subject === "string" && this.ungrantedOwnWatchDelete(subject)) {
        const violation = new PermissionViolationError(
          `Permissions Violation for Publish to "${subject}"`, "publish", subject,
        );
        handed.add(violation);
        return Promise.reject(new RequestError("permissions violation", { cause: violation }));
      }
      const reply = request(subject, payload, opts);
      reply.catch(({ cause }: Error) => {
        if (cause instanceof PermissionViolationError && cause.operation === "publish") handed.add(cause);
      });
      return reply;
    };
    return handed;
  }

  /** A delete of one of this connection's own recorded watch consumers that its publish claims
   *  exclude. Any other subject, and a delete whose claims are unknown, is sent. */
  private ungrantedOwnWatchDelete(subject: string): boolean {
    if (!this.isOwnWatchDelete(subject)) return false;
    const permission = this.watchDeletePermissions.get(this.nc!)?.();
    return Boolean(permission && !issuedPermitsSubject(permission, subject));
  }

  /** The error message for a guard that finds the endpoint unbound: "reconnecting" during a
   *  rebuild's null window OR an inter-retry backoff (so a concurrent op reports the real
   *  reason, not "not started" — `reestablishing` spans the whole retry loop incl. backoff),
   *  else "endpoint not started" (genuine pre-start). */
  private notLiveMsg(): string {
    return this.reconnecting || this.reestablishing
      ? "reconnecting - try again shortly"
      : "endpoint not started";
  }

  private async publishMsg(subject: string, msg: CotalMessage): Promise<void> {
    if (!this.js) throw new Error(this.notLiveMsg());
    assertPartsSerializable(msg.parts);
    // msgID = message id → free server-side dedup across JetStream redelivery.
    try {
      await this.js.publish(subject, JSON.stringify(msg), { msgID: msg.id });
    } catch (error) {
      if (error instanceof TimeoutError)
        throw new Error(
          `${error.message} publishing to ${JSON.stringify(subject)}. The send outcome is unknown: the broker may have stored the message. Check before resending.`,
          { cause: error },
        );
      throw error;
    }
  }

  /** Create the three backing streams for this space (idempotent). Open-mode lazy create;
   *  the same definitions are used by `cotal up` at privileged setup. */
  private async ensureStreams(): Promise<void> {
    if (!this.jsm) throw new Error(this.notLiveMsg());
    await createSpaceStreams(this.jsm, this.space);
  }

  /** Create this open space's message streams if they are not there yet, as a consuming endpoint
   *  does when it starts. For a sender that consumes nothing and may be the space's first
   *  participant (#7045). An authenticated broker's streams come from its setup, and its agents may
   *  not create them, so this throws there. */
  async ensureOpenSpaceStreams(): Promise<void> {
    if (this.authed) throw new Error(`the streams of ${this.space} come from its broker's setup on an authenticated space; a sender does not create them`);
    await createSpaceStreams(await this.manager(), this.space);
  }

  // (v3) The old `provisionMembership` — manager/provisioner-written boot membership at spawn — is GONE.
  // Boot durable membership is now the AGENT self-joining its durable boot channels via the daemon's
  // `ctl.delivery` op at connect ({@link armBootDurableMemberships}), reconciled on outage. The
  // primitive it wrapped, {@link durableJoinFor}, is now driven by the daemon's `ctl.delivery` handler.

  /**
   * Privileged: pre-create an agent's DM inbox durable (auth mode), so the agent can BIND
   * it without holding CONSUMER.CREATE on DM_<space>. The creator sets the filter to
   * inst.<targetId>.* — the agent never gets to choose it, which is what stops a peer from
   * creating a durable filtered to someone else's inbox. Idempotent (byte-identical config),
   * safe to call again on manager restart. The caller must be permissive on DM_<space>.
   */
  async provisionDmInbox(owner: string, actor: string, lifecycleUid: string): Promise<void> {
    await this.ensureDmDurable(owner, actor, lifecycleUid, {});
  }

  /** Idempotent-PER-LIFECYCLE create of a `dm_<o>-<a>-<uid>` durable with its ACTIVATION FRONTIER
   *  (SPEC §8). Info-first: an existing durable (a manager-restart re-provision of the SAME uid, or
   *  the same lifecycle's own restart) is kept as-is, preserving the ORIGINAL frontier — the
   *  activation moment never moves. A fresh lifecycle captures the DM stream's current `last_seq` and
   *  starts delivery at frontier+1, so a same-alias successor inherits none of the predecessor's
   *  pending DMs (its filter is the shared alias subject `inst.>`; the FRONTIER, not the subject, is
   *  the cut).
   *
   *  HONESTY (panel-locked): the no-gap guarantee (a DM published between the capture and the create
   *  lands ABOVE the frontier and is delivered) holds ONLY under ONE provisioner per lifecycle uid —
   *  the manager provisions sequentially, which satisfies it. Under CONCURRENT same-uid provisioners
   *  (a split-brain manager), a higher-frontier winner excludes the loser's N+1..M capture window:
   *  the lost-race branch below keeps the winner's durable unconditionally. No per-uid serialization
   *  or persisted-frontier machinery is added in this slice; concurrent same-uid provisioning is
   *  out-of-contract (at-least-once best-effort). */
  private async ensureDmDurable(
    owner: string,
    actor: string,
    lifecycleUid: string,
    opts: { ackWaitMs?: number; inactiveThresholdMs?: number },
  ): Promise<void> {
    const jsm = await this.manager();
    const stream = dmStream(this.space);
    const name = dmDurable(owner, actor, lifecycleUid);
    try {
      await jsm.consumers.info(stream, name);
      return; // this lifecycle's durable exists — keep its original frontier
    } catch (e) {
      if (!isJetStreamMissing(e, JetStreamApiCodes.ConsumerNotFound)) throw e;
      // Genuinely absent consumer: create it below. A denial is not absence.
    }
    const frontier = (await jsm.streams.info(stream)).state.last_seq;
    try {
      await jsm.consumers.add(stream, dmDurableConfig(this.space, owner, actor, lifecycleUid, { ...opts, activationFrontier: frontier }));
    } catch (e) {
      // A concurrent same-lifecycle provisioner may have won the create with an earlier frontier —
      // if the durable now exists it is authoritative; anything else stays a loud failure.
      try { await jsm.consumers.info(stream, name); return; }
      catch (probeError) {
        // The probe never creates a successful result: it either proves the concurrent winner above,
        // or the original create failure stays authoritative. Preserve a denial from the probe because
        // it names the missing capability more accurately than an unrelated create conflict.
        if (isPermissionDenied(probeError)) throw probeError;
      }
      throw e;
    }
  }

  /**
   * Privileged: pre-create an agent's bind-only Plane-3 DELIVER durable (`dlv_<id>`, filtered to
   * `dlv.<id>`), so the agent can BIND its per-member durable handoff without holding CONSUMER.CREATE
   * on the DLV stream. Same bind-only model as {@link provisionDmInbox}: the creator sets the filter,
   * the agent never does. The trusted reader transfers re-authorized copies onto `dlv.<id>`; the agent
   * acks them via native JetStream (SPEC §8). Idempotent. The caller must be permissive on DLV.
   */
  async provisionDlvInbox(owner: string, actor: string, lifecycleUid: string): Promise<void> {
    const jsm = await this.manager();
    await jsm.consumers.add(dlvStream(this.space), dlvDurableConfig(this.space, owner, actor, lifecycleUid));
  }

  /**
   * Privileged: pre-create a role's shared TASK work-queue durable (auth mode), so agents
   * of that role can BIND it without holding CONSUMER.CREATE on TASK_<space>. The creator
   * sets the filter to svc.<role>.> — agents never choose it, which stops cross-role drain.
   * Idempotent per role. The caller must be permissive on TASK_<space>.
   */
  async provisionTaskQueue(role: string): Promise<void> {
    const jsm = await this.manager();
    await jsm.consumers.add(taskStream(this.space), taskDurableConfig(this.space, role));
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
  private readonly durableBackstop = new EndpointDurableBackstop({
    nc: () => this.nc,
    js: () => this.js,
    jsm: () => this.jsm,
    setJsm: (manager) => { this.jsm = manager; },
    space: () => this.space,
    card: () => this.card,
    authed: () => this.authed,
    channelKv: () => this.channelKv,
    presence: () => this.presence,
    deliveryPlane: () => this.deliveryPlane,
    membersKv: () => this.membersKv,
    setMembersKv: (kv) => { this.membersKv = kv; },
    aclKv: () => this.aclKv,
    setAclKv: (kv) => { this.aclKv = kv; },
    managerLeaseKv: () => this.managerLeaseKv,
    setManagerLeaseKv: (kv) => { this.managerLeaseKv = kv; },
    daemonRenewalLeaseRevision: () => this.daemonRenewalLeaseRevision,
    setDaemonRenewalLeaseRevision: (revision) => { this.daemonRenewalLeaseRevision = revision; },
    notLiveMsg: () => this.notLiveMsg(),
    consumerInfo: (stream, durable) => this.consumerInfo(stream, durable),
    manager: () => this.manager(),
    chatFrontier: () => this.chatFrontier(),
    aclAllows: (owner, lifecycleUid, channel) => this.aclAllows(owner, lifecycleUid, channel),
    catchupCopy: (...args) => this.catchupCopy(...args),
  });

  /** Forwards to the durable backstop's {@link EndpointDurableBackstop.membersRegistry}. */
  private async membersRegistry(): Promise<KV> {
    return this.durableBackstop.membersRegistry();
  }

  /** Forwards to the durable backstop's {@link EndpointDurableBackstop.aclRegistry}. */
  private async aclRegistry(): Promise<KV> {
    return this.durableBackstop.aclRegistry();
  }

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
   *  its connection and {@link connectAndBind} rebinds it onto the fresh one, so a reconnect can
   *  never leave the daemon blind to the row for the rest of its life. The rebind replays the
   *  bucket's current last-per-subject state, so a change that landed during the null window is
   *  delivered on the fresh watch. Resolves a stop handle. */
  async watchDeliveryLease(shardIndex: number, onEvent: (info: DeliveryLeaseInfo | undefined) => void): Promise<() => void> {
    return this.deliveryLease.watchDeliveryLease(shardIndex, onEvent);
  }

  private stopDeliveryLeaseWatch(): void {
    return this.deliveryLease.stopDeliveryLeaseWatch();
  }

  /** Wait for the lease-watch binds still in flight, then for every retired watch's consumer delete.
   *  {@link stop} and a live-epoch rebuild run this before they close the connection those deletes
   *  need (#3966). */
  private async settleDeliveryLeaseWatches(): Promise<void> {
    return this.deliveryLease.settleDeliveryLeaseWatches();
  }

  /** Stop a presence or channel-registry watch and delete its ordered consumer, which the stop
   *  alone leaves on the broker until its five-minute inactive threshold (#3914). A connection
   *  that closed on its own cannot carry the delete, so that consumer is left to the threshold. A
   *  failed delete is a warning: the broker still reaps the consumer, and a rejected {@link stop}
   *  would read as unproved consumer custody. */
  private retireKvWatch(iter: Awaited<ReturnType<KV["watch"]>>): void {
    try { iter.stop(); } catch { /* already closed with its connection */ }
    if (!this.nc || this.nc.isClosed()) return;
    const deleting = this.deleteOwnConsumer(kvWatchConsumer(iter)).catch((e: Error) => this.emitRecoverable(
      new Error(`a retired KV watch consumer was not deleted (${e.message}); the broker reaps it at its inactive threshold`),
    ));
    this.kvWatchDeletes.add(deleting);
    void deleting.then(() => this.kvWatchDeletes.delete(deleting));
  }

  /** Wait for the presence and channel-registry watch binds still in flight, then for every retired
   *  watch's consumer delete. {@link stop} and a live-epoch rebuild run this before they close the
   *  connection those deletes need (#3914). */
  private async settleKvWatches(): Promise<void> {
    await Promise.allSettled(this.kvWatchBinds);
    await Promise.all(this.kvWatchDeletes);
  }

  /** Bind a watch on `kv` for the current epoch and record its consumer as this connection's own.
   *  A bind that {@link stop} or a rebuild overtook retires its late watch, consumer delete
   *  included, and resolves undefined: the epoch that asked for it is gone, and the one that
   *  replaced it binds its own through {@link connectAndBind}. A stopped endpoint binds nothing,
   *  because its teardown may already have settled the flights it waits for. */
  private bindKvWatch(kv: KV): Promise<{ iter: Awaited<ReturnType<KV["watch"]>>; info: ConsumerInfo } | undefined> {
    if (this.stopped) return Promise.resolve(undefined);
    const epoch = this.presenceEpoch;
    const binding = (async () => {
      const permission = this.nc && this.watchDeletePermissions.get(this.nc);
      const iter = await kv.watch();
      const info = await kvWatchConsumer(iter).info(true);
      this.recordOwnWatchConsumer(info);
      if (permission) this.watchDeletePermissions.set(kvWatchConsumer(iter), permission);
      if (epoch === this.presenceEpoch && !this.stopped) return { iter, info };
      this.retireKvWatch(iter);
      return undefined;
    })();
    const settled = () => { this.kvWatchBinds.delete(binding); };
    this.kvWatchBinds.add(binding);
    void binding.then(settled, settled);
    return binding;
  }

  /** Bind the lease watch on the current connection. A bind that lands after a newer watch replaced
   *  its intent, or after a stop or connection teardown moved the epoch, retires its watch instead of
   *  installing it: the epoch it was bound for is gone, and a rebuilt one binds its own. */
  private bindDeliveryLeaseWatch(): Promise<void> {
    return this.deliveryLease.bindDeliveryLeaseWatch();
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

  /** Forwards to the durable backstop's {@link EndpointDurableBackstop.resolveOwnerByName}. */
  private resolveOwnerByName(name: string): string | undefined {
    return this.durableBackstop.resolveOwnerByName(name);
  }

  /** Forwards to the durable backstop's {@link EndpointDurableBackstop.plane3MsgId}. */
  private plane3MsgId(entry: Plane3Entry, keySuffix: string): Partial<JetStreamPublishOptions> {
    return this.durableBackstop.plane3MsgId(entry, keySuffix);
  }

  /** Forwards to the durable backstop's {@link EndpointDurableBackstop.publishDinbox}. */
  private async publishDinbox(principal: string, lifecycleUid: string, entry: Plane3Entry): Promise<void> {
    return this.durableBackstop.publishDinbox(principal, lifecycleUid, entry);
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

  /** Whether one lifecycle's exact ACL row allows a membership on `channel` now (a family must lie
   *  inside one entry, {@link membershipInAllow}). A leader-served read: the handle is opened without
   *  direct reads, so a row narrowed before this read began is the row it returns. */
  private async aclAllows(owner: string, lifecycleUid: string, channel: string): Promise<boolean> {
    const row = await readAcl(await this.aclRegistry(), owner, lifecycleUid);
    return row !== undefined && membershipInAllow(row.record.allowSubscribe, channel);
  }

  /** Privileged durable-LEAVE write: tombstone the membership at `leaveCursor = frontier` so the
   *  backstop denies `seq > leaveCursor` while a pre-leave entry stays deliverable (SPEC §7 interval). */
  async durableLeaveFor(owner: string, channel: string, lifecycleUid: string, expectedGeneration?: number): Promise<void> {
    return this.durableBackstop.durableLeaveFor(owner, channel, lifecycleUid, expectedGeneration);
  }

  /** Idempotently copy the eligible chat messages in `(fromSeqExcl, toSeqIncl]` for `channel` into the
   *  owner inbox, via a DEDICATED per-(owner,join) ephemeral consumer (NOT the agent-scoped
   *  `chathist_<id>`/`histLock` — red-team HIGH-8). It copies what the stream still holds in that
   *  window; a post the history limit removed first is not copied and is not reported (SPEC §4).
   *
   *  A FAMILY row (`review.>`, #5404) reads the window on every channel under it and copies a post only
   *  when that post's own channel is durable-class. Each copy names the post's own channel, never the
   *  family, and it skips nothing another row of the lifecycle covers: two joins can both be pending
   *  when a post lands, so neither proves the other copied it. The per-message, per-lifecycle dedupe id
   *  keeps one copy. */
  private async catchupCopy(
    owner: string, lifecycleUid: string, channel: string, fromSeqExcl: number, toSeqIncl: number, generation: number,
  ): Promise<number> {
    if (!this.js || !this.jsm || toSeqIncl <= fromSeqExcl) return 0;
    const subject = chatSubject(this.space, "*", "*", channel);
    const family = isChannelFamily(channel);
    const durableClass = new Map<string, Promise<boolean>>();
    const stored = (ch: string): Promise<boolean> => {
      if (!family) return Promise.resolve(true);
      let cls = durableClass.get(ch);
      if (cls === undefined) durableClass.set(ch, (cls = this.deliveryClassFresh(ch).then((c) => c === "durable")));
      return cls;
    };
    // Consumer NAME must be JetStream-safe (no `.`) AND collision-free: use the principal DASH-form
    // (`<owner>-<actor>`, `-` reserved as the sole separator), NOT `token(owner)` — `token()` maps the
    // dot-form `.`→`_`, which is NOT collision-free (`_` is legal inside a token, so `a.b_c` and `a_b.c`
    // would both underscore to `a_b_c`). LIFECYCLE-KEYED (SPEC 13.1): generations restart at 1 per
    // lifecycle, so an alias-keyed `cu_<principal>_<gen>` would let a same-alias successor
    // delete/recreate a predecessor's in-flight catch-up consumer — the uid disambiguates.
    const cuP = parsePrincipalKey(owner);
    const name = `cu_${cuP ? lifecycleNameKey(cuP.owner, cuP.actor, lifecycleUid) : `${token(owner)}-${lifecycleUid}`}_${generation}`;
    // A failed read throws, leaving the pending row to retry over the same window.
    await this.deleteConsumerIfPresent(chatStream(this.space), name);
    await this.jsm.consumers.add(chatStream(this.space), {
      name, filter_subject: subject, ack_policy: AckPolicy.None, mem_storage: true,
      inactive_threshold: nanos(30_000), deliver_policy: DeliverPolicy.StartSequence, opt_start_seq: fromSeqExcl + 1,
    });
    let copied = 0;
    try {
      const consumer = await this.js.consumers.get(chatStream(this.space), name);
      let pending = (await consumer.info()).num_pending;
      while (pending > 0) {
        const want = Math.min(pending, 256);
        const iter = await consumer.fetch({ max_messages: want, expires: 5_000 });
        let got = 0;
        for await (const m of iter) {
          got++;
          if (m.seq > toSeqIncl) return copied;
          let msg: CotalMessage;
          try { msg = m.json<CotalMessage>(); } catch { continue; }
          const parsed = parseSubject(m.subject);
          if (!parsed || !isFromSubjectSender(msg, parsed) || msg.from.id === owner) continue;
          if (!(await stored(parsed.rest))) continue;
          await this.publishDinbox(owner, lifecycleUid, {
            msg, channel: parsed.rest, seq: m.seq, reason: "durable-channel", generation, ...(family ? { row: channel } : {}),
          });
          copied++;
        }
        if (got < want) break;
        pending -= got;
      }
    } finally {
      await this.deleteConsumerIfPresent(chatStream(this.space), name);
    }
    return copied;
  }

  /** Start the Plane-3 fan-out writer + trusted reader on THIS (privileged, server-side delivery-daemon)
   *  endpoint, AND serve the `ctl.delivery` control service (runtime durable join/leave/list). `aclFor`
   *  maps an owner id to its current read ACL for the reader's re-authorization — read FRESH per entry
   *  from the durable ACL registry (async). Call once after connect; idempotent durable creation lets it
   *  resume on a daemon restart. Both the JS loops AND the `ctl.delivery` subscription are (re)bound by
   *  {@link armPlane3} on EVERY (re)connect — a reconnect drains the old connection, so re-binding both
   *  is required, not optional (the responder would otherwise be lost on a broker blip). */
  async startPlane3(
    aclFor: (owner: string, lifecycleUid: string) => MaybePromise<string[] | undefined>,
    opts: { reloadMembershipCreds?: (expected?: string) => Promise<unknown>; evictPrincipal?: (principal: string) => Promise<unknown>; evictPrincipals?: (principals: string[]) => Promise<unknown>; planeConnLiveness?: (query: unknown) => Promise<unknown>; principalLiveness?: (principal: string) => Promise<unknown>; reloadStoreIdentity?: () => SecretStoreIdentity; onDeliveryCredsAdopted?: () => void; startupComplete?: () => boolean } = {},
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

  /** Forwards to the delivery plane's {@link EndpointDeliveryPlane.plane3MayAct}. */
  private plane3MayAct(): boolean {
    return this.deliveryPlane.plane3MayAct();
  }

  /** Forwards to the delivery plane's {@link EndpointDeliveryPlane.armPlane3}. */
  private async armPlane3(): Promise<void> {
    return this.deliveryPlane.armPlane3();
  }

  /** Forwards to the delivery plane's {@link EndpointDeliveryPlane.pumpDlv}. */
  private async pumpDlv(): Promise<void> {
    return this.deliveryPlane.pumpDlv();
  }

  /** (Re)bind the anycast take responder and the request records maintenance on the current
   *  connection (SPEC §8.1). The records bucket is created here as well as at space setup, so a mesh
   *  that predates it gets one when its daemon restarts at this version. */
  private async armAnycastRequests(): Promise<void> {
    if (!this.nc || !this.jsm) return;
    this.dropAnycastRequests();
    const definition = anycastStoreDefinition(this.space);
    let kv: KV;
    try {
      kv = await new Kvm(this.nc).create(definition.bucket, definition.createOptions);
    } catch (e) {
      // A credential minted before the records existed cannot open them. That costs the records and
      // nothing else: the rest of Plane-3 still serves, and every anycast op answers with the cause.
      if (!isPermissionDenied(e)) throw e;
      this.anycastUnavailable = ANYCAST_RECORDS_CREDENTIAL_OUTDATED;
      this.emitRecoverable(new Error(`delivery: ${ANYCAST_RECORDS_CREDENTIAL_OUTDATED}`));
      return;
    }
    this.anycastUnavailable = undefined;
    const authority = new AnycastRequestAuthority({
      jsm: this.jsm,
      kv,
      stream: taskStream(this.space),
      send: (to, event) => this.sendAnycastNotice(to, event),
      mayAct: () => this.plane3MayAct(),
      onError: (e) => this.emitRecoverable(e),
    });
    this.anycastAuthority = authority;
    this.takeServeSub = this.serveTakes(authority);
    const sweep = () => void authority.sweep().catch((e) => this.emitRecoverable(e as Error));
    this.anycastSweep = setInterval(sweep, ANYCAST_SWEEP_MS);
    this.anycastSweep.unref?.();
    sweep();
  }

  private dropAnycastRequests(): void {
    if (this.takeServeSub) {
      try { this.takeServeSub.unsubscribe(); } catch { /* dead with the old connection */ }
      const i = this.subs.indexOf(this.takeServeSub);
      if (i >= 0) this.subs.splice(i, 1);
      this.takeServeSub = undefined;
    }
    clearInterval(this.anycastSweep);
    this.anycastSweep = undefined;
    this.anycastAuthority = undefined;
  }

  /** Serve takes on `take.*.*.*`, each in its own time: a take reads one request and writes one row,
   *  and shares nothing with any other take but the row's CAS. The reply is bound to the caller's own
   *  request subtree, as `serveControl`'s `boundReply` binds it. */
  private serveTakes(authority: AnycastRequestAuthority): import("@nats-io/transport-node").Subscription {
    const sub = this.nc!.subscribe(takeServeFilter(this.space), { queue: TAKE_ROUTE });
    this.subs.push(sub);
    void (async () => {
      for await (const m of sub) {
        if (!m.reply || !m.reply.startsWith(`${m.subject}.reply.`)) {
          this.emitRecoverable(new Error(`rejected take on ${m.subject}: reply target "${m.reply ?? "(none)"}" is not under the sender's own reply subtree`));
          continue;
        }
        void this.answerTake(authority, m).catch((e) => this.emitRecoverable(e as Error));
      }
    })().catch((e) => this.emitRecoverable(e as Error));
    return sub;
  }

  private async answerTake(authority: AnycastRequestAuthority, m: import("@nats-io/transport-node").Msg): Promise<void> {
    let reply: AnycastTakeReply;
    if (this.takesInFlight >= MAX_TAKES_IN_FLIGHT) reply = { ok: false, code: "busy", error: "the delivery daemon is answering too many takes; retry" };
    else {
      this.takesInFlight++;
      try {
        reply = await this.takeFor(authority, m);
      } catch (e) {
        reply = { ok: false, code: "busy", error: `the take could not be recorded: ${(e as Error).message}` };
      } finally {
        this.takesInFlight--;
      }
    }
    m.respond(JSON.stringify(reply));
  }

  /** Check one take's caller and arguments, then record it. The role and the caller come from the
   *  broker-policed subject; the payload's `from.id` must match, as on every control rail. */
  private async takeFor(authority: AnycastRequestAuthority, m: import("@nats-io/transport-node").Msg): Promise<AnycastTakeReply> {
    if (!this.plane3MayAct()) return { ok: false, code: "busy", error: "delivery: this daemon is not serving this shard (it is re-checking ownership); retry" };
    const parsed = parseTakeSubject(m.subject);
    let req: AnycastTakeRequest | undefined;
    try { req = m.json<AnycastTakeRequest>(); } catch { req = undefined; }
    if (!parsed || !isPrincipalOwnerToken(parsed.owner) || req?.from?.id !== parsed.sender || typeof req.from.name !== "string")
      return { ok: false, code: "mismatch", error: "sender mismatch - take rejected" };
    if (!isAnycastSeq(req.seq) || !isAnycastSeq(req.count) || typeof req.id !== "string" || req.id.length > 256 ||
        typeof req.epoch !== "string" || req.epoch.length > 64)
      return { ok: false, code: "mismatch", error: "a take names a seq, the request id, a delivery count and the stream's creation time" };
    // The name reaches the sender's status text, so it must pass the rule a presence card name does.
    try { assertValidName(req.from.name); } catch (e) {
      return { ok: false, code: "mismatch", error: `a take names its holder by a valid display name: ${(e as Error).message}` };
    }
    return authority.take(parsed.role, { from: { id: parsed.sender, name: req.from.name }, seq: req.seq, id: req.id, count: req.count, epoch: req.epoch });
  }

  /** DM one notice to a request's sender from this daemon's own principal. The event key is the
   *  message id, so a resend after a crash is dropped by the DM stream's duplicate window and by
   *  the receiving connector. */
  private async sendAnycastNotice(to: string, event: { key: string; text: string; notice: AnycastNotice }): Promise<void> {
    if (!this.js) throw new Error(this.notLiveMsg());
    const recipient = parsePrincipalKey(to);
    if (!recipient) throw new Error(`anycast notice: "${to}" is not a principal`);
    const msg: CotalMessage = {
      id: event.key,
      ts: Date.now(),
      space: this.space,
      from: this.ref(),
      to,
      parts: [{ kind: "text", text: event.text }, { kind: "data", data: { [ANYCAST_NOTICE_KEY]: event.notice } }],
    };
    await this.js.publish(unicastSubject(this.space, recipient.owner, recipient.actor, this.owner, this.actor), JSON.stringify(msg), { msgID: msg.id });
  }

  /** DM a post's sender that its mentions of `names` reached no one, because each of those agents
   *  may not read `channel`. The id carries the post's stream seq, so a fan-out redelivered after a
   *  crash sends the notice again under the same id and the DM stream drops the duplicate. */
  private async sendMentionNotice(msg: CotalMessage, channel: string, seq: number, names: readonly string[]): Promise<void> {
    if (!this.js) throw new Error(this.notLiveMsg());
    const recipient = parsePrincipalKey(msg.from.id);
    if (!recipient) throw new Error(`mention notice: "${msg.from.id}" is not a principal`);
    const named = names.map((n) => `@${n}`).join(", ");
    const notice: CotalMessage = {
      id: `mention.${seq}.${msg.id}`,
      ts: Date.now(),
      space: this.space,
      from: this.ref(),
      to: msg.from.id,
      parts: [
        { kind: "text", text: `Your post on #${channel} mentioned ${named}, who may not read #${channel} and ${names.length === 1 ? "was" : "were"} not given it. Reach ${names.length === 1 ? "them" : "each"} another way, such as cotal_dm.` },
        { kind: "data", data: { [MENTION_NOTICE_KEY]: { channel, message: msg.id, names: [...names] } } },
      ],
    };
    await this.js.publish(unicastSubject(this.space, recipient.owner, recipient.actor, this.owner, this.actor), JSON.stringify(notice), { msgID: notice.id });
  }

  /** Answer a sender's status or cancel for one of its own requests. The caller is the
   *  authenticated subject sender, checked against the request's stored subject. */
  private async deliveryAnycast(op: string, caller: string, args: Record<string, unknown>): Promise<ControlReply> {
    const authority = this.anycastAuthority;
    if (!authority)
      return { ok: false, error: `delivery: ${this.anycastUnavailable ?? "the anycast request records are not open on this daemon; retry"}` };
    if (!isAnycastSeq(args.seq)) return { ok: false, error: `${op}: seq must be a whole number of at least 1` };
    if (args.id !== undefined && (typeof args.id !== "string" || args.id.length > 256)) return { ok: false, error: `${op}: id must be a request id` };
    const q = { seq: args.seq, ...(typeof args.id === "string" ? { id: args.id } : {}) };
    try {
      const status = op === ANYCAST_CANCEL_OP ? await authority.cancel(caller, q) : await authority.status(caller, q);
      if (!this.plane3MayAct()) return { ok: false, error: "delivery: this daemon stopped serving this shard while the request was in flight; retry" };
      return { ok: true, data: status satisfies AnycastStatus };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ---- the peer-readable liveness surface (#1577) --------------------------

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
    if (!this.nc) throw new Error(this.notLiveMsg());
    const held = this.livenessResponders.get(plane);
    if (held) held.readState = readState;
    else this.livenessResponders.set(plane, { readState });
    this.bindLiveness(plane);
  }

  /** (Re)bind one plane's liveness responder on the CURRENT connection, dropping the stale sub first
   *  as {@link armDeliveryControl} does. */
  private bindLiveness(plane: LivenessPlane): void {
    const held = this.livenessResponders.get(plane);
    if (!held || !this.nc) return;
    if (held.sub) {
      try { held.sub.unsubscribe(); } catch { /* dead with the old connection */ }
      const i = this.subs.indexOf(held.sub);
      if (i >= 0) this.subs.splice(i, 1);
    }
    const { readState } = held;
    const sub = this.nc.subscribe(livenessServeFilter(this.space, plane), { queue: `live.${plane}` });
    held.sub = sub;
    this.subs.push(sub);
    // The responder token this bind answers under: AN OPAQUE VALUE MINTED HERE, and deliberately
    // not any name this process already has. It is what makes "which responder answered" askable
    // without making "who is this responder" answerable — the two properties the surface has to
    // hold at once. The endpoint's own `card.id` would be its principal, the lease row's
    // `instanceId` is a field of a bucket an agent holds no grant on, and either would turn a
    // presence probe into an identity read for every credentialed peer in the space. A fresh
    // random token correlates with nothing but this plane's other answers, which is the whole job:
    // two answers carrying two different tokens came from two different responders.
    //
    // Per BIND rather than per process, so a responder that goes away and comes back answers under
    // a new token. That is the honest reading: a caller comparing answers across a restart is
    // comparing two different incarnations, and a token that survived the restart would say
    // otherwise. A re-bind after a reconnect is such a return: the plane had no responder here for
    // the gap.
    const instance = randomUUID();
    void (async () => {
      for await (const m of sub) {
        // Sender-bound reply guard. Drop silently rather than publishing somewhere else: a reply
        // aimed outside the sender's own subtree is not a request we can answer safely.
        //
        // REPORTED ON `warning`, NOT ON `error`, AND THAT IS A SAFETY PROPERTY RATHER THAN A CHOICE
        // OF CHANNEL. A rejected probe is a condition this responder is already surviving: it drops
        // the frame and keeps serving. `error` cannot carry such a notice on this class, because
        // Node's `EventEmitter` RETHROWS an `error` emit that has no listener attached, so the
        // notice would end the process of any embedder that had not attached one — and the plane
        // would then genuinely be unbound, which a peer's next probe reports as `unbound`. The
        // condition would have manufactured the state it described. `warning` is observable and
        // never fatal without a listener (see {@link emitRecoverable} and #891, where retry notices
        // on `error` killed hosts the endpoint intended to keep running).
        //
        // Since ANY credentialed peer may publish a probe, and the reply target inside it is chosen
        // by that peer and not permission-checked by the broker, reaching this branch is a peer's
        // decision, not an operator's. Safety here must therefore hold with no listener attached,
        // which is what CELL F1 runs.
        if (!m.reply || !m.reply.startsWith(`${m.subject}.reply.`)) {
          this.emitRecoverable(new Error(`rejected liveness probe on ${m.subject}: reply target "${m.reply ?? "(none)"}" is not under the sender's own reply subtree`));
          continue;
        }
        let responder: ResponderState;
        try {
          responder = await readState();
        } catch {
          responder = "unknown";
        }
        const answer: LivenessAnswer = { plane, responder, instance };
        try { m.respond(JSON.stringify(answer)); } catch { /* the requester is gone */ }
      }
      // The loop itself ends only on a SUBSCRIPTION-level fault (the connection went away), which
      // is not something a peer's probe can cause: the guard above `continue`s, `readState` is
      // caught, and the respond is caught. So this arm stays on `error` — it reports that this
      // responder has stopped answering at all, which is a fault an embedder should not be able to
      // miss, and no credentialed peer can reach it.
    })().catch((e) => this.emit("error", e as Error));
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
    if (!isLivenessPlane(plane))
      // A closed set, refused loudly. Answering an unknown plane at all would make this a probe
      // that returns something for every input, which is indistinguishable from one that is not
      // measuring anything.
      throw new Error(`liveness: "${plane}" is not a plane this surface answers for (${[...LIVENESS_PLANES].join(", ")})`);
    if (!this.nc) throw new Error(this.notLiveMsg());
    const reqSubject = livenessSubject(this.space, plane, this.owner, this.actor);
    const reply = `${reqSubject}.reply.${randomUUID()}`;
    let outcome: ProbeOutcome;
    let answered: ResponderState | undefined;
    let instance: string | undefined;
    try {
      const m = await this.requestBoundReply(this.nc, reqSubject, "", reply, timeoutMs);
      let body: unknown;
      try { body = m.json(); } catch { body = undefined; }
      const parsed = parseLivenessAnswer(body, plane);
      // A reply we cannot read is `malformed`, which grades `unknown`. It is NOT promoted to
      // `bound` on the strength of having replied at all: that promotion is the `pgrep` error,
      // where evidence a process exists was read as evidence it works.
      outcome = parsed ? "replied" : "malformed";
      answered = parsed?.responder;
      instance = parsed?.instance;
    } catch (e) {
      outcome = this.isNoResponders(e) ? "noResponders" : this.probeFailureOutcome(e);
    }
    // `instance` rides ONLY a reply that was read. Every other outcome means no responder answered,
    // so there is no responder to name, and a token attached to an `unbound` or an `unknown` would
    // claim one had. It stays absent on those arms by construction: nothing assigns it.
    const verdict: LivenessAnswer = { plane, responder: responderFromProbe(outcome, answered) };
    return instance === undefined ? verdict : { ...verdict, instance };
  }

  /** Grade a failed probe that was NOT a no-responders answer. Both arms return an outcome that
   *  maps to `unknown`; they are told apart so the distinction stays legible at the call site and so
   *  a future caller can render the two differently (a refusal is about YOUR credential, a timeout
   *  is about something being wedged). Neither may ever mean health. */
  private probeFailureOutcome(e: unknown): ProbeOutcome {
    if (e instanceof AuthorizationError || e instanceof PermissionViolationError) return "refused";
    if (e instanceof TimeoutError) return "timeout";
    // Anything else is a transport or client failure: it says something about our link, not about
    // the plane, so it is graded like a refusal rather than guessed at.
    return "refused";
  }

  /**
   * Serve this process's `agent` endpoint on the principal route (SPEC 13.21, 13.22): the
   * `AGENT_CLUSTER` command set about this principal, addressed by its own principal, lifecycle UID
   * and runtime id, with no registration. `handlers` serves the cluster's commands with
   * `AGENT_CONTRACTS`; `describe` is built in.
   *
   * Throws on an open mesh and on a static credential, where no row names who may call, without a
   * lifecycle UID, before the endpoint has started, while it already serves `agent`, for an
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
    if ("endpoint" in spec || "cluster" in spec)
      throw new Error(`servePrincipal serves only the "${AGENT_ENDPOINT}" endpoint with AGENT_CLUSTER and takes handlers alone; an endpoint or cluster is refused, never ignored (SPEC 13.22)`);
    const serve = { endpoint: AGENT_ENDPOINT, cluster: AGENT_CLUSTER, handlers: spec.handlers };
    if (!this.authed)
      throw new Error("the principal route is served only on an authenticated mesh: on an open mesh no row says who may call (SPEC 13.21)");
    if (!this.userMode)
      throw new Error("the principal route is served only under a user-auth credential: a static credential names no one who may call (SPEC 13.21)");
    const uid = this.ownLifecycleUid;
    if (uid === undefined)
      throw new Error("serving the principal route needs this endpoint's lifecycleUid: the subject names it (SPEC 13.21)");
    const nc = this.nc;
    if (!nc) throw new Error(this.notLiveMsg());
    endpointToken(serve.endpoint);
    if (this.principalServes.has(serve.endpoint))
      throw new Error(`this endpoint already serves "${serve.endpoint}" on the principal route`);
    const self: EpPrincipal = { owner: this.owner, actor: this.actor, uid, runtimeId: assertRuntimeToken(processRuntime(uid).id) };
    const serverKey = `${this.space}\n${self.runtimeId}\n${serve.endpoint}`;
    if (principalServers.has(serverKey))
      throw new Error(`another endpoint in this process already serves "${serve.endpoint}" for lifecycle ${uid}: both would subscribe the same principal-route subject and answer one request twice (SPEC 13.21); stop that one first`);
    let resolveReady!: () => void, rejectReady!: (e: Error) => void, resolveFailed!: (e: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    ready.catch(() => { /* the caller observes it; this keeps an unobserved refusal from being unhandled */ });
    const failed = new Promise<Error>((resolve) => { resolveFailed = resolve; });
    const intent: PrincipalServeIntent = {
      serve, self, serverKey, handles: [], ended: false, readySettled: false, resolveReady, rejectReady, resolveFailed,
    };
    // Construction refuses an invalid cluster before anything is kept or subscribed.
    const handle = this.bindPrincipalHandle(intent, nc);
    this.principalServes.set(serve.endpoint, intent);
    principalServers.set(serverKey, intent);
    // A fresh `seq` per serve: the last serve may have ended with prompts open, and the pair
    // `(runtime.id, seq)` it showed then must not name this serve's empty list (SPEC §6).
    if (serve.endpoint === AGENT_ENDPOINT) this.promptsPresence = { open: 0, seq: this.nextPromptsSeq() };
    void this.armPrincipalServe(intent, nc, handle);
    return { ready, failed, stop: () => this.stopPrincipalServe(intent) };
  }

  /** Subscribe `intent` on `nc`. */
  private bindPrincipalHandle(intent: PrincipalServeIntent, nc: NatsConnection): EpPrincipalServeHandle {
    return servePrincipalRoute(nc, this.space, intent.self, intent.serve);
  }

  /** A principal-route refusal a call or a serve reports itself: a request publish, a serve
   *  subscription or a reply read. Only a reply publish is left, which no call or serve awaits. */
  private ownedPrincipalRouteRefusal(err: PermissionViolationError): boolean {
    const p = `${spacePrefix(this.space)}.ep.`;
    if (err.operation === "publish") return err.subject.startsWith(`${p}prin.`);
    return err.subject.startsWith(`${p}prin.`) || err.subject.startsWith(`${p}prin-reply.`);
  }

  /** Track one binding: a refusal ends the serve, and an accepted subscription on the current
   *  connection shows the presence field. */
  private async armPrincipalServe(intent: PrincipalServeIntent, nc: NatsConnection, handle: EpPrincipalServeHandle): Promise<void> {
    intent.binding = { nc, handle };
    // Every earlier binding is on a replaced connection: retire it once its handlers finish.
    for (const old of intent.handles)
      void old.stop().finally(() => {
        const i = intent.handles.indexOf(old);
        if (i >= 0) intent.handles.splice(i, 1);
      });
    intent.handles.push(handle);
    intent.readyOn = undefined;
    void handle.refused.then((err) => {
      if (!intent.ended && intent.binding?.handle === handle) this.endPrincipalServe(intent, err);
    });
    try {
      await handle.ready;
    } catch {
      // A refusal ends the serve through `refused`. A flush that failed because the connection
      // went away is answered by the binding the next connection makes.
      return;
    }
    this.principalServeConfirmed(intent, nc, handle);
  }

  /** The broker accepted `handle` on `nc`. When that is still the current binding, the serve is
   *  ready there. */
  private principalServeConfirmed(intent: PrincipalServeIntent, nc: NatsConnection, handle: EpPrincipalServeHandle): void {
    if (intent.ended || intent.binding?.handle !== handle || this.nc !== nc) return;
    intent.readyOn = nc;
    if (!intent.readySettled) {
      intent.readySettled = true;
      intent.resolveReady();
    }
    if (intent.serve.endpoint === AGENT_ENDPOINT) this.publishPresence().catch((e) => this.emitRecoverable(e as Error));
  }

  /** Re-bind every principal serve on a replaced connection (a rebuild), or re-run the check on the
   *  connection the library reconnected and re-subscribed itself. */
  private rebindPrincipalServes(reconnected: boolean): void {
    const nc = this.nc;
    if (!nc) return;
    for (const intent of this.principalServes.values()) {
      if (intent.ended) continue;
      const bound = intent.binding;
      if (bound && bound.nc === nc) {
        if (!reconnected) continue;
        intent.readyOn = undefined;
        void bound.handle.check().then(() => this.principalServeConfirmed(intent, nc, bound.handle), () => { /* a refusal ends it through `refused` */ });
        continue;
      }
      let handle: EpPrincipalServeHandle;
      try {
        handle = this.bindPrincipalHandle(intent, nc);
      } catch (e) {
        this.endPrincipalServe(intent, e as Error);
        continue;
      }
      void this.armPrincipalServe(intent, nc, handle);
    }
  }

  /** End a serve the broker refused: no more serving, `failed` resolves, the presence field goes. */
  private endPrincipalServe(intent: PrincipalServeIntent, err: Error): void {
    if (intent.ended) return;
    this.forgetPrincipalServe(intent);
    const wasReady = intent.readySettled;
    if (!intent.readySettled) {
      intent.readySettled = true;
      intent.rejectReady(err);
    }
    intent.resolveFailed(err);
    for (const handle of intent.handles) void handle.stop();
    if (intent.serve.endpoint === AGENT_ENDPOINT) {
      this.promptsPresence = undefined;
      this.publishPresence().catch((e) => this.emitRecoverable(e as Error));
    }
    // `ready` already carried a refusal that came before it settled; a later one is reported here.
    if (wasReady) this.emitRecoverable(new Error(`stopped serving "${intent.serve.endpoint}" on the principal route: ${err.message}`, { cause: err }));
  }

  /** Mark `intent` ended and release what it holds in this endpoint and in this process. */
  private forgetPrincipalServe(intent: PrincipalServeIntent): void {
    intent.ended = true;
    intent.readyOn = undefined;
    if (this.principalServes.get(intent.serve.endpoint) === intent) this.principalServes.delete(intent.serve.endpoint);
    if (principalServers.get(intent.serverKey) === intent) principalServers.delete(intent.serverKey);
  }

  /** Stop serving `intent` and wait for its handlers in flight, each until its request's deadline
   *  at most. The ending is synchronous, so a
   *  `ready` still waiting for the broker rejects before the caller's next step. `republish` writes
   *  presence without the `prompts` field; the endpoint's own stop writes it offline instead. */
  private async stopPrincipalServe(intent: PrincipalServeIntent, republish = true): Promise<void> {
    if (!intent.ended) {
      this.forgetPrincipalServe(intent);
      if (!intent.readySettled) {
        intent.readySettled = true;
        intent.rejectReady(new Error(`stopped serving "${intent.serve.endpoint}" before the broker confirmed the subscription`));
      }
      if (intent.serve.endpoint === AGENT_ENDPOINT) {
        this.promptsPresence = undefined;
        if (republish) this.publishPresence().catch((e) => this.emitRecoverable(e as Error));
      }
    }
    await Promise.all(intent.handles.map((handle) => handle.stop()));
  }

  /**
   * Set this process's `prompts` presence field and write presence at once (SPEC §6): how many
   * prompts it holds `open` or `sent`, and a counter that goes up by one each time a prompt opens or
   * changes state. The field shows only while the `agent` endpoint is served and the broker accepted
   * its subscription on the current connection. Until this is called it shows `open: 0` with the
   * fresh `seq` the serve took from {@link nextPromptsSeq} when it started. Throws when the `agent`
   * endpoint is not served, and a RangeError for a `seq` below one this runtime already used.
   */
  async setPromptsPresence(prompts: PresencePrompts): Promise<void> {
    for (const k of ["open", "seq"] as const)
      if (!Number.isSafeInteger(prompts?.[k]) || prompts[k] < 0) throw new TypeError(`prompts.${k} must be a non-negative safe integer`);
    const intent = this.principalServes.get(AGENT_ENDPOINT);
    if (!intent)
      throw new Error(`the prompts presence field belongs to a served "${AGENT_ENDPOINT}" endpoint: call servePrincipal first (SPEC §6)`);
    const used = promptsSeqs.get(intent.self.runtimeId) ?? 0;
    if (prompts.seq < used)
      throw new RangeError(`prompts.seq ${prompts.seq} is below ${used}, which this process already used under runtime ${intent.self.runtimeId}: seq never goes back under one runtime id (SPEC §6)`);
    promptsSeqs.set(intent.self.runtimeId, prompts.seq);
    this.promptsPresence = { open: prompts.open, seq: prompts.seq };
    await this.publishPresence();
  }

  /**
   * Take the next `prompts` `seq` for this process's runtime (SPEC §6): 0 the first time, then one
   * above every `seq` this process used under its runtime id, whichever endpoint object used it. A
   * prompt desk takes every `seq` it shows from here. Throws without a lifecycle UID.
   */
  nextPromptsSeq(): number {
    const runtimeId = processRuntime(this.requireLifecycleUid("nextPromptsSeq")).id;
    const used = promptsSeqs.get(runtimeId);
    const next = used === undefined ? 0 : used + 1;
    promptsSeqs.set(runtimeId, next);
    return next;
  }

  /** The `prompts` field this process's presence carries now, or none. */
  private servedPrompts(): PresencePrompts | undefined {
    const intent = this.principalServes.get(AGENT_ENDPOINT);
    if (!intent || intent.ended || !this.nc || intent.readyOn !== this.nc) return undefined;
    return this.promptsPresence;
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
    const nc = this.nc;
    if (!nc) throw new Error(this.notLiveMsg());
    const contract = call.contract
      ?? (call.command === "describe" ? describeContracts() : call.endpoint === AGENT_ENDPOINT ? AGENT_CONTRACTS[call.command] : undefined);
    if (contract === undefined)
      throw new EpEnvelopeError("bad-request", `no contract is built in for ${call.endpoint}.${call.command}; pass one`, undefined, "not-executed");
    const caller: EpCaller = { owner: this.owner, actor: this.actor, uid: this.requireLifecycleUid("callPrincipal") };
    return epPrincipalCall(nc, this.space, { principal: call.principal, authority: call.authority }, {
      endpoint: call.endpoint, command: call.command, contract, caller, name: this.card.name,
      ...(call.args !== undefined ? { args: call.args } : {}),
    }, { deadlineMs: call.deadlineMs, ...(call.signal ? { signal: call.signal } : {}) });
  }

  /** Agent-side: request a Plane-3 durable backstop for a channel via the server-side delivery daemon (ctl.delivery). Throws
   *  when no privileged writer is present (open / no delivery daemon). 30s timeout — activation catch-up may
   *  run before the reply (the window is small, but a busy channel can take more than the 5s default). */
  async durableJoinChannel(channel: string): Promise<{ durable: boolean; reason?: string; generation?: number }> {
    const reply = await this.requestDelivery("durableJoin", { channel }, 30_000);
    if (!reply.ok) throw new Error(reply.error ?? "durable join rejected");
    return (reply.data as { durable: boolean; reason?: string; generation?: number }) ?? { durable: false };
  }

  /** Agent-side: release a Plane-3 durable backstop (tombstone membership at the leave cursor). Passes
   *  the join generation so a stale leave can't tombstone a newer rejoin (the delivery daemon validates
   *  it) AND this incarnation's lifecycleUid — membership rows are lifecycle-keyed (SPEC 13.1), and a
   *  leave must resolve the selected principal-owned row even after the ACL row was narrowed or purged. */
  async durableLeaveChannel(channel: string, generation?: number, lifecycleUid = this.requireLifecycleUid("leaving a durable channel")): Promise<void> {
    const reply = await this.requestDelivery("durableLeave", { channel, generation, lifecycleUid });
    if (!reply.ok) throw new Error(reply.error ?? "durable leave rejected");
  }

  /** Fail-closed async cleanup for a channel forced out by a LATE sub.allow refusal (the broker revoked
   *  the live read). The sync sub callback can't await, so this RETRIES the Plane-3 tombstone with capped
   *  backoff UNTIL IT SUCCEEDS (or the endpoint stops) — the §7 boundary always closes once the manager
   *  is reachable, never a silent give-up. While pending, the channel is tracked in
   *  {@link pendingDurableLeave} and surfaced via {@link pendingDurableLeaves} (the connector shows it in
   *  `cotal_channels` as `durable-unclosed`, never ordinary absence). The generation is kept the whole
   *  time. Authoritative closure of a revoked membership is also handled by revocation (rotate creds + tear down). */
  private async closeRefusedMembership(channel: string, generation: number): Promise<void> {
    this.pendingDurableLeave.set(channel, generation);
    for (let attempt = 0; ; attempt++) {
      if (this.stopped) return;
      try {
        await this.durableLeaveChannel(channel, generation);
        this.plane3Channels.delete(channel);
        this.pendingDurableLeave.delete(channel);
        return;
      } catch (e) {
        if (attempt === 0)
          this.emitRecoverable(new Error(`channel "${channel}": Plane-3 durable membership (generation ${generation}) not yet tombstoned after a refused live sub - retrying; §7 boundary may be open until it succeeds (${(e as Error).message})`));
        await this.membershipPause(attempt);
      }
    }
  }

  /** Channels with a Plane-3 durable membership whose §7 tombstone is still pending after a refused live
   *  sub (see {@link closeRefusedMembership}) — surfaced by the connector as a `durable-unclosed` state so
   *  it is never presented as ordinary "not subscribed". */
  pendingDurableLeaves(): string[] {
    return [...this.pendingDurableLeave.keys()];
  }

  /** A control request that found NO responder — open / manager-less (no privileged control plane),
   *  distinct from a responder that errored. nats.js surfaces it as NoRespondersError, or a RequestError
   *  whose `isNoResponders()` is true. */
  private isNoResponders(e: unknown): boolean {
    return e instanceof NoRespondersError || (e instanceof RequestError && e.isNoResponders());
  }

  /** Holder side of a take (SPEC §8.1): ask the delivery daemon to record this endpoint's take of the
   *  request at `seq`, for the copy with `count` deliveries. Never throws; a take the daemon could
   *  not decide is reported as held, with what the operator has to do when that is anything. */
  private async takeAnycast(role: string, seq: number, id: string, count: number, epoch: string, nak: () => void): Promise<AnycastTakeOutcome> {
    const nc = this.nc;
    if (!nc) return { taken: false, drop: false, reason: "daemon-down", detail: this.notLiveMsg() };
    const held = (reason: "daemon-busy" | "daemon-down" | "daemon-outdated" | "credential-outdated", detail: string): AnycastTakeOutcome =>
      ({ taken: false, drop: false, reason, detail });
    const subject = takeSubject(this.space, role, this.owner, this.actor);
    const body: AnycastTakeRequest = { from: { id: this.card.id, name: this.card.name }, seq, id, count, epoch };
    let reply: AnycastTakeReply;
    try {
      const m = await this.requestBoundReply(nc, subject, JSON.stringify(body), `${subject}.reply.${randomUUID()}`, ANYCAST_TAKE_TIMEOUT_MS);
      reply = m.json<AnycastTakeReply>();
    } catch (e) {
      if (isPermissionDenied(e))
        return held("credential-outdated", "this seat's credential was minted before anycast takes existed, so it cannot take role requests; respawn the seat to get a current credential");
      if (this.isNoResponders(e)) return this.takeResponderMissing();
      return held("daemon-down", `the delivery daemon did not answer the take: ${(e as Error).message}`);
    }
    if (reply.ok) return { taken: true };
    // A mismatch can mean the stream was recreated under this consumer, which resumes on the new
    // stream: read its creation time again, so the copies delivered from here on carry it. When the
    // time moved, this copy is nakked, so the broker delivers it again at once with the new time. A
    // redelivery that still mismatches carries the time read here, so it is forgotten, not nakked.
    if (reply.code === "mismatch") {
      const current = await this.readTaskEpoch().catch(() => undefined);
      if (current !== undefined && current !== epoch) nak();
    }
    if (reply.code === "cancelled" || reply.code === "taken" || reply.code === "gone" || reply.code === "mismatch")
      return { taken: false, drop: true, reason: reply.code, detail: reply.error };
    return held("daemon-busy", reply.error);
  }

  /** No responder on the take rail: an older daemon answers the probe op as unsupported, and a
   *  stopped one does not answer at all. */
  private async takeResponderMissing(): Promise<AnycastTakeOutcome> {
    const held = (reason: "daemon-down" | "daemon-outdated", detail: string): AnycastTakeOutcome => ({ taken: false, drop: false, reason, detail });
    let reply: ControlReply;
    try {
      reply = await this.requestDelivery(ANYCAST_TAKES_OP, {}, ANYCAST_TAKE_TIMEOUT_MS);
    } catch {
      return held("daemon-down", "no delivery daemon is answering on this mesh, so role requests wait on the queue until one does");
    }
    if (!reply.ok && /not supported on the delivery control service/.test(reply.error ?? ""))
      return held("daemon-outdated", "the delivery daemon predates anycast takes, so this seat holds role requests until the daemon is restarted at this version (`cotal up` runs it)");
    if (!reply.ok && reply.error?.includes(ANYCAST_RECORDS_CREDENTIAL_OUTDATED))
      return held("daemon-outdated", `this seat holds role requests until the delivery daemon can record takes: ${ANYCAST_RECORDS_CREDENTIAL_OUTDATED}`);
    return held("daemon-down", "the delivery daemon is not answering takes, so role requests wait on the queue until it does");
  }

  /** The status of one of this endpoint's own anycast requests, from the delivery daemon's record
   *  or, with no record, from the queue (SPEC §8.1). `id` narrows the answer to that request. Throws
   *  on an open mesh, which runs no delivery daemon. */
  async anycastStatus(seq: number, id?: string): Promise<AnycastStatus> {
    return this.anycastRequest(ANYCAST_STATUS_OP, seq, id);
  }

  /** Cancel one of this endpoint's own anycast requests while it waits. A request a holder already
   *  took is refused, and the returned status names the taker. */
  async cancelAnycast(seq: number, id?: string): Promise<AnycastStatus> {
    return this.anycastRequest(ANYCAST_CANCEL_OP, seq, id);
  }

  private async anycastRequest(op: string, seq: number, id: string | undefined): Promise<AnycastStatus> {
    if (!this.authed) throw new Error("an open mesh runs no delivery daemon, so it keeps no record of anycast requests");
    if (!isAnycastSeq(seq)) throw new Error(`seq must be a whole number of at least 1, got ${seq}`);
    let reply: ControlReply;
    try {
      reply = await this.requestDelivery(op, { seq, ...(id !== undefined ? { id } : {}) }, 10_000);
    } catch (e) {
      if (this.isNoResponders(e)) throw new Error("no delivery daemon is answering on this mesh, so the request's record cannot be read");
      throw e;
    }
    if (!reply.ok) {
      if (/not supported on the delivery control service/.test(reply.error ?? ""))
        throw new Error("the delivery daemon predates anycast request status; restart it at this version (`cotal up` runs it)");
      throw new Error(reply.error ?? `${op} failed`);
    }
    return reply.data as AnycastStatus;
  }

  /** Agent-side: current lifecycle memberships, or all principal-owned rows for an explicit channel,
   *  from the delivery service. The agent holds no read on the privileged members KV. `undefined` ⇒ NO control responder
   *  (open / no delivery daemon, so there is no Plane-3 and no memberships). THROWS on a responder-present RPC
   *  failure, so a caller can FAIL-CLOSED rather than mistaking a transient error for "no membership". */
  async fetchMemberships(channel?: string): Promise<{ channel: string; generation: number; activated: boolean; lifecycleUid?: string }[] | undefined> {
    let reply: ControlReply;
    try {
      reply = await this.requestDelivery("listMemberships", { lifecycleUid: this.requireLifecycleUid("listing durable memberships"), ...(channel === undefined ? {} : { channel }) }, 5_000);
    } catch (e) {
      if (this.isNoResponders(e)) return undefined; // no delivery daemon — open / daemon-less, no Plane-3
      throw e; // responder present but errored — surface it (leaveChannel fails closed)
    }
    if (!reply.ok) throw new Error(reply.error ?? "listMemberships failed");
    return (reply.data as { memberships?: { channel: string; generation: number; activated: boolean; lifecycleUid?: string }[] } | undefined)?.memberships ?? [];
  }

  /** Agent-side, first connect (auth): SELF-JOIN this session's durable boot channels via the
   *  server-side delivery daemon — replacing the old manager-written boot membership. Each concrete
   *  `durable`-class boot channel, and each family such as `review.>`, gets a `durableJoin` whose
   *  returned generation seeds the leave mirror
   *  + durable-state surface; an already-active membership (a relaunch) is idempotent (no re-catch-up).
   *  If the daemon is down/absent at first connect (or reports a transient `durable:false`), the channel
   *  is handed to {@link reconcileBootJoin} for capped-backoff retry — so the backstop is RESTORED once
   *  the daemon recovers, not left silently live-only. Until a membership exists the channel renders
   *  degraded in `cotal_channels` ({@link hasDurableMembership}). */
  private async armBootDurableMemberships(): Promise<void> {
    for (const channel of this.channels) {
      if (this.plane3Channels.has(channel)) continue;
      // A family (`review.>`) asks for its row whatever the default class: each channel under it decides
      // its own at fan-out (#5404). Any other pattern has no durable membership.
      if (!isChannelFamily(channel)) {
        if (!isConcreteChannel(channel)) continue;
        // A missing channel row legitimately resolves through the defaults. A failed/denied registry
        // read does not prove the channel is live-only, so let it fail startup loudly.
        const cls = await this.deliveryClassFresh(channel);
        if (cls !== "durable") continue;
      }
      try {
        const r = await this.durableJoinChannel(channel);
        if (r.durable) this.plane3Channels.set(channel, r.generation ?? 0);
        else void this.reconcileBootJoin(channel); // present but not yet durable — reconcile to recovery
      } catch (e) {
        if (!this.isNoResponders(e)) this.emitRecoverable(e as Error); // no daemon ⇒ retry until it recovers
        void this.reconcileBootJoin(channel);
      }
    }
  }

  /** Retry a boot durable self-join with capped backoff until a membership EXISTS (success → seed
   *  `plane3Channels`) or the channel is left / the endpoint stops. Mirrors {@link closeRefusedMembership}:
   *  a one-shot first-connect attempt that swallowed a daemon outage would leave the boot channel live-only
   *  forever after the daemon recovers (and the lease-based health could then read "active" with no owner
   *  membership). This loop is the reconcile that closes that gap. Idempotent — a channel already pending
   *  is not double-driven; survives reconnect (it re-issues `durableJoinChannel` on the current connection). */
  private async reconcileBootJoin(channel: string): Promise<void> {
    if (this.pendingBootJoins.has(channel)) return; // already reconciling
    this.pendingBootJoins.add(channel);
    for (let attempt = 0; ; attempt++) {
      await this.membershipPause(attempt);
      if (this.stopped || !this.channels.includes(channel) || this.plane3Channels.has(channel)) {
        this.pendingBootJoins.delete(channel);
        return; // stopped, left, or another path established it
      }
      try {
        const r = await this.durableJoinChannel(channel);
        if (r.durable) {
          this.plane3Channels.set(channel, r.generation ?? 0);
          this.pendingBootJoins.delete(channel);
          return;
        }
        // present but durable:false (e.g. catch-up window evicted) — keep retrying; the channel stays
        // honestly degraded meanwhile, never silently "active".
      } catch (e) {
        if (attempt === 0 && !this.isNoResponders(e))
          this.emitRecoverable(new Error(`channel "${channel}": boot durable self-join not yet established - retrying until the delivery daemon is reachable (${(e as Error).message})`));
      }
    }
  }

  /** True if this session holds an established Plane-3 durable membership for `channel` (in `plane3Channels`).
   *  Drives the membership-aware delivery-health surface: a joined durable channel that is NOT yet a member
   *  (boot self-join pending / daemon down) must render degraded, never "active" off a live lease alone. */
  hasDurableMembership(channel: string): boolean {
    return this.plane3Channels.has(channel);
  }

  /** Lazily obtain a JetStream manager — so a non-consuming endpoint (e.g. the supervisor,
   *  consume:false) can still pre-create others' durables. */
  private async manager(): Promise<JetStreamManager> {
    if (!this.nc) throw new Error(this.notLiveMsg());
    this.jsm ??= await jetstreamManager(this.nc);
    return this.jsm;
  }

  /** Bind this endpoint's durable consumers: DM inbox, chat, and (if a role) the task queue. */
  private async startConsumers(): Promise<void> {
    if (!this.jsm) throw new Error(this.notLiveMsg());

    // Unicast: this instance's private DM inbox, keyed on this endpoint's owner+actor principal. Open
    // mode self-creates; auth mode BINDS a durable the provisioner pre-created (agents are denied
    // CONSUMER.CREATE on DM_<space>, since the create-time filter_subject is the attack surface).
    const ownUid = this.requireLifecycleUid("consuming the DM inbox");
    if (!this.authed) {
      // Open-mode self-create rides the SAME per-lifecycle ensure as the privileged pre-create: an
      // existing `dm_…-<uid>` durable (this lifecycle's own restart) is kept with its ORIGINAL
      // activation frontier; a fresh lifecycle captures its frontier at creation.
      await this.ensureDmDurable(this.owner, this.actor, ownUid, {
        ackWaitMs: this.ackWaitMs,
        inactiveThresholdMs: this.inactiveThresholdMs,
      });
    }
    const dm = dmDurable(this.owner, this.actor, ownUid);
    try {
      await this.pump(dmStream(this.space), dm, { inbox: true });
    } catch (e) {
      // Auth mode cannot create the durable, so every rebind fails the same way until the session is
      // replaced. The typed error lets a caller name that route instead of a bare "consumer not found".
      if (this.authed && isConsumerNotFound(e)) throw new DmDurableMissingError(dmStream(this.space), dm);
      throw e;
    }

    // Plane-3 (SPEC §8): bind + pump our per-member DELIVER durable (`dlv_<id>`) — the re-authorized
    // durable-backstop channel copies the trusted reader transfers to us. No-op when it isn't present
    // (open mode / un-provisioned). Auth-only feature; the pump self-guards on the durable's existence.
    await this.pumpDlv();

    // Multicast: open a native CORE subscription for each channel (live, manager-free, broker-enforced
    // by sub.allow) — boot + runtime joins use the SAME path; there is no per-instance chat durable.
    // The durable backstop (a busy/offline turn) is Plane-3 (auth: membership established by the agent's
    // self-join, the delivery daemon's fan-out writer + trusted reader deliver via the `dlv_<id>` pump
    // above; open dev mode is live-only — the durable plane needs the daemon's trusted reader, the
    // security boundary). Per-
    // channel history is the explicit replay-gated backfill, on FIRST connect only; a reconnect reopens
    // the subs without re-backfilling (the durable backstop redelivers any missed window via dlv).
    if (this.channels.length) {
      // Arm the per-channel join watermarks BEFORE opening the subs: the backfill reads <= frontier and
      // the core-sub delivers > frontier, so they never overlap (first connect). On reconnect we reopen
      // without arming/backfilling.
      const armed = this.firstConnect ? await this.armJoin(this.channels) : undefined;
      for (const ch of this.channels) this.subscribeChat(ch);
      await this.confirmChatSub();
      if (armed) await this.backfillArmed(armed, this.backfillFloor);
    }
    // First connect, auth mode: self-join BOOT durable channels via the server-side delivery daemon
    // (it owns membership now — there is no manager-written boot membership). Seeds plane3Channels so a
    // later leave can tombstone the §7 boundary; idempotent on relaunch. Open mode has no Plane-3.
    if (this.firstConnect && this.authed && this.channels.length) await this.armBootDurableMemberships();
    this.firstConnect = false;

    // Anycast: a shared work-queue consumer for our role — one instance grabs each task.
    // Open mode self-creates; auth mode BINDS the provisioner-pre-created svc_<role>
    // durable (agents are denied CONSUMER.CREATE on TASK_<space>, since the create-time
    // filter is the cross-role-drain attack surface — see provisionTaskQueue).
    if (this.card.role) {
      if (!this.authed) {
        await this.jsm.consumers.add(
          taskStream(this.space),
          taskDurableConfig(this.space, this.card.role, { ackWaitMs: this.ackWaitMs }),
        );
      }
      await this.pump(taskStream(this.space), taskDurable(this.card.role), this.authed ? { takeRole: this.card.role } : {});
    }
  }

  /** Drive one consumer: decode and hand each message to listeners with ack control. Our own sends are
   *  delivered too: on the DM inbox and the role queue they were addressed to us, so none is an echo,
   *  and acking one unseen on the work queue would delete the only copy of the request. */
  private async pump(stream: string, durable: string, opts: { inbox?: boolean; takeRole?: string } = {}): Promise<void> {
    if (!this.js) throw new Error(this.notLiveMsg());
    const consumer = opts.takeRole === undefined
      ? await this.js.consumers.get(stream, durable)
      : await this.bindTaskConsumer(stream, durable);
    const ackWaitMs = await ackWaitOf(consumer);
    const msgs = await consumer.consume();
    this.streamMsgs.push(msgs);
    if (opts.inbox) this.watchInbox(msgs, stream, durable);
    void (async () => {
      for await (const m of msgs) {
        const authed = this.authenticateStreamMsg(m);
        if (!authed) continue;
        const { msg, parsed } = authed;
        const delivery = durableDelivery(m, ackWaitMs);
        // On an auth mesh a role request carries its take: the holder records it with the delivery
        // daemon before showing the request, so its sender can cancel it until then (SPEC §8.1).
        // The copy carries the creation time of the stream it came from, read at bind.
        const role = opts.takeRole;
        if (role !== undefined) {
          const epoch = this.taskEpoch!;
          delivery.take = () => this.takeAnycast(role, m.seq, msg.id, m.info.deliveryCount, epoch, () => m.nak());
        }
        this.emit("message", authenticatedMessage(msg, parsed), delivery, {
          historical: false,
          kind: kindFromParsed(parsed.kind),
        } satisfies MessageMeta);
      }
    })().catch((e) => {
      if (!this.stopped) this.emit("error", e as Error);
    });
  }

  /** Bind the role consumer and read the TASK stream's creation time on both sides of the bind, so
   *  the time belongs to the stream the consumer was bound on (SPEC §8.1). */
  private async bindTaskConsumer(stream: string, durable: string): Promise<Consumer> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.readTaskEpoch();
      const consumer = await this.js!.consumers.get(stream, durable);
      if (before === (await this.readTaskEpoch())) return consumer;
    }
    throw new Error(`the ${stream} stream was recreated while its role consumer was binding; reconnect to bind it again`);
  }

  /** Read the TASK stream's creation time into {@link taskEpoch}. */
  private async readTaskEpoch(): Promise<string> {
    const epoch = (await (await this.manager()).streams.info(taskStream(this.space))).created;
    this.taskEpoch = epoch;
    return epoch;
  }

  /** Warn once when the broker reports this endpoint's own DM inbox missing while the connection is
   *  up, as after a store reset that the client's reconnect rode through, or after a manager restart
   *  deletes the inbox. nats.js keeps checking and resumes pulling if the inbox comes back, so this
   *  only reports. A `consumer_deleted` status is the consumer going away, so it warns at once. A
   *  not-found can be a passing state, so that warning waits for a second report; the several 409s a
   *  delete answers pending pulls with count once. A pull means the consumer was found again, which
   *  re-arms the warning. The loop ends when the consumer is stopped, by `stop()` or by a rebuild
   *  replacing this connection. */
  private watchInbox(msgs: ConsumerMessages, stream: string, durable: string): void {
    const boundNc = this.nc;
    void (async () => {
      let absences = 0;
      let deleted = false;
      for await (const s of msgs.status()) {
        if (this.stopped || this.nc !== boundNc) break;
        if (s.type === "next") {
          absences = 0;
          deleted = false;
          continue;
        }
        if (s.type === "consumer_deleted") {
          if (deleted) continue;
          deleted = true;
          absences = 1; // the deletion itself is the second report: warn on this one
        } else if (s.type !== "consumer_not_found" && s.type !== "stream_not_found") continue;
        if (++absences === 2)
          this.emitRecoverable(new Error(
            `DM inbox missing: the broker reports consumer "${durable}" on stream "${stream}" missing, so direct ` +
              "messages to this endpoint are not delivered. The endpoint keeps checking; if the inbox does not " +
              "come back, end this session and start a new one",
          ));
      }
    })().catch((e) => {
      if (!this.stopped) this.emit("error", e as Error);
    });
  }

  /** Decode one stream copy and apply the authenticity guard (fail closed): the sender is encoded in
   *  the subject, which the server policed who could publish. The payload `from` is advisory — it
   *  must match, and a missing `from` or an unparseable subject on a delivery is itself an anomaly.
   *  A rejected copy is `term()`ed (permanently invalid, never redelivered) and reported, and
   *  `undefined` returns, so no handler ever sees it. */
  private authenticateStreamMsg(m: JsMsg): { msg: CotalMessage; parsed: ParsedSubject } | undefined {
    let msg: CotalMessage;
    try {
      msg = m.json<CotalMessage>();
    } catch (e) {
      m.term(); // undecodable — never redeliver
      this.emit("error", e as Error);
      return undefined;
    }
    if (!isRecord(msg) || !isUsableMessageId(msg.id)) {
      m.term(); // malformed envelope (SPEC sec 5): absent/non-string id — permanently invalid
      this.emit("error", new Error(`dropped message on ${m.subject}: absent or non-string id`));
      return undefined;
    }
    const parsed = parseSubject(m.subject);
    if (!parsed || !isFromSubjectSender(msg, parsed)) {
      m.term();
      this.emit(
        "error",
        new Error(
          `dropped message on ${m.subject}: payload from ${msg.from?.id ?? "(none)"} ` +
            `does not match subject sender ${parsed?.sender ?? "(unparseable)"}`,
        ),
      );
      return undefined;
    }
    return { msg, parsed };
  }

  /** Bind this endpoint's own existing DM durable and drive it serially (EndpointOptions.dmOnly).
   *  The bind is one CONSUMER.INFO on `dm_<owner>-<actor>-<uid>`; reading is MSG.NEXT with a batch
   *  of one, and the next copy reaches the handler only after the previous handler settles. */
  private async bindDmOnly(mode: DmOnlyOptions): Promise<void> {
    if (!this.js) throw new Error(this.notLiveMsg());
    const stream = dmStream(this.space);
    const durable = dmDurable(this.owner, this.actor, this.requireLifecycleUid("consuming the DM inbox"));
    let consumer: Consumer;
    try {
      consumer = await this.js.consumers.get(stream, durable);
    } catch (e) {
      if (isJetStreamMissing(e, JetStreamApiCodes.ConsumerNotFound)) throw new DmDurableMissingError(stream, durable);
      throw new DmBindRefusedError(stream, durable, e);
    }
    const ackWaitMs = await ackWaitOf(consumer); // cached by the bind's own CONSUMER.INFO, no request
    // A rebind after reconnect must not overlap the previous epoch's running handler. A handler that
    // does not settle within the stop bound fails this bind; the retry loop tries again.
    if (this.dmOnlyInFlight) {
      const settleMs = mode.settleTimeoutMs ?? 30_000;
      await withDeadline(this.dmOnlyInFlight, settleMs, () =>
        new Error(`DM-only rebind waited ${settleMs}ms for the previous handler to settle; not reading the next DM yet`));
    }
    const msgs = await consumer.consume({ max_messages: 1 });
    this.streamMsgs.push(msgs);
    // The epoch this loop belongs to. nats.js can yield copies it already received after stop() began
    // or after a rebuild replaced the connection (a stacked pull after a missed-heartbeat reset hands
    // over several at once). Such a copy never reaches the handler and is neither acked nor nak'd:
    // the connection is closing or closed, so any reply could be lost, and the broker redelivers an
    // unacked copy after the durable's ack_wait to whichever epoch binds next.
    const boundNc = this.nc;
    const retired = (): boolean => this.stopped || this.nc !== boundNc || !boundNc || boundNc.isClosed();
    void (async () => {
      for await (const m of msgs) {
        if (retired()) break;
        const authed = this.authenticateStreamMsg(m);
        if (!authed) continue;
        if (authed.parsed.kind !== "inst") {
          m.term(); // the DM stream filter admits only inst.* subjects; anything else is not a DM
          continue;
        }
        const run = Promise.resolve().then(() => mode.handler(authenticatedMessage(authed.msg, authed.parsed), dmOnlyDelivery(m, ackWaitMs, boundNc), {
          historical: false,
          kind: "dm",
        } satisfies MessageMeta));
        const flight = run.then(() => {}, () => {});
        this.dmOnlyInFlight = flight;
        try {
          await run;
        } catch (e) {
          this.emit("error", e instanceof Error ? e : new Error(String(e)));
        } finally {
          if (this.dmOnlyInFlight === flight) this.dmOnlyInFlight = undefined;
        }
      }
    })().catch((e) => {
      if (!this.stopped) this.emit("error", e as Error);
    });
  }

  /** Open a native core subscription to a channel's live feed (the manager-free live read path,
   *  broker-enforced by `sub.allow`). At-most-once — no replay, no ack; it is the live delivery for
   *  every channel (boot + runtime). For a `durable` channel it is also the low-latency wake-hint
   *  alongside the Plane-3 durable copy, coalesced by the receiver's id-dedup. Drops our own echo +
   *  spoofed senders. */
  private subscribeChat(channel: string): void {
    if (!this.nc || this.chatSubs.has(channel)) return;
    this.chatSubDenied.delete(channel);
    const subject = chatSubject(this.space, "*", "*", channel);
    const sub = this.nc.subscribe(subject, {
      callback: (err, m) => {
        if (err) {
          // async sub.allow refusal (or sub error): the live feed for this channel is dead — never a
          // leak (the broker refused it). Drop the channel from local joined state even if it was
          // already treated as joined — a LATE refusal beyond the confirm window: conformance #13
          // "drop on late refusal". (During the join's own confirm the channel isn't pushed yet, so
          // this fires nothing then; joinChannel reads `chatSubDenied` and throws cleanly.) Either way
          // the refusal is reported from here, by that throw or the leave below, so watchStatus skips it.
          if (err instanceof PermissionViolationError) this.chatSubRefusals.add(err);
          this.chatSubDenied.add(channel);
          this.chatSubs.delete(channel);
          const i = this.channels.indexOf(channel);
          if (i >= 0) {
            this.channels.splice(i, 1);
            // A late sub.allow refusal forces this agent out of the channel (the broker revoked its live
            // read). If it held a Plane-3 durable membership, the §7 boundary must close too. This sub
            // callback can't await, so a fail-closed async helper RETRIES the tombstone (backoff) UNTIL it
            // succeeds, clearing the mirror only then; while pending it is surfaced via cotal_channels —
            // never a silent drop, never lost retry state.
            const gen = this.plane3Channels.get(channel);
            if (gen !== undefined) void this.closeRefusedMembership(channel, gen);
            this.emit(
              "error",
              new Error(`left channel "${channel}": its live subscription was refused by the broker`, { cause: err }),
            );
          }
          return;
        }
        const parsed = parseSubject(m.subject);
        if (!parsed || parsed.kind !== "chat") return;
        let msg: CotalMessage;
        try {
          msg = m.json<CotalMessage>();
        } catch (e) {
          this.emit("error", e as Error);
          return;
        }
        if (!isRecord(msg) || !isUsableMessageId(msg.id)) return; // malformed envelope (SPEC sec 5) — live is at-most-once: drop
        if (!isFromSubjectSender(msg, parsed)) return; // spoof/malformed/old-shape-alias — drop (at-most-once)
        if (msg.from.id === this.card.id) return; // our own echo
        const delivery: Delivery = { ack: () => {}, nak: () => {}, durable: false }; // live = at-most-once, not acked
        this.emit("message", authenticatedMessage(msg, parsed), delivery, {
          historical: false,
          kind: kindFromParsed(parsed.kind),
        } satisfies MessageMeta);
      },
    });
    this.chatSubs.set(channel, sub);
  }

  /** Close a channel's core subscription (manager-free leave). */
  private unsubscribeChat(channel: string): void {
    const sub = this.chatSubs.get(channel);
    if (sub) {
      try {
        sub.unsubscribe();
      } catch {
        /* closing with the connection */
      }
      this.chatSubs.delete(channel);
    }
    this.chatSubDenied.delete(channel);
  }

  /** Confirm a just-opened core subscription was accepted by the broker. A `sub.allow` violation is
   *  async in NATS, so flush (round-trips the SUB) then settle briefly to let the refusal land — a
   *  denied subscribe must not read as a successful join (SPEC conformance #13). */
  private async confirmChatSub(): Promise<void> {
    if (!this.nc) throw new Error("connection not established");
    // flush() is the deterministic boundary: the broker's -ERR for an out-of-ACL SUB arrives BEFORE the
    // PONG, so once flush resolves the subscribe callback has already recorded any denial. A flush
    // FAILURE means the connection drained/closed mid-join — we have no confirmation, so let it throw
    // (joinChannel fails closed) instead of swallowing it and continuing as if confirmed.
    await this.nc.flush();
    await new Promise((r) => setTimeout(r, 50));
  }

  /** The durable's info (rebind) or null (fresh — 404). Gates create/backfill to the join event
   *  and exposes the current `filter_subjects` for restart reconciliation. */
  private async consumerInfo(stream: string, durable: string): Promise<ConsumerInfo | null> {
    if (!this.jsm) throw new Error(this.notLiveMsg());
    try {
      return await this.jsm.consumers.info(stream, durable);
    } catch (e) {
      if (isJetStreamMissing(e, JetStreamApiCodes.ConsumerNotFound))
        return null; // structured absence — fresh durable
      throw e;
    }
  }

  /** Delete one named consumer, swallowing ONLY structured consumer/stream absence. */
  private async deleteConsumerIfPresent(stream: string, durable: string): Promise<void> {
    if (!this.jsm) throw new Error(this.notLiveMsg());
    try {
      await this.jsm.consumers.delete(stream, durable);
    } catch (e) {
      if (!isJetStreamMissing(e, JetStreamApiCodes.ConsumerNotFound, JetStreamApiCodes.StreamNotFound)) throw e;
    }
  }

  /** Current frontier (last sequence) of the chat stream — a channel's join watermark, the
   *  focus-watermark a connector captures on entering `focus` (recall reads ambient after it), and
   *  the backfill floor a preservation cut records for each retained seat. The manager reads it in
   *  open mode over its own `consume: false` endpoint, which binds no JetStream manager at start, so
   *  the manager is obtained lazily here rather than assumed. */
  async chatFrontier(): Promise<number> {
    const jsm = await this.manager();
    return (await jsm.streams.info(chatStream(this.space))).state.last_seq;
  }

  /** Whether this connection's account has a JetStream stream of this name. A missing stream is
   *  false. Any other failure is thrown, so a caller does not treat an unread broker as absence. */
  async streamRecorded(name: string): Promise<boolean> {
    try {
      await (await this.manager()).streams.info(name);
      return true;
    } catch (e) {
      if (isStreamNotFound(e)) return false;
      throw e;
    }
  }

  /** The bytes this connection's account holds in JetStream file storage, as `$JS.API.INFO`
   *  reports them. A broker's `max_file_store` cap counts every account it serves, so this is a
   *  lower bound on what that cap measures. */
  async storedBytes(): Promise<number> {
    return (await (await this.manager()).getAccountInfo()).storage;
  }

  /** Phase 1 of a join: capture each channel's current CHAT stream frontier before opening the
   *  core subscription. The frontier bounds the {@link backfillArmed} read (`seq <= frontier`),
   *  and the live subscription carries everything published after it. */
  private async armJoin(channels: string[]): Promise<Map<string, number>> {
    const frontiers = new Map<string, number>();
    for (const ch of channels) {
      frontiers.set(ch, await this.chatFrontier());
    }
    return frontiers;
  }

  /** Phase 2 of a join — backfill each armed channel's history up to its frontier (replay-gated),
   *  AFTER the filter flip. `floorSeq`, when set, is this incarnation's last-consumed CHAT stream
   *  sequence before a preservation cut (SPEC-external, manager-recorded) — it bounds the read from
   *  below so a resumed seat does not re-read messages it already consumed. Only the boot-channel
   *  call site (`start()`) passes it; `joinChannel`'s mid-session call never does (a channel joined
   *  after the cut was never read by this incarnation, so its replay window is the join contract).
   *  Returns the total backfilled. */
  private async backfillArmed(frontiers: Map<string, number>, floorSeq?: number): Promise<number> {
    let total = 0;
    for (const [ch, frontier] of frontiers) {
      const policy = await this.joinPolicyFresh(ch);
      if (policy.replay) total += await this.backfillChannel(ch, frontier, policy.windowMs, floorSeq);
    }
    return total;
  }

  /** Replay policy + backfill window read straight from the registry bucket (vs the watch cache)
   *  — the authoritative read for a join decision (a join is infrequent, and at startup the async
   *  cache may not have caught up). Falls to the built-in default only with no registry open. */
  private async joinPolicyFresh(channel: string): Promise<{ replay: boolean; windowMs?: number }> {
    if (!this.channelKv) return { replay: effectiveReplay(undefined, undefined) };
    // A wildcard subscription (`review.>`) has no single registry entry — and `>`/`*` are illegal
    // KV keys, so a per-channel get would throw. Read only the space defaults for it; concrete
    // channels still get their per-channel override.
    const [cfg, defaults] = await Promise.all([
      isConcreteChannel(channel) ? readChannelConfig(this.channelKv, channel) : Promise.resolve(undefined),
      readChannelDefaults(this.channelKv),
    ]);
    return { replay: effectiveReplay(cfg, defaults), windowMs: effectiveReplayWindowMs(cfg, defaults) };
  }

  /**
   * Read retained chat history on ONE channel subject through a name-scoped, single-filter
   * EPHEMERAL pull consumer — the broker-contained replacement for the removed Direct Get. The
   * create rides `$JS.API.CONSUMER.CREATE.<CHAT>.<chathist_id>.<subject>`, whose trailing filter
   * token nats-server pins to the request body (JSConsumerCreateFilterSubjectMismatchErr, code
   * 10131) — so an agent can only ever replay a channel its `allowSubscribe` grants. Single filter
   * only (plural isn't ACL-constrainable); `AckPolicy.None` + `mem_storage` so it leaves no durable
   * state, and it is deleted right after. Returns raw messages in stream order from `start`,
   * stopping once past `untilSeq` (exclusive of it) or after `limit`. The per-instance name means
   * calls must be serial — every reader here awaits to completion, so they are.
   */
  private async collectHistory(
    subject: string,
    start: { seq: number } | { time: Date },
    opts: { untilSeq?: number; limit?: number } = {},
  ): Promise<JsMsg[]> {
    return this.history.collectHistory(subject, start, opts);
  }

  /** Read a channel's retained history up to `upToSeq` (the join frontier) and emit each message
   *  as a `historical` "message" event. `sinceMs` bounds how far back via a native consumer
   *  `start_time` (now − window); unset ⇒ the full retained window. `floorSeq`, when set, is a
   *  tighter lower bound than the window: this incarnation had already consumed everything up to
   *  and including it before a preservation cut, so the read starts at `floorSeq + 1` and the
   *  `sinceMs` window is not consulted (the floor is the tighter bound by construction — the seat
   *  was live for the window's tail). `floorSeq >= upToSeq` means there is nothing new to read at
   *  all; return 0 without creating a consumer. A floor below the stream's oldest retained sequence
   *  is fine: JetStream's `DeliverPolicy.StartSequence` begins at the first retained message at or
   *  after it, which is exactly the catch-up. New messages (`seq > upToSeq`) are skipped — the live
   *  tail owns them. Reads through the contained {@link collectHistory}. */
  private async backfillChannel(channel: string, upToSeq: number, sinceMs?: number, floorSeq?: number): Promise<number> {
    return this.history.backfillChannel(channel, upToSeq, sinceMs, floorSeq);
  }

  /**
   * Replay-gated pull of a channel's retained ambient from `sinceSeq` (exclusive) forward — the
   * focus-recall read behind `cotal_inbox`. Returns the messages (NOT emitted — this is a pull,
   * not a push into context) plus `dropped: true` when the window may not be complete: the stream's
   * limits may have removed posts after the watermark ({@link chatMayHaveLost}: a sender at the
   * per-sender limit, or the stream's oldest post already past the watermark), or replay is off
   * for the channel below. Either way the caller must say so rather than silently reporting an
   * empty, complete window. `seqs[i]` is the chat
   * stream sequence of `messages[i]`, the one identity two identical messages do not share.
   * `unanswered` is true when no history read answered (replay is off, or the read failed), so
   * `messages` says nothing about what the channel retains.
   *
   * Honors the **same** per-channel replay gate as join-backfill ({@link joinPolicyFresh}): a
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

  /** Whether the chat stream's limits may have removed posts on `subject` after `sinceSeq`, read from
   *  the stream's own config rather than a compiled default. Throws when it cannot read, so no caller
   *  takes an unread stream for a complete one. It reports possible loss, never proof: a removed
   *  sequence does not record its subject, so the stream cannot say which channel lost it.
   *
   *  Either rule is enough. The stream's oldest retained post is past the watermark, so every post up
   *  to it is gone, from this channel or another. Or a sender on the channel is at the stream's
   *  per-sender limit and the channel's oldest retained post is past the watermark, so that sender's
   *  eviction may have reached into the window; a sender at exactly the limit may have lost nothing.
   *  A hole behind a retained older post, as a channel-filtered purge leaves, sets neither. */
  private async chatMayHaveLost(subject: string, sinceSeq: number): Promise<boolean> {
    if (!this.jsm) throw new Error(this.notLiveMsg());
    const info = await this.jsm.streams.info(chatStream(this.space), { subjects_filter: subject });
    if (info.state.first_seq > sinceSeq + 1) return true;
    const cap = info.config.max_msgs_per_subject;
    let maxPerSubject = 0;
    for (const count of Object.values(info.state.subjects ?? {})) maxPerSubject = Math.max(maxPerSubject, count);
    if (cap < 1 || maxPerSubject < cap) return false; // no sender at the cap ⇒ none evicted
    const oldest = (await this.collectHistory(subject, { seq: 1 }, { limit: 1 }))[0]?.seq;
    return oldest !== undefined && oldest > sinceSeq + 1;
  }

  private async publishPresence(): Promise<void> {
    return this.presence.publishPresence();
  }

  /** #1356: drop the presence-refusal record when the connection that OBSERVED those refusals goes
   *  away. "This bucket is refusing writes" is a claim about a specific broker connection; once that
   *  connection is torn down or rebuilt the claim has no remaining basis, and a later failure on a
   *  fresh connection must establish it again from its own evidence.
   *
   *  Cleared at the SOURCE rather than guarded at each reader, because a guard protects one consumer
   *  and clearing protects every consumer, including ones not yet written. Measured: without this, a
   *  failed bind against an unreachable server still reported the presence-refusal sentence while the
   *  endpoint's own `connectionIssue` already said "connection refused". */
  private clearPresenceWriteFailure(): void {
    return this.presence.clearPresenceWriteFailure();
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

  /** Bind a presence watch on the current connection. Resolves the bound consumer's info when
   *  the watch was installed, undefined when the endpoint stopped or rebuilt while the bind was
   *  in flight: that bind's watch is retired by {@link bindKvWatch} and nothing is installed,
   *  because the epoch that asked for it is gone and the epoch that replaced it binds its own
   *  watch through {@link connectAndBind}. Without this fence a bind that completes after
   *  {@link stop} would resurrect a watch on a stopped endpoint, and one that completes after a
   *  rebuild would overwrite the fresh epoch's watch with a dead-connection iterator. */
  private async startPresenceWatch(): Promise<ConsumerInfo | undefined> {
    return this.presence.startPresenceWatch();
  }

  /** {@link EndpointOptions.readOnce}: fill the roster from one read of the presence bucket. Stale
   *  and offline records resolve as they do in a watch's initial replay. */
  private async readPresenceOnce(): Promise<void> {
    return this.presence.readPresenceOnce();
  }

  /** Watch the channel registry: replay existing keys, then stream updates, into the local
   *  cache. A failed bind throws out of connect; an entry that does not decode or validate is
   *  reported as a `warning` and dropped, so its channel resolves to the default policy. */
  private async startChannelWatch(): Promise<void> {
    if (!this.channelKv) return;
    const bound = await this.bindKvWatch(this.channelKv);
    if (!bound) return;
    const { iter } = bound;
    this.channelWatchIter = iter;
    void (async () => {
      for await (const e of iter) this.handleChannelEntry(e);
    })().catch((e) => this.emit("error", e as Error));
  }

  /** {@link EndpointOptions.readOnce}: fill the channel cache from one read of the registry. */
  private async readChannelsOnce(): Promise<void> {
    if (!this.channelKv) return;
    for (const e of await lastKvEntries(this.channelKv)) this.handleChannelEntry(e);
  }

  private handleChannelEntry(e: KvEntry): void {
    // Cleared before the decode, so an entry that does not decode resolves to the default as the
    // fresh registry reads do.
    const isDefaults = e.key === CHANNEL_DEFAULTS_KEY;
    if (isDefaults) this.channelDefaults = {};
    else this.channelConfigs.delete(e.key);
    if (e.operation === "DEL" || e.operation === "PURGE") return;
    try {
      if (isDefaults) this.channelDefaults = decodeChannelEntry(e);
      else this.channelConfigs.set(e.key, decodeChannelEntry(e));
    } catch (err) {
      this.emitRecoverable(new Error(`dropped channel registry entry for key ${JSON.stringify(e.key)}: ${(err as Error).message}`));
    }
  }

  private sweep(): void {
    return this.presence.sweep();
  }
}

/** A usable delivery-message id (#624): a string, possibly empty (the never-a-key case), but
 *  never absent and never a non-string. An absent or non-string id is a malformed envelope under
 *  SPEC sec 5; each delivery pump handles it per its own class (durable term, live drop, history
 *  skip) so it never reaches the receiver's id-keyed machinery as `undefined`. */
function isUsableMessageId(id: unknown): id is string {
  return typeof id === "string";
}

/** Map an authenticated parsed-subject kind to the message class surfaced to "message" listeners.
 *  Throws on `ctl` (control-plane is request/reply, never a "message") — per repo convention, no
 *  silent default: an unexpected delivering kind is a bug, not something to swallow. */
function kindFromParsed(kind: ParsedSubject["kind"]): MessageMeta["kind"] {
  switch (kind) {
    case "chat":
      return "channel";
    case "inst":
      return "dm";
    case "svc":
      return "anycast";
    default:
      throw new Error(`cannot derive a message kind from subject kind "${kind}"`);
  }
}

/** SPEC §5 on receive: a delivery comes from the principal its subject names. The payload is an
 *  object whose `from.id` is the subject's sender, and the subject's owner is a real principal, not
 *  an old-shape alias. Every receive path asks this one predicate. What a path does with a refusal
 *  (drop, skip, ack, term or reject) and its own extra checks (a usable id, its own echo) stay with
 *  the path. */
export function isFromSubjectSender(msg: unknown, parsed: ParsedSubject): boolean {
  return isRecord(msg) && isRecord(msg.from) && msg.from.id === parsed.sender && isPrincipalOwnerToken(parsed.owner);
}

/** Routing fields in the envelope are advisory. The broker forge-locks sender (and for DMs,
 *  recipient) into the subject. Callers MUST already have passed {@link isFromSubjectSender}
 *  (SPEC §5). This derives the remaining
 *  routing tokens from the subject for rows that survived — it does not rewrite a mismatched
 *  `from.id`. Live tails, channel backfill, and channel recall skip the mismatch; history
 *  does the same (#388). The row's other fields pass through UNTOUCHED, so what the caller's
 *  row type already verified stays verified (#1413). */
function authenticatedMessage<M extends CotalMessage>(msg: M, parsed: ParsedSubject): CotalMessage & M {
  if (parsed.kind === "chat" || parsed.kind === "evp") return authenticatedChannelMessage(msg, parsed.rest);
  if (parsed.kind === "inst") return authenticatedDmMessage(msg, parsed.rest);
  if (parsed.kind === "svc") return authenticatedAnycastMessage(msg, parsed.rest);
  return msg;
}

function authenticatedDmMessage<M extends CotalMessage>(msg: M, to: string): CotalMessage & M {
  if (msg.to === to && (msg as CotalMessage).channel === undefined && msg.toService === undefined) return msg;
  const { channel: _channel, toService: _toService, ...base } = msg;
  return { ...base, to } as CotalMessage & M;
}

function authenticatedAnycastMessage<M extends CotalMessage>(msg: M, toService: string): CotalMessage & M {
  if (msg.toService === toService && msg.to === undefined && (msg as CotalMessage).channel === undefined) return msg;
  const { to: _to, channel: _channel, ...base } = msg;
  return { ...base, toService } as CotalMessage & M;
}

/** A DM-only copy's delivery. An ack, nak or in-progress signal on a closed connection is refused
 *  with a throw instead of being dropped silently: the copy stays unacked and the broker redelivers it. */
function dmOnlyDelivery(m: JsMsg, ackWaitMs: number, nc: NatsConnection | undefined): Delivery {
  const open = (what: string): void => {
    if (!nc || nc.isClosed()) throw new Error(`DM-only ${what} refused: the connection that delivered this copy is closed; the broker will redeliver it`);
  };
  return {
    ack: () => { open("ack"); m.ack(); },
    nak: () => { open("nak"); m.nak(); },
    durable: true,
    redelivery: { deliveryCount: m.info.deliveryCount, ackWaitMs, working: () => { open("in-progress signal"); m.working(); } },
  };
}

/** History drain keeps `m.json()` and used to throw the subject away. SPEC §5: on receive, verify
 *  `from.id` equals the subject sender; on mismatch, a missing `from`, or an unparseable delivery
 *  subject, reject and never surface. Fail closed on shape too: a stored JSON `null` or a truthy
 *  non-object `from` must not throw mid-array. Do not echo-drop `from.id === this.card.id`:
 *  god-view history must include the viewer's own sends. */
function historyMessageFromDelivery(m: { subject: string; json: <T>() => T }): HistoryMessage | undefined {
  let raw: unknown;
  try {
    raw = m.json();
  } catch {
    return undefined;
  }
  if (!isHistoryDrainEnvelope(raw)) return undefined;
  if (!isVerifiedHistoryRow(raw)) return undefined;
  const parsed = parseSubject(m.subject);
  if (!parsed || !isFromSubjectSender(raw, parsed)) return undefined;
  return authenticatedMessage(raw, parsed);
}

/** A row `isHistoryDrainEnvelope` admitted: object envelope, usable `id`, object `from` — the
 *  drain's own MINIMAL row type, what it checked and nothing more (#1413). Distinct from both
 *  `CotalMessage` (which promises more than the drain verified) and `HistoryMessage` (the
 *  PUBLIC row, whose every present field the drain checked before returning it). */
type HistoryDrainEnvelope = {
  id: string;
  from: { id: unknown; name?: unknown; role?: unknown };
  [key: string]: unknown;
};

/** The members `HistoryMessage` promises beyond the drain envelope (#1413): a full
 *  `EndpointRef` (`from.name`, and `from.role` only when a string), a finite `ts`, a string
 *  `space`, `parts` the drain could read, and the optional members in their promised shape
 *  when present. Every field the PUBLIC row type promises is checked here, before the row is
 *  returned. A row missing one is dropped, never returned with that member silently
 *  `undefined` under the full type — a consumer reading `msg.ts`, `msg.space`, `msg.parts`
 *  or `msg.from.name` must not be able to reach one that was never there. Nothing is invented
 *  for an absent field.
 *
 *  `parts` is held to READABLE, not to `isMessagePart`: every member must be an object with a
 *  string `kind` (so `partsToText` can read `part.kind` without throwing), but a keyless
 *  `{kind:"data"}` row from a pre-#1404 producer is not dropped — history must surface it.
 *  `mentions`, `replyTo`, and `contextId` keep exactly their `CotalMessage` shapes when
 *  present: an array of strings, a string, a string. */
function isVerifiedHistoryRow(row: HistoryDrainEnvelope): row is HistoryDrainEnvelope & HistoryMessage {
  if (typeof row.from.name !== "string") return false;
  if (row.from.role !== undefined && typeof row.from.role !== "string") return false;
  if (typeof row.ts !== "number" || !Number.isFinite(row.ts)) return false;
  if (typeof row.space !== "string") return false;
  if (!Array.isArray(row.parts) || !row.parts.every(isReadableMessagePart)) return false;
  if (row.mentions !== undefined &&
      (!Array.isArray(row.mentions) || !row.mentions.every((name) => typeof name === "string"))) return false;
  if (row.replyTo !== undefined && typeof row.replyTo !== "string") return false;
  if (row.contextId !== undefined && typeof row.contextId !== "string") return false;
  return true;
}

/** A part `partsToText` can read without throwing: an object with a string `kind` (#1413).
 *  Deliberately weaker than `isMessagePart` — a keyless `{kind:"data"}` part passes here —
 *  because history must surface rows a pre-#1404 producer wrote, not drop them. */
function isReadableMessagePart(value: unknown): boolean {
  return isRecord(value) && typeof value.kind === "string";
}

/**
 * Narrow enough for the type checker and for fail-closed history: object envelope, usable `id`,
 * object `from`. That is what lets `authenticatedMessage` take the row without a cast.
 *
 * Does NOT verify SPEC §5 message shape. It does not require a string `from.id` (the SPEC §5
 * comparison still rejects a mismatch) or exactly one route key. The members the PUBLIC
 * history row promises beyond this envelope — a full EndpointRef `from` (`name`/`role`), a
 * finite `ts`, a string `space` — are checked by {@link isVerifiedHistoryRow} before the row
 * is returned (#1413). Well-formed `parts` still belong to `isCotalMessage` (Plane-3), and
 * history must not use that guard: a publisher now REFUSES a `data` part carrying a non-JSON
 * value, but a keyless `{kind:"data"}` row from a pre-fix producer can still sit in a stream,
 * and history must surface it rather than drop it.
 */
function isHistoryDrainEnvelope(value: unknown): value is HistoryDrainEnvelope {
  return isRecord(value) && isUsableMessageId(value.id) && isRecord(value.from);
}

/** Auth subset of connect() options, shared by the endpoint and isReachable. `bearer` may be a
 *  sync GETTER — nats.js re-evaluates token authenticators per (re)connect attempt, which is how a
 *  refreshing endpoint presents its freshest bearer without rebuilding the connection options. */
interface AuthOpts {
  token?: string;
  user?: string;
  pass?: string;
  /** May be a sync GETTER (like `bearer`) — the authenticator then re-reads it per (re)connect
   *  attempt, which is how a standing-renewal endpoint presents its freshest cred. */
  creds?: string | (() => string);
  /** Observe only the credential actually presented, including native reconnect authentication. */
  onCreds?: (creds: string) => void;
  bearer?: string | (() => string);
  sentinelCreds?: string;
  tls?: boolean;
}

function authOpts(a: AuthOpts) {
  const tls = a.tls ? {} : undefined;
  // USER MODE: present the shared auth-account sentinel creds AND the user bearer as `auth_token` (an
  // authenticator ARRAY — nats.js merges them into one CONNECT). The connect lands in the callout
  // account, which validates the bearer and re-binds the client into the data account with a scoped JWT.
  if (a.bearer) {
    if (a.creds || a.token || a.user || a.pass)
      throw new Error("bearer (user-mode auth) is mutually exclusive with creds/token/user/pass");
    if (!a.sentinelCreds)
      throw new Error("user-mode bearer requires sentinelCreds");
    return {
      authenticator: [nativeCredsAuthenticator(a.sentinelCreds), tokenAuthenticator(a.bearer)],
      tls,
    };
  }
  // creds (JWT/nkey) are mutually exclusive with token/user/pass — reject rather than
  // silently pick one, so a misconfigured caller fails loud.
  if (a.creds) {
    if (a.token || a.user || a.pass)
      throw new Error("creds are mutually exclusive with token/user/pass auth");
    const creds = a.creds;
    // A getter re-wraps per (re)connect attempt so each attempt signs with the freshest cred;
    // nats.js invokes the authenticator function on every attempt, including internal reconnects.
    const authenticator = (nonce?: string) => {
      const presented = typeof creds === "function" ? creds() : creds;
      const authenticated = nativeCredsAuthenticator(presented)(nonce);
      a.onCreds?.(presented);
      return authenticated;
    };
    return { authenticator, tls };
  }
  return { token: a.token, user: a.user, pass: a.pass, tls };
}

/** The bearer's `exp` as epoch ms — what the refresh schedule keys on. A bearer without a numeric
 *  `exp` is structurally unusable for a refreshing endpoint (fail-loud, like the principal decode). */
function bearerExpiryMs(bearer: string): number {
  return bearerLifetimeMs(bearer, 0).expiresAtMs;
}

/** The bearer's lifetime as epoch ms: `iat` to `exp`, starting at `adoptedAtMs` when it carries no
 *  `iat`. */
function bearerLifetimeMs(bearer: string, adoptedAtMs: number): { issuedAtMs: number; expiresAtMs: number } {
  const payload = bearer.split(".")[1];
  if (!payload) throw new Error("user-mode bearer is not a JWT (no payload segment)");
  let claims: { exp?: unknown; iat?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("user-mode bearer payload is not valid base64url JSON");
  }
  if (typeof claims.exp !== "number") throw new Error("user-mode bearer is missing a numeric exp claim");
  const expiresAtMs = claims.exp * 1000;
  return { issuedAtMs: Math.min(typeof claims.iat === "number" ? claims.iat * 1000 : adoptedAtMs, expiresAtMs), expiresAtMs };
}

/** Past this point a held bearer is overdue: its renewal should already have replaced it. */
function bearerRenewalDeadlineMs(bearer: string, adoptedAtMs: number): number {
  const { issuedAtMs, expiresAtMs } = bearerLifetimeMs(bearer, adoptedAtMs);
  return renewalDeadlineMs(issuedAtMs, expiresAtMs);
}

/** A refusal already surfaced once for this outage. The rebuild loop retries it without a notice,
 *  so an endpoint that cannot renew shows one status line rather than one per attempt. */
class RepeatedRefusal extends Error {}

/** Decode the owner+actor PRINCIPAL from a user bearer WITHOUT verifying it — the client trusts its own
 *  bearer only to build its subjects; the broker's minted grant (from the callout, which DOES verify the
 *  bearer) is the real boundary, so a client that lied to itself would just be denied. Per the token
 *  claim semantics the OWNER is the JWT `sub` (`act.owner` merely restates it) and the ACTOR is
 *  `act.actor`. Throws on a structurally-unusable bearer (fail-loud). */
function decodeBearerPrincipal(bearer: string): { owner: string; actor: string } {
  const payload = bearer.split(".")[1];
  if (!payload) throw new Error("user-mode bearer is not a JWT (no payload segment)");
  let claims: { sub?: unknown; act?: { actor?: unknown } };
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("user-mode bearer payload is not valid base64url JSON");
  }
  const owner = claims.sub, actor = claims.act?.actor;
  if (typeof owner !== "string" || typeof actor !== "string")
    throw new Error("user-mode bearer is missing a string sub (owner) / act.actor claim");
  return { owner, actor };
}

/** Turn a raw async-status error into one whose message says *why* — a permission
 *  violation looks like absence unless it's named as a denial. */
function describeStatusError(err: Error): Error {
  if (err instanceof PermissionViolationError) {
    return new Error(
      `NATS permission denied: cannot ${err.operation} "${err.subject}" - check this ` +
        `endpoint's ACLs (a denied peer looks "absent" rather than blocked)`,
      { cause: err },
    );
  }
  return err;
}

/** The ordered consumer behind a KV watch, which nats.js keeps on the iterator and the KV types hide. */
function kvWatchConsumer(iter: Awaited<ReturnType<KV["watch"]>>): PushConsumer {
  const consumer = (iter as { _data?: PushConsumer })._data;
  if (!consumer) throw new Error("KV watch carries no consumer - the pinned nats.js changed shape");
  return consumer;
}

/** True ONLY for a denial on a **publish** — the single case that proves the message was never
 *  ACCEPTED or stored. (Not "never reached the server": the server necessarily received enough of
 *  it to reject it. The distinction matters precisely here, because this helper exists to separate
 *  provably-not-stored from possibly-stored, and the looser phrasing overstates the very thing
 *  being measured.) {@link isPermissionDenied} deliberately does not look at the operation: it exists to
 *  separate "denied" from "service down", and that answer is the same either way. The operation
 *  matters enormously to a caller that reports *delivery*, because a JetStream publish is
 *  request/PubAck and the subscription half is the reply inbox — a denial THERE rejects
 *  `js.publish()` while the stream may already hold the message. Verified against a live broker: a
 *  user allowed to publish but denied its `_INBOX` subscription got
 *  `Permissions Violation for Subscription to "_INBOX.….*"` back from `js.publish()`, and an
 *  unrestricted observer then read `messages: 1` off the stream.
 *
 *  Note what is deliberately NOT accepted: the untyped text fallback above. A permission-shaped
 *  message string carries no operation, so it cannot prove non-delivery, and guessing "publish"
 *  from wording would reintroduce exactly the false certainty this exists to prevent. Anything not
 *  provably a publish denial is unknown, and a caller reporting delivery must fail toward
 *  "I could not confirm" rather than toward "it did not happen" — the costly mistake is telling
 *  someone to re-send a message that was in fact stored. */
export function isPublishPermissionDenied(e: unknown): boolean {
  const typed =
    e instanceof PermissionViolationError
      ? e
      : (e as { cause?: unknown } | null)?.cause instanceof PermissionViolationError
        ? ((e as { cause: PermissionViolationError }).cause)
        : undefined;
  return typed?.operation === "publish";
}

/** Whether a server list dials over websocket: the FIRST entry's scheme decides (one list, one
 *  transport — a mixed tcp+ws list would race two transports over one identity). */
export function wsServers(servers: string): boolean {
  return /^wss?:\/\//i.test((servers.split(",")[0] ?? "").trim());
}

/** Default probe budget by TRANSPORT. 1s was tuned for the loopback/LAN TCP brokers every local
 *  probe dials; a ws(s) broker is by definition published through an HTTPS edge (CDN tunnel,
 *  reverse proxy), where TLS + upgrade + INFO + the auth round-trip routinely exceeds 1s cold —
 *  measured ~60% spurious "not reachable" against a Cloudflare-fronted broker. Callers passing an
 *  explicit `timeoutMs` are untouched.
 *
 *  EXPORTED because a caller that judges a probe by WHEN it answered has to compare against the
 *  deadline this function actually handed the probe. The delivery watchdog does exactly that, and
 *  hardcoding 1000 there silently misread every ws broker: honest refusals arrive at 2-5s, past a
 *  budget that was never theirs, and would be classified as this process's starvation rather than
 *  the server's refusal. The budget and the judgment must come from one place. */
export function defaultProbeTimeoutMs(servers: string): number {
  return wsServers(servers) ? 5000 : 1000;
}

/** Pick the dial function by SCHEME: `ws://`/`wss://` servers go through nats-core's
 *  `wsconnect` (the websocket transport - e.g. a broker published through an HTTPS edge at
 *  `wss://host/path`), everything else through the TCP transport. The websocket dial OWNS its
 *  transport options: a required TLS connection refuses any `ws://` target before dialing.
 *  `wss://` performs TLS itself, and the w3c transport refuses a `tls` block outright
 *  ("'tls' is not configurable"), so the block is removed after that check.
 *  A TCP dial that requires TLS to one IP address names that address as the host its certificate
 *  must cover (see {@link withDialedTlsHost}). */
export function dialerFor(servers: string): typeof connect {
  if (!wsServers(servers)) return ((opts?: Parameters<typeof connect>[0]) => connect(withDialedTlsHost(servers, opts))) as typeof connect;
  return ((opts: Parameters<typeof connect>[0]) => {
    const { tls, ...rest } = (opts ?? {}) as Record<string, unknown>;
    const targets = Array.isArray(rest.servers) ? rest.servers : String(rest.servers ?? servers).split(",");
    if (tls && targets.some((target) => !/^wss:\/\//i.test(String(target).trim())))
      return Promise.reject(new Error("TLS-required WebSocket connections must use wss:// for every server"));
    return (wsconnect as unknown as typeof connect)(rest as Parameters<typeof connect>[0]);
  }) as typeof connect;
}

/** `opts` for a dial to `servers`, with the IP address it names as the host a TLS certificate must
 *  cover when the dial requires TLS: a `tls` block, or a `tls://` address. The TCP transport upgrades
 *  to TLS with no server name for an IP, and Node then checks the certificate against "localhost":
 *  a certificate for the dialed address alone is refused, and one naming localhost passes for any
 *  address. A dial that does not require TLS keeps its options, because a `tls` block refuses a
 *  plaintext broker, and so does a list of several servers, whose one host the options cannot name. */
function withDialedTlsHost(servers: string, opts: Parameters<typeof connect>[0]): Parameters<typeof connect>[0] {
  const urls = servers.split(",").map((url) => url.trim()).filter(Boolean);
  const tls = opts?.tls;
  if (urls.length !== 1 || tls === null || tls === undefined && !/^tls:\/\//i.test(urls[0]!)) return opts;
  let host: string;
  try { ({ host } = hostPort(urls[0]!)); } catch { return opts; }
  // Node checks an upgraded socket's certificate against `host` when no server name is set.
  return isIP(host) ? { ...opts, tls: { host, ...tls } as NonNullable<typeof tls> } : opts;
}

/** Parse a NATS server URL (`nats://host:port`, `host:port`, a bare host, or a comma list — the
 *  first entry wins) into a host+port for {@link tcpInfoProbe}. Defaults the port to 4222. */
function hostPort(server: string): { host: string; port: number } {
  const raw = (server.split(",")[0] ?? "").trim();
  const scheme = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  const first = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // strip scheme
  const u = new URL(`http://${first}`); // http:// so .hostname/.port resolve (incl. bracketed IPv6)
  // A websocket broker rides the web's ports, not NATS's: `wss://host/path` reaches TCP 443.
  const fallback = scheme === "wss" ? 443 : scheme === "ws" ? 80 : 4222;
  return { host: u.hostname, port: u.port ? Number(u.port) : fallback };
}

/** Silent credless liveness probe. Opens a plain TCP connection and confirms a NATS server is there
 *  by reading its UNPROMPTED `INFO {…}` greeting — which the server sends on accept, BEFORE the
 *  client's CONNECT/auth (per the NATS client protocol) — then closes immediately without
 *  authenticating. Since it never sends CONNECT, an auth broker has nothing to reject, so this emits
 *  NO broker-side auth-error/auth-timeout log line (unlike a credless `connect()`, which an auth
 *  broker rejects and logs). It is a *plaintext NATS* liveness check only:
 *    • a TLS-first (`handshake_first`, NATS ≥ 2.10.4) listener sends its TLS handshake before INFO,
 *      so the read won't match → returns false (a documented false-negative for that broker config);
 *    • a non-NATS listener never sends a valid `INFO {` → also false, and a silent one resolves
 *      `"silent"` (we require the real greeting, never "any open port is reachable").
 *  Closes well within the server's ~1s authorization timeout, so it cannot trip a timeout log.
 *  A live server resolves to what its greeting said about auth. A peer that accepted the connection
 *  and sent no full line before the deadline, as a stopped or overloaded broker does, resolves
 *  `"silent"`; anything else resolves `false`. */
function tcpInfoProbe(server: string, timeoutMs: number): Promise<false | "silent" | { authRequired: boolean }> {
  return new Promise<false | "silent" | { authRequired: boolean }>((resolve) => {
    let socket: ReturnType<typeof createConnection> | undefined;
    let done = false;
    let connected = false;
    const finish = (live: false | "silent" | { authRequired: boolean }) => {
      if (done) return;
      done = true;
      try { socket?.destroy(); } catch { /* already gone */ }
      resolve(live);
    };
    let host: string, port: number;
    try { ({ host, port } = hostPort(server)); } catch { return resolve(false); }
    socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\r\n");
      if (nl === -1) { if (buf.length > 4096) finish(false); return; } // no real INFO line is 4KB+
      const line = buf.slice(0, nl);
      const brace = line.indexOf("{"); // greeting is `INFO {json}` (the server appends a trailing space)
      if (!/^INFO\b/.test(line) || brace === -1) return finish(false); // not NATS (incl. a TLS-first handshake)
      try { finish({ authRequired: (JSON.parse(line.slice(brace)) as { auth_required?: unknown })?.auth_required === true }); } // require a real INFO greeting, not arbitrary bytes
      catch { finish(false); }
    });
    socket.on("connect", () => { connected = true; });
    socket.on("timeout", () => finish(connected ? "silent" : false));
    socket.on("error", () => finish(false)); // refused / reset / DNS failure
    socket.on("close", () => finish(false)); // closed before a full INFO line arrived
  });
}

/** Bounded TCP reachability on a socket we OWN: does a handshake to `server` complete within
 *  `timeoutMs`? Deliberately narrower than {@link tcpInfoProbe} — it asks only whether the
 *  transport can be reached, never whether NATS is speaking there, so the TLS-first listener that
 *  `tcpInfoProbe` reports false for still passes this gate and goes on to a real connect.
 *
 *  It exists because `connect()` cannot be trusted to release a connection it never established.
 *  `@nats-io/transport-node`'s `NodeTransport.dial()` keeps its socket in a local until the
 *  handshake resolves (`this.socket = await this.dial(hp)`), so `this.socket` is STILL UNDEFINED
 *  when the client's own connect timeout wins the race in `protocol.ts`'s `dial` and the catch
 *  calls `transport.close()` — whose teardown is `this.socket?.destroy()`, i.e. a destroy of
 *  nothing. Against an address that BLACKHOLES (SYN unanswered) rather than REFUSES (RST), the
 *  socket is orphaned in libuv until the OS SYN timeout, and the process cannot exit for minutes
 *  after the probe already returned its answer. That is issue #389, and it is upstream: nothing a
 *  caller passes (`reconnect: false`, `timeout`) reaches the orphan. Our socket, our `destroy()`,
 *  on every exit path — never an `unref`/force-exit, which would hide the symptom and a future
 *  real hang with it. A second orphan case (#2156) needs a greeting, not just a handshake, so it is
 *  gated by {@link tcpInfoProbe} instead wherever the dial will be plaintext. */
function tcpDialable(server: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let socket: ReturnType<typeof createConnection> | undefined;
    let done = false;
    const finish = (dialable: boolean) => {
      if (done) return;
      done = true;
      try { socket?.destroy(); } catch { /* already gone */ }
      resolve(dialable);
    };
    let host: string, port: number;
    try { ({ host, port } = hostPort(server)); } catch { return resolve(false); }
    socket = createConnection({ host, port });
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => finish(true));
    socket.on("timeout", () => finish(false)); // blackhole: SYN unanswered inside our deadline
    socket.on("error", () => finish(false)); // refused / reset / DNS failure
    socket.on("close", () => finish(false));
  });
}

/** Whether a failed connect was the server refusing these credentials: a server answered, so it is
 *  up. The same errors {@link isReachable} reads as up after its own authenticated connect. */
export function isAuthRejection(e: unknown): boolean {
  return e instanceof AuthorizationError || e instanceof UserAuthenticationExpiredError;
}

/** The wait a credential source asked for with a numeric `retryAfterSeconds` on its error, in
 *  milliseconds, or 0. */
function retryAfterMs(e: unknown): number {
  const seconds = (e as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
}

/** Whether a NATS server is *running* at `servers`. With NO creds this is a SILENT plaintext
 *  liveness check ({@link tcpInfoProbe}): it reads the server's pre-auth `INFO` greeting and closes
 *  WITHOUT authenticating, so a live broker (open OR auth — INFO precedes auth) returns true while
 *  emitting no broker auth-error log. It may return false for a TLS-first listener — the credless
 *  probe is plaintext-only. With creds/token/tls supplied it is instead the AUTHORITATIVE identity
 *  check: a real authenticated connect, true on success AND on an auth rejection (a server that
 *  refuses these creds is still up — so the caller surfaces the real auth failure, and `up` won't
 *  start a duplicate on the bound port). Only a genuine connection failure (refused/timeout) is false. */
export async function isReachable(
  servers: string = DEFAULT_SERVER,
  opts: AuthOpts & { timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? defaultProbeTimeoutMs(servers);
  if (!opts.creds && !opts.token && !opts.user && !opts.pass && !opts.tls) {
    // A websocket broker rides an HTTPS edge: the plaintext INFO probe reads TLS bytes and
    // declares a perfectly live broker down (which then blocks spawn/connect with a wrong
    // remedy). Dial the ws transport credless instead — an auth broker REJECTING the bare
    // connect still proves it is there, the same reading the authed branch below gives its
    // catch. Costs one broker-side auth-error log line per probe, which the INFO probe was
    // designed to avoid; on a ws broker there is no silent alternative.
    if (wsServers(servers)) {
      try {
        const nc = await dialerFor(servers)({ servers, timeout: timeoutMs, reconnect: false, maxReconnectAttempts: 0 });
        await nc.close();
        return true;
      } catch (e) {
        return e instanceof AuthorizationError || e instanceof UserAuthenticationExpiredError;
      }
    }
    return typeof (await tcpInfoProbe(servers, timeoutMs)) === "object";
  }
  // The credless branch above already owns its socket. This one reaches `connect()`, so it carries
  // the same orphaned-socket defects probeConnect did (#389, and the slow-greeting case #2156) and
  // takes the same gate choice: reach the address on a socket we own first, requiring the NATS
  // greeting for a plaintext dial (the upstream transport orphans a socket whose handshake
  // completed but whose greeting came late) and only the handshake for a TLS-required or websocket
  // dial (no plaintext greeting to read), then give `connect()` the remainder of the budget its own
  // timeout always covered. A gate failure is a genuine connection failure, which is exactly the
  // `false` the catch below already returns for one — an auth rejection cannot reach us from an
  // address that never completed a handshake.
  const started = Date.now();
  const gate = opts.tls || wsServers(servers) ? tcpDialable : tcpInfoProbe;
  const reached = await gate(servers, timeoutMs);
  if (!reached || reached === "silent") return false;
  try {
    const nc = await dialerFor(servers)({
      servers,
      timeout: Math.max(1, timeoutMs - (Date.now() - started)),
      reconnect: false,
      maxReconnectAttempts: 0,
      ...authOpts(opts),
    });
    await nc.close();
    return true;
  } catch (e) {
    return e instanceof AuthorizationError || e instanceof UserAuthenticationExpiredError;
  }
}

/** What a connect attempt told us about the server — the distinction {@link isReachable} flattens.
 *  `auth-required` means a server answered but rejected these creds (so it IS up); `stale-auth`
 *  means the PRESENTED CREDENTIAL ITSELF is dead — expired by its bounded lifetime, either because
 *  the broker said "authentication expired" or because the cred is LOCALLY PROVABLY expired (its own
 *  JWT `exp` is past). The local check is decided without a round-trip, so a slow or failed connect
 *  never downgrades a dead cred to `unreachable`; the repair is `doctor auth` either way, never a
 *  registry prune (the D5 credential-death event). `unreachable` means nothing usable answered and
 *  the cred is not provably dead (refused / timeout / a stale registry entry). `timeout` means the
 *  dial ran out of its own budget before anything conclusive came back — never a trust or credential
 *  verdict, just "try again with more time" (#851). `inferred` marks an `auth-required` read from
 *  the broker's greeting rather than from a rejection: the greeting asked for auth and the handshake
 *  was then reset. The greeting is unauthenticated, so that verdict may name a failure but must never
 *  be grounds for deleting state. */
export type ProbeResult =
  | { ok: true }
  | { ok: false; reason: "auth-required"; inferred?: true }
  | { ok: false; reason: "stale-auth" }
  | { ok: false; reason: "unreachable" }
  | { ok: false; reason: "tls-unsupported" }
  | { ok: false; reason: "timeout" };

/** Like {@link isReachable}, but distinguishes "up but won't take these creds" from "nothing there".
 *  `spawn` needs the difference: auth-required → name the trust dir + next step; unreachable → the
 *  mesh is down (prune the stale entry, tell the user to `cotal up`). Pass `creds` to confirm a
 *  specific identity is accepted (`ok`); omit them to probe mere liveness (an auth broker answers
 *  `auth-required`, which still proves it's up). */
export async function probeConnect(
  server: string = DEFAULT_SERVER,
  opts: AuthOpts & { timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? defaultProbeTimeoutMs(server);
  const started = Date.now();
  // Reach the address on a socket we own BEFORE handing it to `connect()`, which orphans the
  // connection it never established (see {@link tcpDialable} for the upstream mechanism, #389,
  // and {@link tcpInfoProbe} for the second orphan case below, #2156). For a plaintext dial the
  // gate must see the server's NATS greeting, not just the handshake: `connect()`'s own timeout
  // can fire while it is still waiting on that greeting, and the upstream transport only destroys
  // a socket whose handshake never completed, not one whose greeting came late (`_closed`'s guard
  // on `connected`, which is set only after the greeting is read) — so `tcpInfoProbe` (which owns
  // its socket and requires the greeting) is the gate there, while a TLS-required or websocket
  // dial has no plaintext greeting to read and keeps the handshake-only `tcpDialable` gate. This
  // cannot change any verdict: every address that gets past here had to complete a TCP handshake
  // for `connect()` to have gotten anywhere either, and a gate failure is routed through the SAME
  // classification the catch uses — so a locally-dead cred is still `stale-auth` and not silently
  // downgraded to `unreachable` by the address being dark. The cost is one extra handshake (and,
  // off TLS/ws, one extra greeting read) on the reachable path; the deadline below is the
  // REMAINDER of the budget, because `connect()`'s own `timeout` always covered its handshake too.
  const gate = opts.tls || wsServers(server) ? tcpDialable : tcpInfoProbe;
  const greeting = await gate(server, timeoutMs);
  if (!greeting) return classifyProbeFailure(undefined, opts);
  // A peer that took the connection and never greeted is there but not answering, as a stopped or
  // overloaded broker is. That is the same latency verdict as a dial that ran out of its budget.
  if (greeting === "silent") return classifyProbeFailure(undefined, opts, false, "timeout");
  try {
    const nc = await dialerFor(server)({
      servers: server,
      timeout: Math.max(1, timeoutMs - (Date.now() - started)),
      reconnect: false,
      maxReconnectAttempts: 0,
      ...authOpts(opts),
    });
    await nc.close();
    return { ok: true };
  } catch (e) {
    return classifyProbeFailure(e, opts, greeting !== true && greeting.authRequired);
  }
}

/** Why a {@link probeConnect} attempt did not end in `ok`. Shared by the pre-connect reachability
 *  gate and the connect catch so both classify identically — the gate must never turn a diagnosable
 *  credential death into a bare `unreachable` just because the address went dark.
 *
 *  A presented cred that is PROVABLY expired by its own JWT is stale-auth (credential death) — and
 *  that is knowable LOCALLY, without the network, so it is decided FIRST, before the error type. On
 *  the wire the broker's rejection and the socket close race: a slow CI/Windows handshake can
 *  surface a bare transport failure (→ "unreachable") instead of a clean AuthorizationError, which
 *  used to misclassify a dead cred. Reading the cred removes that timing dependency entirely, so the
 *  classification is deterministic. Unreadable content falls through to the wire truth (no false
 *  stale diagnosis from garbage). `e` is undefined when the gate refused before any connect.
 *  `authRequired` is true when the gate read a greeting that asked for auth. `otherwise` is the
 *  verdict when nothing more specific applies. */
function classifyProbeFailure(e: unknown, opts: AuthOpts, authRequired = false, otherwise: "unreachable" | "timeout" = "unreachable"): ProbeResult {
  if (typeof opts.creds === "string") {
    try {
      if (inspectCredHealth(opts.creds).state === "expired") return { ok: false, reason: "stale-auth" };
    } catch { /* not introspectable — keep the wire truth */ }
  }
  if (e instanceof UserAuthenticationExpiredError) return { ok: false, reason: "stale-auth" };
  // The broker answered but rejected these creds (so it IS up) — auth-required, not stale-auth.
  if (e instanceof AuthorizationError) return { ok: false, reason: "auth-required" };
  // A dial that ran out of its own budget is neither a refusal nor a dead broker — it is latency,
  // and grading it `unreachable` made a TLS-required target read as a trust failure (#851). Only
  // nats-core's TimeoutError means that: a peer's `-ERR` that mentions a timeout answered at once.
  if (e instanceof TimeoutError) return { ok: false, reason: "timeout" };
  // The native client read a greeting without TLS support and refused the TLS requirement.
  // That is a transport mismatch, not an unreachable listener or proof of mesh identity.
  if (e instanceof ConnectionError && e.message === "server does not support 'tls'")
    return { ok: false, reason: "tls-unsupported" };
  // A broker that greeted us asking for auth and then reset the handshake most likely refused it.
  // Windows can discard its `-ERR 'Authorization Violation'` when the reset lands, so the client
  // sees only ECONNRESET, and a running auth broker used to read as gone. No rejection was read, so
  // the verdict is marked inferred.
  if (authRequired && (e as { code?: unknown } | undefined)?.code === "ECONNRESET") return { ok: false, reason: "auth-required", inferred: true };
  return { ok: false, reason: otherwise };
}
