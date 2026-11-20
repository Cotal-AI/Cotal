import { CotalEndpoint, dialerFor, drainAndClose, mintCreds, newIdentity, standaloneConnectOpts, type SpaceAuth } from "@cotal-ai/core";

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

/** The nats-server version the broker at `target` reports, read on one short-lived connection under a
 *  fresh probe credential, for a signer whose credential carries an exclusion: its deny rows hold
 *  only on a broker at the exclusion floor (SPEC §9), so the version is checked before anything is
 *  signed. `undefined` when the broker reports none. A broker that does not answer throws. */
export async function brokerVersionAt(target: ProvisionerTarget): Promise<string | undefined> {
  const creds = await mintCreds(target.auth, newIdentity(), "probe");
  const nc = await dialerFor(target.servers)({ servers: target.servers, ...standaloneConnectOpts({ creds, tls: target.tls === true }) });
  try { return nc.info?.version; }
  finally { await drainAndClose(nc); }
}
