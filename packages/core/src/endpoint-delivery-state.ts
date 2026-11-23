// The subscriptions, consumers and responders a CotalEndpoint holds on its connection, in one object
// the endpoint's internal parts read by reference. Not re-exported by the index.
import type { ConsumerMessages } from "@nats-io/jetstream";
import type { LivenessPlane, ResponderState } from "./liveness.js";
import type { NatsConnection, Subscription } from "@nats-io/transport-node";
import type { PrincipalServeIntent } from "./endpoint-options.js";

/** One goal follower {@link EndpointControlPlane.followServiceGoal} registers with its endpoint. */
export type GoalFollower = { cancel: () => void; reconnected: (nc: NatsConnection) => void };

/** Created by the `CotalEndpoint` before its parts. The consumers part owns it; the parts that open or
 *  drop a subscription, consumer or responder change its collections in place, and anycast sets
 *  {@link anycastUnavailable}. Every other part takes it as `Readonly` and reads a field when it uses it. */
export interface DeliveryState {
  /** The DM-only handler now running, if any; stop awaits it. */
  dmOnlyInFlight?: Promise<void>;
  /** Why the records are not open, when this daemon's credential cannot open them. */
  anycastUnavailable?: string;
  readonly subs: Subscription[];
  /** The liveness responders {@link serveLiveness} was asked for, by plane. This is INTENT, re-bound
   *  by {@link EndpointLiveness.bindLiveness} on every (re)connect: a rebuild closes the old connection and every
   *  subscription on it, so a responder bound once would leave its plane to the broker's
   *  no-responders answer, which a peer grades `unbound`, while this endpoint is connected and serving. */
  readonly livenessResponders: Map<LivenessPlane, { readState: () => Promise<ResponderState> | ResponderState; sub?: Subscription; qualifiedDmVersion?: 1 }>;
  /** The principal endpoints {@link servePrincipal} serves, by endpoint name: INTENT, re-bound on
   *  every replaced connection. */
  readonly principalServes: Map<string, PrincipalServeIntent>;
  readonly streamMsgs: ConsumerMessages[];
  /** Per-channel native core subscriptions (SPEC v0.3) — the manager-free live read path for boot +
   *  runtime channels (there is no per-instance chat durable). Keyed by channel so leave unsubscribes
   *  just one. */
  readonly chatSubs: Map<string, Subscription>;
  /** Channels whose core-sub the broker refused (async sub.allow violation) — read by the
   *  broker-confirmed join: a denied subscribe is NOT a successful join (SPEC conformance #13). */
  readonly chatSubDenied: Set<string>;
  /** Channels this session has a Plane-3 durable backstop for (per-channel join GENERATION, from
   *  durableJoin, so leave passes it back for the stale-leave guard). A durable channel's core-sub is
   *  NOT coverage-dropped — it stays a live wake-hint, dedup-coalesced with the Plane-3 durable copy by
   *  id-dedup. Drives the durable-state surface + routes leave to `durableLeave`. PERSISTS across
   *  reconnect (like `this.channels`): the membership record + the `dlv_<id>` durable are persistent so
   *  the backstop survives a reconnect on its own; the agent can't re-read the privileged members KV,
   *  so this in-memory mirror is kept, not rebuilt. Cleared only on full stop. */
  readonly plane3Channels: Map<string, number>;
  /** Active goal followers awaiting outcome, tracked so endpoint stop can cancel them immediately
   *  and connection replacement / reconnect can trigger reconciliation. */
  readonly activeGoalFollowers: Set<GoalFollower>;
}

/** The state before the endpoint subscribes or consumes anything. */
export function newDeliveryState(): DeliveryState {
  return {
    subs: [],
    livenessResponders: new Map(),
    principalServes: new Map<string, PrincipalServeIntent>(),
    streamMsgs: [],
    chatSubs: new Map<string, Subscription>(),
    chatSubDenied: new Set<string>(),
    plane3Channels: new Map<string, number>(),
    activeGoalFollowers: new Set<GoalFollower>(),
  };
}
