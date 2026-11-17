import { CotalEndpoint, mintCreds, newIdentity, type SpaceAuth } from "@cotal-ai/core";

/** Where a short-lived provisioner connects. `tls` is set only by a caller that already required
 *  TLS on this connection: an omitted requirement is never filled in here. */
export interface ProvisionerTarget {
  space: string;
  servers: string;
  tls?: boolean;
  auth: SpaceAuth;
}

/** Run `work` on one short-lived, non-participating `provisioner` endpoint. The credential is
 *  minted here, `start` sits inside the try, and `stop` runs in `finally`. A stop that throws,
 *  or a stop of an endpoint that never started, is discarded: it never replaces `work`'s result
 *  or its error. The endpoint's own error and warning events are swallowed, because the awaited
 *  operation owns the verdict. */
export async function withProvisioner<T>(target: ProvisionerTarget, name: string, work: (ep: CotalEndpoint) => Promise<T>): Promise<T> {
  const ep = new CotalEndpoint({
    space: target.space,
    servers: target.servers,
    ...(target.tls ? { tls: true } : {}),
    creds: await mintCreds(target.auth, newIdentity(), "provisioner"),
    channels: [],
    consume: false,
    registerPresence: false,
    watchPresence: false,
    watchChannels: false,
    card: { name, role: "provisioner", kind: "endpoint" },
  });
  ep.on("error", () => {});
  ep.on("warning", () => {});
  try {
    await ep.start();
    return await work(ep);
  } finally {
    await ep.stop().catch(() => {});
  }
}
