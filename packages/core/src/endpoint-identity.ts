// The identity and configuration a CotalEndpoint fixes at construction, held by one object that the
// endpoint's internal parts read by reference. Not re-exported by the index.
import type { DmOnlyOptions } from "./endpoint-options.js";
import type { AgentCard } from "./types.js";
import type { NatsConnection } from "@nats-io/transport-node";

/** Written only by the `CotalEndpoint` constructor; every part takes it as `Readonly`. */
export interface EndpointIdentity {
  /** The card the endpoint presents; its `meta` is updated in place. */
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
