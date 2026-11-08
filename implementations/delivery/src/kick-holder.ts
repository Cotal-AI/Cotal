import { credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  dialerFor, MEMBERSHIP_INBOX_PREFIX, mintConnectionEvictorCreds, mintKickHolderCreds, mintKickRequestListenerCreds, newIdentity, serveKickHolder, type SecretStore, type SpaceAuth,
} from "@cotal-ai/core";
import { connectionEvictorCredsKey, type SpaceMaterialComposition } from "@cotal-ai/workspace";
import { readRetainedSystemSeed } from "./kick-holder-source.js";

const enc = (s: string) => new TextEncoder().encode(s);

/** Write this space's stored kick requester when the store has none. The data-account signing seed
 *  signs it, so a second space does not wait for a broker-wide system rotation. An existing value is
 *  left untouched. */
export async function ensureStoredKickRequester(opts: {
  auth: SpaceAuth;
  secrets: SecretStore;
  composition: SpaceMaterialComposition;
}): Promise<void> {
  const key = connectionEvictorCredsKey(opts.auth.space, opts.composition);
  if ((await opts.secrets.get(key)) !== undefined) return;
  await opts.secrets.put(connectionEvictorCredsKey(opts.auth.space, opts.composition), await mintConnectionEvictorCreds(opts.auth, newIdentity()));
}

/** Start one space's checked kick holder.
 *
 *  The raw kick user is minted from the retained system signing seed and stays in this process.
 *  The listener is minted into this space's data account. `observerCreds` is the account-scoped
 *  CONNZ reader already admitted for this daemon. It reads the unfiltered census. A missing
 *  retained seed throws: this space cannot check a kick. */
export async function startKickHolder(opts: {
  servers: string;
  auth: SpaceAuth;
  observerCreds: string;
  secrets: Parameters<typeof readRetainedSystemSeed>[0]["secrets"];
}): Promise<{ close(): Promise<void> }> {
  const retained = await readRetainedSystemSeed({ secrets: opts.secrets, space: opts.auth.space });
  if (!retained || retained.sysPub !== opts.auth.sys.pub)
    throw new Error(`kick holder: space "${opts.auth.space}" has no retained system signing seed for its current system account`);
  const armed: SpaceAuth = { ...opts.auth, sys: { ...opts.auth.sys, signingSeed: retained.signingSeed } };
  const dial = dialerFor(opts.servers);
  const listener = await mintKickRequestListenerCreds(armed, newIdentity());
  const holder = await mintKickHolderCreds(armed, newIdentity());
  const requests = await dial({ servers: opts.servers, authenticator: credsAuthenticator(enc(listener)), maxReconnectAttempts: -1 });
  let kicker: NatsConnection | undefined, census: NatsConnection | undefined;
  try {
    kicker = await dial({ servers: opts.servers, authenticator: credsAuthenticator(enc(holder)), maxReconnectAttempts: -1 });
    census = await dial({ servers: opts.servers, authenticator: credsAuthenticator(enc(opts.observerCreds)), inboxPrefix: MEMBERSHIP_INBOX_PREFIX, maxReconnectAttempts: -1 });
    const served = await serveKickHolder({ requests, kicker, census, accountId: opts.auth.account.pub, space: opts.auth.space });
    return { close: async () => { await served.close(); await Promise.all([requests, kicker, census].map((nc) => nc?.drain().catch(() => {}))); } };
  } catch (e) {
    await Promise.all([requests, kicker, census].map((nc) => nc?.close().catch(() => {})));
    throw e;
  }
}
