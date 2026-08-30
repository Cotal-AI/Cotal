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
 * What is NOT reproduced from `runDelivery`: its CLI arg surface, its `.cotal`-root scan-target
 * admission check (the smoke mints the $SYS pair directly from the space auth it already holds),
 * and the singleton delivery lease. Those guard an operator deployment, not the eviction contract.
 *
 * The caller must hold the space's `SpaceAuth` WITH its in-memory system-account signing seed —
 * i.e. the auth object `createSpaceAuth` just returned, since the $SYS seed is never persisted.
 */
import {
  CotalEndpoint,
  evictDeniedPrincipalWithCreds,
  mintConnectionEvictorCreds,
  mintCreds,
  mintMembershipObserverCreds,
  newIdentity,
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
}): Promise<DeliveryDaemon> {
  const { space, servers, auth } = opts;
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
  await ep.startPlane3((owner, lifecycleUid) => ep.aclForOwner(owner, lifecycleUid), {
    evictPrincipal: (principal) =>
      evictDeniedPrincipalWithCreds({
        servers, observerCreds, evictorCreds, accountId: auth.account.pub, principal,
        options: { maxVerifyRounds: 12 },
      }),
  });
  let stopped = false;
  return {
    ep,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await ep.stop().catch(() => {});
    },
  };
}
