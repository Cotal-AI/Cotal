// Whether a CotalEndpoint is started, stopping or rebuilding, in one object the endpoint's internal
// parts read by reference. Not re-exported by the index.

/** Created by the `CotalEndpoint` before its parts. Stop (the connection part) and the rebuild (the
 *  reconnect part) write it; `start()` on the endpoint writes {@link startPromise}. Every other part
 *  takes it as `Readonly` and reads a field when it uses it, never a copy. */
export interface LifecycleState {
  stopped: boolean;
  /** Bumped by every connection-scoped teardown and by {@link stop}. A presence or lease-watch bind
   *  that was awaiting the broker when the epoch moved belongs to a retired epoch: it releases the
   *  iterator it got and installs nothing (see {@link startPresenceWatch} and
   *  {@link EndpointDeliveryLease.bindDeliveryLeaseWatch}). */
  presenceEpoch: number;
  /** In-flight rebuild (drain+rebind) — serializes manual reconnect, the supervisor's
   *  closed(), and reestablishLoop so only ONE rebuild runs at a time (a second trigger
   *  coalesces onto the shared promise, never starts a parallel connectAndBind). */
  rebuildPromise?: Promise<void>;
  /** True only during the null window of a rebuild (this.nc unset) — user-facing ops then
   *  throw a "reconnecting" message instead of the misleading "endpoint not started". */
  reconnecting: boolean;
  /** One reestablishLoop at a time; concurrent triggers coalesce via rebuild(). */
  reestablishing: boolean;
  /** Wakes for the membership retry loops' pauses (see {@link EndpointReconnect.membershipPause}); stop() runs them all. */
  readonly membershipPauses: Set<() => void>;
  startPromise?: Promise<void>;
}

/** The state of an endpoint before it starts. */
export function newLifecycleState(): LifecycleState {
  return {
    stopped: false,
    presenceEpoch: 0,
    reconnecting: false,
    reestablishing: false,
    membershipPauses: new Set<() => void>(),
  };
}
