/**
 * Shared smoke helper: boot the REAL delivery daemon against an already-running broker, so a suite
 * that drives a lifecycle terminal can satisfy SPEC 13.1's verified-eviction step instead of dying
 * on "the delivery daemon is not reachable on the ctl.delivery-admin rail".
 *
 * This is the SHIPPED daemon, not a fixture responder that answers the oracle. The `evictPrincipal`
 * rail under test is served by `CotalEndpoint.handleDeliveryAdmin`, reached through the same
 * `startPlane3` hook `runDelivery` wires (`implementations/delivery/src/delivery.ts`), and executed
 * by core's own `evictDeniedPrincipalWithCreds` — the real CONNZ scan → KICK → re-scan verify.
 * Nothing here re-implements a step of the barrier; a stub that answered `verifiedGone` would be a
 * stub of the very thing the barrier trusts.
 *
 * What is NOT reproduced from `runDelivery`: its CLI arg surface and its `.cotal`-root scan-target
 * admission check (the smoke mints the $SYS pair directly from the space auth it already holds).
 * Those guard an operator deployment, not the eviction contract.
 *
 * THE DELIVERY LEASE *IS* ACQUIRED, and it stopped being optional. `reloadStoreIdentity` now answers
 * with the binding that says whether the answering process holds this space's lease, because the
 * rail is queue-grouped and only the lease holder actually reloads the standing credentials. A
 * fixture daemon without the lease answers `holdsDeliveryLease:false` and a challenging manager
 * correctly refuses to treat its store as the daemon's — so the lease here is what makes this stand
 * in for the real daemon rather than for a lease-less squatter.
 *
 * The caller must hold the space's `SpaceAuth` WITH its in-memory system-account signing seed —
 * i.e. the auth object `createSpaceAuth` just returned, since the $SYS seed is never persisted.
 *
 * `reloadStoreIdentity` is the same store the Manager remints through. Manager.start challenges
 * this hook before the first remint; an unnamed or divergent identity is a construction refusal.
 */
import {
  CotalEndpoint,
  evictDeniedPrincipalWithCreds,
  mintConnectionEvictorCreds,
  mintCreds,
  mintMembershipObserverCreds,
  newIdentity,
  type SecretStoreIdentity,
  type SpaceAuth,
} from "@cotal-ai/core";

export interface DeliveryDaemon {
  /** The daemon's endpoint, for suites that need to reach past the helper. */
  ep: CotalEndpoint;
  /** Stop the daemon. Idempotent. */
  stop: () => Promise<void>;
}

/** Boot the delivery daemon for `space` on `servers` and serve the privileged `ctl.delivery-admin`
 *  rail (its `evictPrincipal` verb is the liveness oracle every lifecycle barrier fails closed
 *  without). Returns once the rail is serving. */
export async function bootDeliveryDaemon(opts: {
  space: string;
  servers: string;
  auth: SpaceAuth;
  reloadStoreIdentity: SecretStoreIdentity;
}): Promise<DeliveryDaemon> {
  const { space, servers, auth, reloadStoreIdentity } = opts;
  // The $SYS pair the eviction executor connects with: an observer that can CONNZ-scan the account
  // and an evictor that can KICK it. Mintable only from a space auth still holding the in-memory
  // system-account seed.
  const observerCreds = await mintMembershipObserverCreds(auth, newIdentity());
  const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());
  const id = newIdentity();
  const ep = new CotalEndpoint({
    space,
    servers,
    creds: await mintCreds(auth, id, "delivery"),
    card: { id: id.id, name: "delivery", role: "delivery", kind: "endpoint" },
    channels: [],
    consume: false, // it pulls the Plane-3 consumers itself; no agent live-tail
    watchPresence: false,
    registerPresence: false, // infra, never a roster peer
    watchChannels: false,
  });
  // A broker teardown at suite end is not a daemon fault; suites assert on their own subject.
  ep.on("error", () => {});
  await ep.start();
  // BEFORE `startPlane3`, mirroring `runDelivery`: the lease is the single-flight admission to serve
  // the shard, and the store answer reads the live row. Marked ready after the rail is bound, so
  // "holds the lease" and "is answering" are the same claim the production daemon makes.
  let leaseRevision = await ep.acquireDeliveryLease(0);
  await ep.startPlane3((owner, lifecycleUid) => ep.aclForOwner(owner, lifecycleUid), {
    evictPrincipal: (principal) =>
      evictDeniedPrincipalWithCreds({
        servers, observerCreds, evictorCreds, accountId: auth.account.pub, principal,
        options: { maxVerifyRounds: 12 },
      }),
    reloadStoreIdentity: () => reloadStoreIdentity,
  });
  leaseRevision = await ep.markDeliveryLeaseReady(0, leaseRevision);
  let stopped = false;
  return {
    ep,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      // The revision this fixture actually holds, so the release is the CAS the API requires;
      // passing `undefined` is the "I hold no revision" answer and releases nothing.
      await ep.releaseDeliveryLease(0, leaseRevision).catch(() => {});
      await ep.stop().catch(() => {});
    },
  };
}
