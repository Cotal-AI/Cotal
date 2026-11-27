import { jetstreamManager } from "@nats-io/jetstream";
import type { NatsConnection } from "@nats-io/transport-node";
import { CotalEndpoint, EpEnvelopeError, dlvDurable, dlvStream, dmDurable, dmStream, mintCreds,
  newIdentity, principalKey, provisionAgentDurables, type SpaceAuth } from "@cotal-ai/core";

export type FootprintTarget = { owner: string; actor: string; lifecycleUid: string; read: string[] };
type Provisioner = { space: string; server: string; issuerAuth: () => SpaceAuth; onConnection?: (nc: NatsConnection, label: string) => void };

/** Provision and read back the exact DM, optional delivery, and read ACL footprint. */
export async function provisionForegroundFootprint({ space, server, issuerAuth, onConnection }: Provisioner,
  { owner, actor, lifecycleUid, read }: FootprintTarget): Promise<void> {
  const identity = newIdentity();
  let conn: NatsConnection | undefined;
  const provisioner = new CotalEndpoint({
    space, servers: server,
    onConnection: nc => { conn = nc; onConnection?.(nc, `cotal:auth-foreground-provisioner:${space}`); },
    channels: [],
    creds: await mintCreds(issuerAuth(), identity, "provisioner"),
    card: { id: identity.id, name: "provisioner", role: "provisioner", kind: "endpoint" },
    registerPresence: false, watchPresence: false, watchChannels: false, consume: false,
  });
  await provisioner.start();
  try {
    const resolvedRead = await provisionAgentDurables(provisioner, { owner, actor, lifecycleUid }, { subscribe: [], allowSubscribe: read });
    if (conn === undefined) throw new EpEnvelopeError("unavailable", "the foreground provisioner connection is unavailable for the read-back", undefined, "unknown");
    const jsm = await jetstreamManager(conn);
    await jsm.consumers.info(dmStream(space), dmDurable(owner, actor, lifecycleUid));
    if (resolvedRead.length > 0) await jsm.consumers.info(dlvStream(space), dlvDurable(owner, actor, lifecycleUid));
    const acl = await provisioner.aclForOwner(principalKey(owner, actor).key, lifecycleUid);
    if (acl === undefined || JSON.stringify(acl) !== JSON.stringify(read))
      throw new EpEnvelopeError("unavailable", "the foreground lifecycle read ACL did not read back", undefined, "unknown");
  } finally {
    await provisioner.stop();
  }
}
