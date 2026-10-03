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
 * The delivery lease IS held for the fixture's whole life, renewed at half of `LEASE_TTL_MS` as
 * the shipped daemon renews it. The manager's store challenge requires the answering responder to
 * hold that lease, and the lease bucket expires an unrenewed row after `LEASE_TTL_MS`. A fixture
 * that only acquired it answered `holdsDeliveryLease: false` to any manager that started more than
 * one TTL after boot, and that manager correctly refused to start.
 *
 * The caller must hold the space's `SpaceAuth` WITH its in-memory system-account signing seed —
 * i.e. the auth object `createSpaceAuth` just returned, since the $SYS seed is never persisted.
 *
 * `reloadStoreIdentity` is the same store the Manager remints through. Manager.start challenges
 * this hook before the first remint; an unnamed or divergent identity is a construction refusal.
 */
import {
  CotalEndpoint,
  LEASE_TTL_MS,
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
  /** How often the lease is renewed. Defaults to half of `LEASE_TTL_MS`, as the shipped daemon
   *  renews; the fixture's own smoke shortens it to observe renewal without waiting a TTL. */
  renewIntervalMs?: number;
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
  const dlvRevision = await ep.acquireDeliveryLease(0);
  await ep.startPlane3((owner, lifecycleUid) => ep.aclForOwner(owner, lifecycleUid), {
    evictPrincipal: (principal) =>
      evictDeniedPrincipalWithCreds({
        servers, observerCreds, evictorCreds, accountId: auth.account.pub, principal,
        options: { maxVerifyRounds: 12 },
      }),
    reloadStoreIdentity: () => reloadStoreIdentity,
  });
  let revision: number | undefined = await ep.markDeliveryLeaseReady(0, dlvRevision);
  // A failed renew drops the revision and stops renewing. The row then lapses on its TTL and the
  // manager's challenge refuses, which is the fail-closed outcome a suite should see.
  let renewing: Promise<void> | undefined;
  const renew = setInterval(() => {
    if (revision === undefined || renewing) return;
    renewing = ep.renewDeliveryLease(0, revision)
      .then((next) => { revision = next; }, () => { revision = undefined; clearInterval(renew); })
      .finally(() => { renewing = undefined; });
  }, opts.renewIntervalMs ?? Math.max(1000, Math.floor(LEASE_TTL_MS / 2)));
  renew.unref?.();
  let stopped = false;
  return {
    ep,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(renew);
      await renewing;
      // The manager's no-responder challenge (`absentByLeaseRow`) reads the lease row off the
      // bucket, not the rail; a row this fixture left behind still names a holder that no longer
      // answers, so release it the way the daemon does before tearing the endpoint down.
      try {
        const own = await ep.readDeliveryLeaseEntry(0);
        if (own !== undefined && ep.ownsDeliveryLease(own.info)) await ep.releaseDeliveryLease(0, own.revision);
      } catch { /* the broker may already be gone; the bucket TTL is the crash-safe release */ }
      await ep.stop().catch(() => {});
    },
  };
}
