// The connection a CotalEndpoint holds and every handle opened on it, in one object the endpoint's
// internal parts read by reference. Not re-exported by the index.
import type { NatsConnection } from "@nats-io/transport-node";
import type { JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import type { IssuedSubjectPermission } from "./issued-authority.js";
import type { MembershipFeedWatch } from "./endpoint-subscriptions.js";

/** Created by the `CotalEndpoint` before its parts. The connection part opens and clears it; the rebuild
 *  and the parts that open a handle lazily (`??=`) also write it. Every other part takes it as `Readonly`
 *  and reads a field when it uses it, never a copy. */
export interface ConnectionState {
  nc?: NatsConnection;
  js?: JetStreamClient;
  jsm?: JetStreamManager;
  kv?: KV;
  channelKv?: KV;
  channelWatchIter?: Awaited<ReturnType<KV["watch"]>>;
  /** Plane-3 durable-membership registry KV — lazily opened by the privileged delivery daemon (or a
   *  short-lived provisioner). */
  membersKv?: KV;
  aclKv?: KV;
  managerLeaseKv?: KV;
  /** Our revision of the per-space daemon-credential renewal lease (#1634), or undefined when we do
   *  not hold it. Cleared with the bound KV handle: a revision from a dead connection is not a lease
   *  we can prove we still hold. */
  daemonRenewalLeaseRevision?: number;
  membershipFeedKv?: KV;
  /** Caller-owned membership watches survive a connection rebuild as INTENT. Their iterators are
   *  connection-scoped and are stopped/re-created around the epoch swap. */
  readonly membershipFeedWatches: Set<MembershipFeedWatch>;
  /** Publish permissions presented on each watch's connection, refreshed only when it authenticates.
   *  Missing context preserves broker-checked cleanup for other supported authentication forms. */
  readonly watchDeletePermissions: WeakMap<object, () => IssuedSubjectPermission | undefined>;
  /** Includes detached predecessors until their actual connection reports closed. */
  readonly ownedConnections: Set<NatsConnection>;
  readonly requestsAwaitingReply: Map<NatsConnection, Set<(error: Error) => void>>;
  /** The issuer-bound generation, learned once per connection from the accepted row. */
  issuedGeneration?: string;
  /** Routing metadata from the last validated agent transport. Not a broker grant. */
  pluginChannelsEnabled: boolean;
  pluginChannelEpoch?: number;
  /** Whether the current connection has a binding to report: the last `transport` edge, cleared
   *  when a reconnect is requested on it. Read by {@link nativeConnections}. */
  nativeBound: boolean;
}

/** A state with no connection: every handle unset and every collection empty. */
export function newConnectionState(): ConnectionState {
  return {
    membershipFeedWatches: new Set<MembershipFeedWatch>(),
    watchDeletePermissions: new WeakMap<object, () => IssuedSubjectPermission | undefined>(),
    ownedConnections: new Set<NatsConnection>(),
    requestsAwaitingReply: new Map<NatsConnection, Set<(error: Error) => void>>(),
    pluginChannelsEnabled: false,
    nativeBound: false,
  };
}
