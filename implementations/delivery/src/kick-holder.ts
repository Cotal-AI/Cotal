import { credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { dialerFor, serveSpaceKicks, type SpaceKickTarget } from "@cotal-ai/core";
import { authDir, kickListenerCredsKey, loadSpaceAccountAuth, listSpaceAccounts, workspaceSecretStore } from "@cotal-ai/workspace";
import { loadSysPair, type SysCredsSource } from "./sys-creds.js";

/**
 * The one process that holds a broker's kick credential. A space daemon scans its own account and
 * asks this process to kick a connection it found. This process checks that connection against the
 * NAMED account before it kicks, so a request cannot name another space's connection. The kick
 * credential is opened here and nowhere else.
 */
export async function runKickHolder(opts: { root: string; server: string }): Promise<{ close: () => Promise<void> }> {
  const accounts = await openAccounts(opts);
  if (accounts.size === 0) throw new Error("kick holder: this broker has no space with a kick listener");
  const served = await serveSpaceKicks({
    listener: (account) => accounts.get(account)?.listener,
    accounts: new Map([...accounts].map(([account, open]) => [account, { observer: open.observer, evictor: open.evictor }])),
  });
  return {
    close: async () => {
      await served.stop();
      await Promise.all([...accounts.values()].flatMap((open) => [open.listener, open.observer, open.evictor].filter((conn): conn is NatsConnection => conn !== undefined).map((conn) => conn.drain())));
    },
  };
}

interface OpenAccount {
  listener?: NatsConnection;
  observer: NatsConnection;
  evictor: NatsConnection;
}

/** Open one observer, one kick connection and one listener per space that has them. A space without
 *  the pair is skipped: it has no live eviction, and the holder does not invent one. The listener is
 *  a user of the space's own account, so each space needs its own. */
async function openAccounts(opts: { root: string; server: string }): Promise<Map<string, OpenAccount>> {
  const dir = authDir(opts.root);
  const secrets = workspaceSecretStore(opts.root);
  const out = new Map<string, OpenAccount>();
  for (const space of listSpaceAccounts(dir)) {
    const account = loadSpaceAccountAuth(dir, space);
    if (!account) continue;
    const source: SysCredsSource = { secrets, space, injected: false, root: opts.root };
    const pair = await loadSysPair(source, "both");
    if (!pair.observer || !pair.evictor) continue;
    const listenerCreds = await secrets.get(kickListenerCredsKey(space, source));
    out.set(account.account.pub, {
      ...(listenerCreds ? { listener: await dial(opts.server, listenerCreds) } : {}),
      observer: await dial(opts.server, pair.observer),
      evictor: await dial(opts.server, pair.evictor),
    });
  }
  return out;
}

function dial(server: string, creds: string): Promise<NatsConnection> {
  return dialerFor(server)({ servers: server, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), maxReconnectAttempts: 0 });
}

export type { SpaceKickTarget };
