/**
 * How the auth package reaches the delivery daemon's privileged `ctl.delivery-admin` rail: the
 * revoke-time eviction, the barrier evictors and the liveness oracles each open one short-lived,
 * non-participating endpoint per call through {@link withDeliveryAdminEndpoint}, so the credential
 * lifetime and the endpoint options are decided once.
 */
import { CotalEndpoint, mintCreds, newIdentity, type SpaceAuth } from "@cotal-ai/core";
import type { AuthorityClientOpts } from "./authority-client.js";

/** One delivery-admin call runs in a 15s request budget; 60s covers connect, the call and teardown
 *  with margin, and bounds a copied credential to a minute where the `supervisor` default is a
 *  standing 24h. */
const DELIVERY_ADMIN_CRED_TTL_SECONDS = 60;

/** Run `work` on a short-lived, non-participating endpoint holding one `profile` credential minted
 *  from the data account's signing seed. A failed stop never replaces the outcome. */
export async function withDeliveryAdminEndpoint<T>(
  opts: { space: string; server: string; dataAccount: { pub: string; signingSeed: string }; onConnection?: AuthorityClientOpts["onConnection"] },
  profile: "supervisor" | "endpoint-evictor",
  name: string,
  work: (ep: CotalEndpoint) => Promise<T>,
): Promise<T> {
  // The stripped mint view (core's stripSpaceAuth shape): mintCreds reads ONLY space +
  // account.pub + account.signingSeed.
  const auth: SpaceAuth = {
    space: opts.space,
    operator: { seed: "", jwt: "" },
    account: { pub: opts.dataAccount.pub, seed: "", jwt: "", signingSeed: opts.dataAccount.signingSeed, signingPub: "" },
    sys: { pub: "", jwt: "" },
  };
  const id = newIdentity();
  let ep: CotalEndpoint | undefined;
  try {
    ep = new CotalEndpoint({
      onConnection: (nc) => opts.onConnection?.(nc, `cotal:${name}:${opts.space}`),
      space: opts.space,
      servers: opts.server,
      creds: await mintCreds(auth, id, profile, { expiresInSeconds: DELIVERY_ADMIN_CRED_TTL_SECONDS }),
      card: { id: id.id, name, kind: "endpoint" },
      channels: [],
      consume: false,
      watchChannels: false,
      watchPresence: false,
      registerPresence: false,
    });
    ep.on("error", () => {});
    await ep.start();
    return await work(ep);
  } finally {
    await ep?.stop().catch(() => {});
  }
}
