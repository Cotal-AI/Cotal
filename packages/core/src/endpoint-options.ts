// The endpoint's options, the validation that resolves them into its identity, its public types and
// errors, and the history page fitter, moved verbatim from endpoint.ts. endpoint.ts re-exports the names
// it exported before, so the package's export set is unchanged.
import { randomUUID } from "node:crypto";
import type { NatsConnection } from "@nats-io/transport-node";
import type { AgentCard, ChannelMode, CotalMessage, Delivery, MessageMeta } from "./types.js";
import type { ClusterDocument } from "./endpoint-cluster.js";
import type { EpPrincipalCommandDef, EpPrincipalServeHandle } from "./endpoint-serve.js";
import type { EpPrincipal } from "./endpoint-subjects.js";
import { DELIVERY_LIMIT_HEADER, PLANE3_MAX_MSGS_PER_SUBJECT } from "./backup-config.js";
import { assertValidName } from "./resolve.js";
import { assertValidKind } from "./agent-file.js";
import { idFromCreds } from "./identity.js";
import { DEFAULT_SERVER, decodeBearerPrincipal } from "./endpoint-dial.js";
import { assertGeneration } from "./endpoint-subjects.js";
import { endpointUserInboxId, type EndpointIdentity } from "./endpoint-identity.js";
import type { CredentialState } from "./endpoint-credential-state.js";
import { assertLifecycleToken, assertValidRole, DEV_OWNER, mintLifecycleUid, principalKey } from "./subject-grammar.js";

/** Takes a daemon answers at once; one more is refused as busy, so the holder keeps its copy and
 *  asks again rather than queueing work the daemon cannot bound. */
export const MAX_TAKES_IN_FLIGHT = 64;
/** How often the daemon runs the anycast records maintenance pass. */
export const ANYCAST_SWEEP_MS = 10 * 60 * 1000;
/** How long a holder waits for the daemon to answer a take. */
export const ANYCAST_TAKE_TIMEOUT_MS = 5_000;

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

/** The default idle lifetime of a self-created open-space DM inbox. */
export const DEFAULT_OPEN_DM_INACTIVE_MS = 600_000;

/** The longest delay `setTimeout` honors, 2^31-1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;

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
  /** Mark native subscriptions as observer taps, not live membership. Does not change access. */
  omitFromLiveMembership?: boolean;
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

/** Validate the card and the auth options and write the endpoint's principal into `identity` and its
 *  first credential into `cred`: owner, actor, connection id, lifecycle UID, backfill floor, accepted
 *  token and the card it presents. Throws on the first option it refuses. */
export function resolveEndpointPrincipal(opts: EndpointOptions, identity: EndpointIdentity, cred: CredentialState): void {
  /** Did the dev/static branch fall through to a random connId? Set on every path that assigns
   *  `connId` so the ephemeral verdict below can never read an unassigned value. */
  let selfMintedConnId = false;
  identity.space = opts.space;
  identity.omitFromLiveMembership = opts.omitFromLiveMembership === true;
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
    // on it; the client builds the connId from the bearer's principal and a random nonce.
    // It sends that as the connect `name`. `card.id`, if given, must match the bearer.
    identity.userMode = true;
    if (typeof opts.bearer === "function") {
      // Bearer SOURCE: no token exists yet, so the principal must be declared up front; every
      // fetched bearer is checked against it (refreshBearer), keeping the card honest for life.
      if (!opts.card.owner || !opts.card.actor)
        throw new Error("a bearer source requires explicit card.owner + card.actor (no bearer to derive them from at construction)");
      identity.owner = opts.card.owner;
      identity.actor = opts.card.actor;
      identity.bearerSource = opts.bearer;
    } else {
      const claims = decodeBearerPrincipal(opts.bearer);
      if (opts.card.owner && opts.card.owner !== claims.owner)
        throw new Error(`card.owner ${opts.card.owner} != bearer owner ${claims.owner}`);
      if (opts.card.actor && opts.card.actor !== claims.actor)
        throw new Error(`card.actor ${opts.card.actor} != bearer actor ${claims.actor}`);
      identity.owner = claims.owner;
      identity.actor = claims.actor;
      cred.currentBearer = opts.bearer;
    }
    identity.connId = endpointUserInboxId(identity.owner, identity.actor, identity.omitFromLiveMembership);
    identity.sentinelCreds = opts.sentinelCreds;
    // User mode's actor is SERVER-AUTHORED (bearer claims or a declared card checked against
    // them), never self-minted. Only the inbox nonce is ephemeral.
    identity.actorIsEphemeral = false;
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
      identity.credsSource = opts.creds;
      identity.connId = opts.card.id;
      selfMintedConnId = false;
    } else {
      const credId = opts.creds ? idFromCreds(opts.creds) : undefined;
      if (opts.card.id && credId && opts.card.id !== credId)
        throw new Error(`card.id ${opts.card.id} != creds identity ${credId} - they must be the same nkey`);
      cred.currentCreds = opts.creds;
      selfMintedConnId = opts.card.id === undefined && credId === undefined;
      identity.connId = opts.card.id ?? credId ?? randomUUID().replace(/-/g, "");
    }
    identity.owner = opts.card.owner ?? DEV_OWNER;
    identity.actor = opts.card.actor ?? identity.connId;
    // The actor is EPHEMERAL only when it inherited a self-minted connId — a declared `card.actor`
    // is stable even on an otherwise identity-less connection. Recorded here, at the one site the
    // fallback fires, so no caller has to re-derive the precedence rule from the outside.
    identity.actorIsEphemeral = opts.card.actor === undefined && selfMintedConnId;
  }
  // The incarnation's lifecycle UID (SPEC §13.1). AUTH mode (JWT creds/bearer) REQUIRES the
  // launcher to supply it — the dm/dlv/chathist durable names must match the exact names the
  // provisioner minted into the credential, so a self-minted uid would name a durable the cred
  // cannot bind; absent, `requireLifecycleUid` fails loud at the first consuming path. OPEN/token
  // mode is self-identifying (one process is one lifecycle, no provisioner, no ledger, no
  // same-alias respawn), so it mints its OWN uid here exactly as it self-assigns `connId`/`actor`
  // — NOT an alias fallback (a fresh CSPRNG uid), just the open-mode identity source.
  identity.ownLifecycleUid =
    opts.lifecycleUid !== undefined
      ? assertLifecycleToken(opts.lifecycleUid)
      : Boolean(cred.currentCreds || identity.credsSource) || identity.userMode
        ? undefined
        : mintLifecycleUid();
  if (opts.backfillFloor !== undefined) {
    if (!Number.isInteger(opts.backfillFloor) || opts.backfillFloor < 0)
      throw new Error(`EndpointOptions.backfillFloor must be a non-negative integer stream sequence, got ${opts.backfillFloor}`);
    identity.backfillFloor = opts.backfillFloor;
  }
  if (opts.acceptedToken !== undefined) {
    if (!opts.creds) throw new Error("EndpointOptions.acceptedToken names a static issuance and needs creds beside it (SPEC 13.15)");
    identity.acceptedToken = assertGeneration(opts.acceptedToken, "acceptedToken");
  }
  // `card.id` is the principal DOT-FORM `<owner>.<actor>` — the wire identity every `from.id` carries;
  // principalKey validates both tokens.
  const principal = principalKey(identity.owner, identity.actor);
  identity.card = { ...opts.card, id: principal.key, owner: identity.owner, actor: identity.actor };
}

/** Validate the connection, delivery and DM-only options and write them into `identity`. Runs after
 *  {@link resolveEndpointPrincipal}, whose writes decide whether the endpoint is authenticated and
 *  whether it holds a lifecycle UID. Throws on the first option it refuses. */
export function resolveEndpointSettings(opts: EndpointOptions, identity: EndpointIdentity, cred: Readonly<CredentialState>): void {
  identity.servers = opts.servers ?? DEFAULT_SERVER;
  identity.token = opts.token;
  identity.user = opts.user;
  identity.pass = opts.pass;
  identity.tls = opts.tls ?? false;
  for (const [label, value] of [["transportPingIntervalMs", opts.transportPingIntervalMs], ["transportMaxPingOut", opts.transportMaxPingOut], ["transportConnectTimeoutMs", opts.transportConnectTimeoutMs]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0))
      throw new Error(`EndpointOptions.${label} must be a positive safe integer`);
  }
  if ((opts.transportPingIntervalMs === undefined) !== (opts.transportMaxPingOut === undefined))
    throw new Error("EndpointOptions transportPingIntervalMs and transportMaxPingOut must be configured together");
  identity.onConnection = opts.onConnection;
  identity.overlapOnConnectionRenewal = opts.overlapOnConnectionRenewal === true;
  identity.beforeBind = opts.beforeBind;
  identity.transportPingIntervalMs = opts.transportPingIntervalMs ?? 10_000;
  identity.transportMaxPingOut = opts.transportMaxPingOut ?? 2;
  identity.transportConnectTimeoutMs = opts.transportConnectTimeoutMs;
  // No implicit channel: an endpoint reads exactly what its caller lists. Omitted means none.
  identity.channels = opts.channels ?? [];
  identity.allowSubscribe = opts.allowSubscribe;
  identity.heartbeatMs = opts.heartbeatMs ?? 2000;
  identity.ttlMs = opts.ttlMs ?? 6000;
  identity.doRegister = opts.registerPresence ?? true;
  identity.doWatch = opts.watchPresence ?? true;
  identity.doWatchChannels = opts.watchChannels ?? true;
  identity.doConsume = opts.consume ?? true;
  identity.readOnce = opts.readOnce ?? false;
  if (identity.readOnce && (identity.doConsume || identity.doRegister))
    throw new Error("EndpointOptions.readOnce requires consume and registerPresence false: a one-time read cannot keep a consumer's channel cache or its own presence current");
  if (opts.dmOnly !== undefined) {
    if (typeof opts.dmOnly.handler !== "function")
      throw new Error("EndpointOptions.dmOnly.handler must be a function");
    const settle = opts.dmOnly.settleTimeoutMs;
    if (settle !== undefined && (!Number.isSafeInteger(settle) || settle <= 0))
      throw new Error("EndpointOptions.dmOnly.settleTimeoutMs must be a positive safe integer");
    if (!(Boolean(cred.currentCreds || identity.credsSource) || identity.userMode))
      throw new Error("EndpointOptions.dmOnly requires creds or a bearer: it binds a provisioned durable and never creates one");
    if (!identity.doConsume || identity.doRegister || identity.doWatch || identity.doWatchChannels || identity.readOnce)
      throw new Error("EndpointOptions.dmOnly requires consume true and registerPresence, watchPresence, watchChannels and readOnce false");
    if (identity.channels.length || opts.card.role || opts.acceptedToken !== undefined)
      throw new Error("EndpointOptions.dmOnly takes no channels, role or acceptedToken: the endpoint reads only its own DM durable");
    if (!identity.ownLifecycleUid)
      throw new Error(
        "EndpointOptions.dmOnly requires this endpoint's lifecycleUid (EndpointOptions.lifecycleUid): dm/dlv/chathist broker resources are lifecycle-keyed names (SPEC 13.1)",
      );
    identity.dmOnly = opts.dmOnly;
  }
  identity.ackWaitMs = opts.ackWaitMs ?? 60_000;
  identity.inactiveThresholdMs = opts.inactiveThresholdMs ?? DEFAULT_OPEN_DM_INACTIVE_MS;
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

/** What {@link CotalEndpoint.servePrincipal} keeps to re-bind on every replaced connection. */
export interface PrincipalServeIntent {
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
