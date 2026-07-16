/**
 * The auth service's SELF-MINTED data-account connections (R1). The service already holds the
 * data account's signing seed (minting scoped users IS its function), so its own infrastructure
 * access is signed from that seed directly — a ledgered `cred.`/`epcred.` row would create no
 * enforcement point (connect never re-reads the reader's own row) and would be enumerated by the
 * lifecycle barriers as if it were an agent's. The revoke story is the D5 class: stop the service
 * or rotate the data-account signing seed. A genuinely LEDGERED infra-credential family is the
 * deferred infra-mint work; migrate onto it there, do not invent it here.
 *
 * Two connections, least-privilege by construction:
 *  - the CONNECT READER (`cotal:auth-reader:<space>`): read-only over both authority stores
 *    ({@link authConnectReaderGrants}), supervised — shape-proved on EVERY (re)bind, unproved
 *    while disconnected, so a reader that cannot currently prove its stores DENIES every connect.
 *  - the MINT WRITER (`cotal:auth-mint:<space>`): the exchange-time issuance executor
 *    ({@link authorityWriterGrants}) — store ensure + the activation saga + the root-credential
 *    mint protocol. Its unfenced reads only feed revision-pinned CASes (a stale read LOSES) or a
 *    bearer stamp the leader-served connect arm re-checks, so bind-time proof suffices.
 *
 * RENEWAL IS A FAIL-CLOSED BOUNDARY: each connection authenticates with a SHORT-exp user JWT over
 * a stable nkey, re-minted in-process at half-life; the broker disconnects the connection at JWT
 * expiry and the reconnect presents the freshest mint. A renewal-mint failure fires
 * {@link AuthorityClientOpts.onRenewalFailure} IMMEDIATELY — the supervised reader downs itself
 * on it (unproved + connection closed), so connects DENY from the moment the renewal fails, not
 * only when the old credential eventually expires. A downed reader never comes back without a
 * service restart; there is no file-only fallback.
 */
import { connect, jwtAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { encodeUser } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { EpEnvelopeError, assertInboxConnId, epAuthBucket, newIdentity, recordsBucket } from "@cotal-ai/core";
import { authConnectReaderGrants, openConnectReader, type ConnectReader } from "./connect-reader.js";

/** Self-minted infra-credential TTL (fact-3 pin: SHORT expiry + in-process renewal, a bounded
 *  in-memory credential that closes with the service — never an unbounded persisted one). */
export const AUTHORITY_CLIENT_TTL_SEC = 15 * 60;

/**
 * The MINT WRITER's scoped credential grant (SPEC 13.9): the exchange-time issuance executor.
 * Exactly the store-ensure + activation-saga + root-mint surface:
 *
 *  - `$JS.API.STREAM.CREATE` on both authority KV streams and `STREAM.UPDATE` on records (the
 *    boot-time `ensureAuthorityStores`), `STREAM.INFO` on both (ensure verify + §13.12 bind
 *    proof), `STREAM.MSG.GET` on both (auth-store KV reads are leader-only by shape; fenced
 *    record reads), and records `DIRECT.GET` (the records bucket is Direct-capable and its KV
 *    reads here only feed revision-pinned CASes, which a stale read LOSES — fail-closed).
 *  - `$KV` writes on EXACTLY the issuance keys: auth `gate.` / `cred.` / `bysrc.` (the gate CAS
 *    fence and the mint's rows) and records `lifecycle.` / `uid.` (the alias head and the
 *    space-global uid reservation). No `srcgate.`/`stage.`/`session.` writes: root issuance
 *    presents no handles and runs no takeover; barriers are NOT this credential's job.
 *
 * Named residuals (D32 class, not pretend-confined): `STREAM.MSG.GET` is body-selected, so this
 * is a stream-wide METADATA read of both stores; the `$KV` prefixes span every uid/alias (broker
 * ACLs cannot scope "only the row you are minting"), so a compromised writer can forge issuance
 * rows — it is the ISSUANCE AUTHORITY, that authority is exactly what it holds; and every raw
 * MSG.GET/DIRECT.GET profile carries the caller-selected-reply injection class.
 */
export function authorityWriterGrants(space: string, connId: string): { publish: string[]; subscribe: string[] } {
  const auth = `KV_${epAuthBucket(space)}`;
  const records = `KV_${recordsBucket(space)}`;
  // Same connId hygiene as authConnectReaderGrants: the only untrusted subject-forming input goes
  // through the shared inbox grammar so it can never widen the scoped inbox.
  const inbox = assertInboxConnId(connId);
  return {
    publish: [
      "$JS.API.INFO",
      `$JS.API.STREAM.CREATE.${auth}`,
      `$JS.API.STREAM.CREATE.${records}`,
      `$JS.API.STREAM.UPDATE.${records}`,
      `$JS.API.STREAM.INFO.${auth}`,
      `$JS.API.STREAM.INFO.${records}`,
      `$JS.API.STREAM.MSG.GET.${auth}`,
      `$JS.API.STREAM.MSG.GET.${records}`,
      `$JS.API.DIRECT.GET.${records}`,
      `$JS.API.DIRECT.GET.${records}.>`,
      `$KV.${epAuthBucket(space)}.gate.>`,
      `$KV.${epAuthBucket(space)}.cred.>`,
      `$KV.${epAuthBucket(space)}.bysrc.>`,
      `$KV.${recordsBucket(space)}.lifecycle.>`,
      `$KV.${recordsBucket(space)}.uid.>`,
    ],
    subscribe: [`_INBOX_${inbox}.>`],
  };
}

export interface AuthorityClientOpts {
  server: string;
  space: string;
  dataAccount: { pub: string; signingSeed: string };
  /** The CONNZ-visible connection name (`cotal:auth-reader:<space>` / `cotal:auth-mint:<space>`). */
  label: string;
  /** The grant builder — called with the connection's stable identity so the scoped inbox is in
   *  the credential BEFORE the first connect. */
  grants: (connId: string) => { publish: string[]; subscribe: string[] };
  log: (line: string) => void;
  /** Fired the moment a renewal mint REJECTS (after the loud log). The supervised reader wires
   *  this to down itself immediately — renewal failure is a fail-closed boundary NOW, never
   *  "at the old credential's eventual expiry". */
  onRenewalFailure?: () => void;
  /** SMOKE-ONLY renewal probe: override the half-life interval and/or force every renewal mint
   *  to reject deterministically (the mint is a local signing operation with no natural failure
   *  to inject). Production compositions never set this. */
  probeRenewal?: { intervalMs: number; fail?: boolean };
}

export interface AuthorityClient {
  nc: NatsConnection;
  /** The stable user-nkey public key — the connection id its scoped inbox is keyed by. */
  connId: string;
  close(): Promise<void>;
}

/**
 * Open one self-minted data-account connection: a stable user nkey, a short-exp user JWT signed
 * by the data account's signing seed, re-minted in-process at half-life. The authenticator
 * presents the FRESHEST mint on every (re)connect; see the module header for why a failed
 * renewal fail-closes instead of retrying on a lapsed credential.
 */
export async function openAuthorityClient(opts: AuthorityClientOpts): Promise<AuthorityClient> {
  const identity = newIdentity();
  const grants = opts.grants(identity.id);
  const signer = fromSeed(new TextEncoder().encode(opts.dataAccount.signingSeed));
  const mint = async (): Promise<string> =>
    encodeUser(
      opts.label,
      fromPublic(identity.id),
      fromPublic(opts.dataAccount.pub),
      { pub: { allow: grants.publish }, sub: { allow: grants.subscribe } },
      { signer, exp: Math.floor(Date.now() / 1000) + AUTHORITY_CLIENT_TTL_SEC },
    );
  let currentJwt = await mint();
  const renew = async (): Promise<string> => {
    if (opts.probeRenewal?.fail) throw new Error("probe-forced renewal failure");
    return mint();
  };
  const renewal = setInterval(() => {
    void renew().then(
      (jwt) => { currentJwt = jwt; },
      (e) => {
        opts.log(`${opts.label}: credential renewal FAILED (${(e as Error)?.message ?? String(e)}) - failing closed NOW (fail-closed renewal boundary)`);
        opts.onRenewalFailure?.();
      },
    );
  }, opts.probeRenewal?.intervalMs ?? (AUTHORITY_CLIENT_TTL_SEC / 2) * 1000);
  let nc: NatsConnection;
  try {
    nc = await connect({
      servers: opts.server,
      name: opts.label,
      authenticator: jwtAuthenticator(() => currentJwt, new TextEncoder().encode(identity.seed)),
      inboxPrefix: `_INBOX_${identity.id}`,
      maxReconnectAttempts: -1,
    });
  } catch (e) {
    clearInterval(renewal);
    throw e;
  }
  return {
    nc,
    connId: identity.id,
    close: async () => {
      clearInterval(renewal);
      await nc.close().catch(() => {});
    },
  };
}

export interface SupervisedConnectReader {
  /** The currently PROVED reader. Throws (=> the callout denies the connect) while the reader is
   *  disconnected or its (re)bind shape proof has not yet passed — an unproved reader never
   *  serves a connect read (SPEC 13.12). */
  current(): ConnectReader;
  close(): Promise<void>;
}

/**
 * Open the supervised connect reader: the self-minted reader connection plus the §13.12 bind
 * discipline ACROSS RECONNECTS. The shape proof re-runs on EVERY (re)bind, not just startup — a
 * dropped reader reconnecting could land on a mirror/follower, so it is UNPROVED from the moment
 * the connection drops until {@link openConnectReader} passes again, and `current()` refuses in
 * between. The initial proof is awaited: this constructor resolving IS the readiness signal.
 */
export async function openSupervisedConnectReader(
  opts: Omit<AuthorityClientOpts, "grants" | "label">,
): Promise<SupervisedConnectReader> {
  const label = `cotal:auth-reader:${opts.space}`;
  let reader: ConnectReader | undefined;
  let closed = false;
  let client: AuthorityClient | undefined;
  client = await openAuthorityClient({
    ...opts,
    label,
    grants: (connId) => authConnectReaderGrants(opts.space, connId),
    // Renewal failure is a fail-closed boundary NOW: down the reader the instant a remint
    // rejects, so connects DENY immediately instead of riding the old credential to its expiry.
    onRenewalFailure: () => {
      reader = undefined;
      opts.log(`${label}: credential renewal failed - reader downed NOW, connects deny until the service restarts (fail-closed)`);
      if (!closed) void client?.close();
    },
  });
  const c = client;
  try {
    reader = await openConnectReader(c.nc, opts.space);
  } catch (e) {
    await c.close();
    throw e;
  }
  void (async () => {
    for await (const s of c.nc.status()) {
      if (closed) break;
      if (s.type === "disconnect" || s.type === "error") {
        reader = undefined;
        opts.log(`${label}: connection lost (${s.type}) - connects DENY until the rebind shape proof passes`);
      } else if (s.type === "reconnect") {
        try {
          reader = await openConnectReader(c.nc, opts.space);
          opts.log(`${label}: rebound and shape-proved; connect reads resume`);
        } catch (e) {
          reader = undefined;
          opts.log(`${label}: REBIND SHAPE PROOF FAILED (${(e as Error)?.message ?? String(e)}) - connects stay denied`);
        }
      }
    }
  })();
  return {
    current: () => {
      if (reader === undefined)
        throw new EpEnvelopeError("unavailable", "the connect-credential reader is not currently bound + shape-proved; a connect is never authorized without the live credential row (deny-new is fail-closed, SPEC 13.1/13.12)");
      return reader;
    },
    close: async () => {
      closed = true;
      reader = undefined; // a closed reader refuses immediately, not on the next status event
      await c.close();
    },
  };
}
