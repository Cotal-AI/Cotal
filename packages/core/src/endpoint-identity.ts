// The identity and configuration a CotalEndpoint fixes at construction, held by one object that the
// endpoint's internal parts read by reference. Not re-exported by the index.
import type { DmOnlyOptions } from "./endpoint-options.js";
import type { AgentCard } from "./types.js";
import type { NatsConnection } from "@nats-io/transport-node";
import { assertInboxConnId, userInboxConnId } from "./subject-grammar.js";

export const OBSERVER_CONN_NAME_PREFIX = "cotal:observer/";
export const OBSERVER_INBOX_NONCE_PREFIX = "ibx_observer_";
const BOUND_OBSERVER_MARKER = "_";

/** Mark the nonce, not the principal. The single extra character keeps the stock observer name
 *  within the legacy 120-character limit for a 64-character actor. */
export function endpointUserInboxId(owner: string, actor: string, observer: boolean): string {
  const name = userInboxConnId(owner, actor);
  if (!observer) return name;
  const nonceAt = name.lastIndexOf("-") + 1;
  return assertInboxConnId(`${name.slice(0, nonceAt)}${BOUND_OBSERVER_MARKER}${name.slice(nonceAt)}`);
}

export function isBoundObserverInbox(name: string | undefined, principal: string): boolean {
  const prefix = `${principal.replace(".", "-")}-${BOUND_OBSERVER_MARKER}`;
  return name?.startsWith(prefix) === true && /^[a-z0-9]{25}$/.test(name.slice(prefix.length));
}

/** Written only by the `CotalEndpoint` constructor; every part takes it as `Readonly`. A part must not
 *  read it in its own constructor, because the endpoint's constructor fills it after the parts are
 *  constructed. */
export interface EndpointIdentity {
  /** The card the endpoint presents; its `meta` and `name` are updated in place. */
  card: AgentCard;
  /** The space every subject is scoped to. */
  space: string;
  /** The channels the endpoint reads; joins and leaves edit this array in place. */
  channels: string[];
  /** True when {@link actor} was self-minted at construction (see `CotalEndpoint.actorIsEphemeral`). */
  actorIsEphemeral: boolean;
  allowSubscribe?: string[];
  servers: string;
  token?: string;
  user?: string;
  pass?: string;
  /** The creds source, when standing renewal is on (bounded supervisor/daemon creds); undefined for
   *  a static string. Mirrors {@link bearerSource} exactly — same fetch-ahead + pin + retry shape. */
  credsSource?: () => Promise<string>;
  /** True in user mode (bearer string OR source) — gates the callout-shaped connect. */
  userMode: boolean;
  /** The bearer source, when auth refreshes (spawned agents); undefined for a one-shot string. */
  bearerSource?: () => Promise<string>;
  sentinelCreds?: string;
  tls: boolean;
  transportPingIntervalMs?: number;
  transportMaxPingOut?: number;
  transportConnectTimeoutMs?: number;
  heartbeatMs: number;
  ttlMs: number;
  doRegister: boolean;
  omitFromLiveMembership: boolean;
  readChannelRoutingProjection?: boolean;
  doWatch: boolean;
  doWatchChannels: boolean;
  readOnce: boolean;
  doConsume: boolean;
  dmOnly?: DmOnlyOptions;
  ackWaitMs: number;
  inactiveThresholdMs: number;
  onConnection?: (nc: NatsConnection) => void;
  overlapOnConnectionRenewal: boolean;
  beforeBind?: () => Promise<void>;
  /** The connection's authenticated nkey — dev: the creds' identity; user mode: the per-connection
   *  ephemeral. Distinct from the {@link owner}+{@link actor} principal: it names the CONNECTION (the
   *  broker-authenticated user), and scopes the private reply inbox (`_INBOX_<connId>`) + the credId
   *  equality check. The principal (owner+actor) is what the WIRE grammar and every per-agent key use. */
  connId: string;
  /** This endpoint's owner token (principal half 1) — `"local"` in the dev default. */
  owner: string;
  /** This endpoint's actor token (principal half 2) — the connection id in the dev default. */
  actor: string;
  /** This incarnation's lifecycle UID (opts.lifecycleUid) — see {@link EndpointOptions.lifecycleUid}. */
  ownLifecycleUid?: string;
  /** See {@link EndpointOptions.backfillFloor}. */
  backfillFloor?: number;
  acceptedToken?: string;
}
