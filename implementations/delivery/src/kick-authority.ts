/**
 * THE ONE KICK AUTHORITY OF A MULTI-SPACE DELIVERY HOST.
 *
 * `$SYS.REQ.SERVER.<id>.KICK` takes a connection id and checks no account, so the credential that
 * publishes it reaches every connection on the broker. On a single-space broker the only account at
 * risk is the space's own, and its delivery daemon holds that credential. On a broker that hosts
 * several spaces no space daemon may: one copy would kick any tenant. The host is already the one
 * process serving every space, so it is the one place the credential exists.
 *
 * A lane never opens a kick credential. It scans its own account with its own observer, as before,
 * and asks this authority to kick each live match. The authority trusts the lane for nothing but the
 * question. Per kick it reads the retained system-account signing seed itself, mints a kick-only user
 * that lives minutes, checks that the lane's observer is signed by that system account and scoped to
 * the account the lane names, runs its own complete CONNZ page of that account, and kicks only a
 * connection that page lists. A connection the page does not list is not that account's to drop, and
 * a page that did not answer whole proves nothing, so both refuse. Nothing `$SYS` stays connected
 * between kicks, and the seed is read per kick, so a rotation that re-keys the store is picked up by
 * the next eviction with no restart.
 */
import { credsAuthenticator } from "@nats-io/transport-node";
import { closeConnection } from "@cotal-ai/core";
import { MEMBERSHIP_INBOX_PREFIX, accountHoldsConnection, credsClaims, dialerFor, kickConnection, mintConnectionEvictorCreds, newIdentity, type KickTarget } from "@cotal-ai/core";
import { connzAccountOf, retainedBrokerSeed } from "./sys-creds.js";

/** What a lane asks: kick one connection of the account its observer is scoped to. */
export interface KickRequest {
  /** The DATA account the lane serves, pinned from its own credential at start. */
  accountId: string;
  /** The lane's own `$SYS` observer. The authority checks its scope and issuer, then scans with it. */
  observerCreds: string;
  target: KickTarget;
}

export interface KickAuthority {
  /** Resolves once the broker accepted the KICK. Throws a refusal, naming why, and kicks nothing. */
  kick(request: KickRequest): Promise<void>;
}

/** How long one minted kick user lives: long enough for one kick against a slow broker, short enough
 *  that a copy leaving this process's memory dies before anyone could publish with it. */
const KICK_USER_TTL_SEC = 300;

const enc = (s: string) => new TextEncoder().encode(s);

/** The kick authority of the host serving `root`'s spaces against `server`. It holds nothing between
 *  kicks: see the module doc for what one kick reads, checks and opens. */
export function hostKickAuthority(opts: { root: string; server: string }): KickAuthority {
  const dial = dialerFor(opts.server);
  return {
    async kick({ accountId, observerCreds, target }) {
      const seed = await retainedBrokerSeed(opts.root);
      if (seed === undefined)
        throw new Error("kick authority: no space on this root retained its system-account signing seed, so this host holds no kick authority; the seed is retained at space creation and at `cotal up --rotate-sys`");
      const scoped = connzAccountOf(observerCreds);
      if (scoped !== accountId)
        throw new Error(`kick authority: the lane's observer is scoped to ${scoped ?? "no account"}, not the account ${accountId} it asks about; refusing`);
      const issuer = credsClaims(observerCreds).iss;
      if (issuer !== seed.sysPub)
        throw new Error(`kick authority: the lane's observer was signed by system account ${issuer?.slice(0, 12) ?? "(none)"}…, not the retained ${seed.sysPub.slice(0, 12)}…; a system-account rotation did not finish, and a census of the retired account proves nothing; refusing`);
      const evictorCreds = await mintConnectionEvictorCreds(seed.auth, newIdentity(), { expiresInSeconds: KICK_USER_TTL_SEC });
      const observer = await dial({ servers: opts.server, authenticator: credsAuthenticator(enc(observerCreds)), inboxPrefix: MEMBERSHIP_INBOX_PREFIX, maxReconnectAttempts: 0 });
      try {
        const sight = await accountHoldsConnection(observer, accountId, target);
        if (sight === "unreadable")
          throw new Error(`kick authority: the CONNZ page of account ${accountId} did not answer whole, so connection ${target.cid} on ${target.serverId} cannot be placed; refusing`);
        if (sight === "absent")
          throw new Error(`kick authority: connection ${target.cid} on ${target.serverId} is not in account ${accountId}; refusing`);
        const evictor = await dial({ servers: opts.server, authenticator: credsAuthenticator(enc(evictorCreds)), maxReconnectAttempts: 0 });
        try {
          await kickConnection(evictor, target);
        } finally {
          await closeConnection(evictor).catch(() => {});
        }
      } finally {
        await closeConnection(observer).catch(() => {});
      }
    },
  };
}
