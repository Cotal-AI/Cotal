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
import { EpEnvelopeError, assertInboxConnId, endpointToken, epAuthBucket, epfStreamName, newIdentity, recordsBucket, spacePrefix, assertPoolToken, principalTags, principalKey } from "@cotal-ai/core";
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

/**
 * The BARRIER EXECUTOR's scoped credential grant (SPEC 13.9): the lifecycle-barrier surface —
 * exactly what the takeover barrier (and its retirement sibling) reaches through the sealed
 * registry, on its OWN connection so the latency-sensitive mint writer never carries barrier
 * authority (its own doc pins "barriers are NOT this credential's job"):
 *
 *  - `STREAM.INFO` on both stores (the registry's §13.12 bind proof), `STREAM.MSG.GET` on both
 *    (leader-served gate/cred/intent and head reads), and records `DIRECT.GET` (reads that only
 *    feed revision-pinned CASes — the mint writer's own discipline).
 *  - The per-run THROWAWAY enumeration consumer on the auth stream (SPEC 13.9:2645: the barrier's
 *    LastPerSubject point-in-time family scan): EXTENDED create pinned to the name-token wildcard
 *    plus the auth-bucket filter (never a bare or DURABLE create), INFO/MSG.NEXT/DELETE pinned to
 *    the name-token (never a foreign consumer). Scoped to the AUTH stream only — no consumer
 *    authority on records.
 *  - `$KV` writes on EXACTLY the barrier keys: auth `gate.` (the freeze/reopen CAS), `cred.`
 *    (the family revokes), `stage.` (the durable operation intent), and records `lifecycle.`
 *    (the containment/epoch head CASes). No `bysrc.`/`uid.` (a barrier never mints), no
 *    `srcgate.`/`session.` (handle revocation and session reconcile are injected seams, not
 *    this credential's job).
 *
 * Named residuals (D32 class, not pretend-confined): the stream-wide body-selected `MSG.GET`
 * metadata read and the caller-selected-reply injection class ride this profile like its
 * siblings; and the `$KV` prefixes span every uid (broker ACLs cannot scope "only the family
 * you are containing") — the executor IS the barrier authority, and that authority is exactly
 * what it holds.
 */
export function authorityBarrierGrants(space: string, connId: string): { publish: string[]; subscribe: string[] } {
  const auth = `KV_${epAuthBucket(space)}`;
  const records = `KV_${recordsBucket(space)}`;
  // Same connId hygiene as its siblings: the only untrusted subject-forming input goes through
  // the shared inbox grammar so it can never widen the scoped inbox.
  const inbox = assertInboxConnId(connId);
  return {
    publish: [
      "$JS.API.INFO",
      `$JS.API.STREAM.INFO.${auth}`,
      `$JS.API.STREAM.INFO.${records}`,
      `$JS.API.STREAM.MSG.GET.${auth}`,
      `$JS.API.STREAM.MSG.GET.${records}`,
      `$JS.API.DIRECT.GET.${records}`,
      `$JS.API.DIRECT.GET.${records}.>`,
      // The per-run throwaway enumeration consumer, pinned to the SPEC 13.9:2645 form (security H2
      // / distsys / fact H1): EXTENDED create only — a name-token wildcard plus the filter pinned
      // to the auth bucket subtree (`CREATE.<auth>.*.$KV.<bucket>.>`), so the holder can never issue
      // a BARE create (arbitrary name + body-selected filter/config) nor a DURABLE create (a durable
      // consumer that outlives this connection and keeps exporting future rows). INFO/NEXT/DELETE
      // are pinned to the name-token (`.*`), not `.>`, so the holder cannot INFO/DELETE a FOREIGN
      // auth consumer. Named residual (D32 class, broker-inexpressible): a push consumer's
      // `deliver_subject` is a request-BODY field the subject ACL cannot constrain (nats-server#8274),
      // so a compromised holder could still route a pinned-filter read to an arbitrary subject; the
      // barrier's own scanner is PULL (`ack_policy: none`, no deliver_subject) and never does this,
      // and eliminating the bare/durable forms removes the persistent-export vector.
      `$JS.API.CONSUMER.CREATE.${auth}.*.$KV.${epAuthBucket(space)}.>`,
      `$JS.API.CONSUMER.INFO.${auth}.*`,
      `$JS.API.CONSUMER.DELETE.${auth}.*`,
      `$JS.API.CONSUMER.MSG.NEXT.${auth}.*`,
      `$KV.${epAuthBucket(space)}.gate.>`,
      `$KV.${epAuthBucket(space)}.cred.>`,
      // ONE token: the barrier's own durable operation intents `stage.<opId>` — never `stage.>`,
      // which would also reach the session ledger's `stage.session.<sid>.<c|s>` release pins (a
      // family the SESSION writer owns). The documented-future takeover/registration successor
      // artifacts (`stage.<opId>.…`) have no writer yet; compose `stage.*.>` in the slice that
      // introduces them, so forgetting fails loud here instead of widening silently now.
      `$KV.${epAuthBucket(space)}.stage.*`,
      `$KV.${recordsBucket(space)}.lifecycle.>`,
    ],
    subscribe: [`_INBOX_${inbox}.>`],
  };
}

/** The RETIREMENT SETTLEMENT EXECUTOR's op-bounded rows (SPEC 13.9 "Retirement settlement",
 *  the ceee1a1 authority split): COMPOSED onto {@link authorityBarrierGrants} for ONE retirement
 *  operation whose durable intent lists exactly these endpoint/pools — never a standing grant,
 *  never minted without a live intent. Per listed pool: the lease-record CAS write
 *  (`lease.<endpoint>.<pool>.…` — create for the worker-less expiry sentinel, revision-pinned
 *  update otherwise) and the lease-derived `wrk` terminal create-only publish
 *  (`epf.<endpoint>.wrk.<pool>.>`, first terminal wins). Plus the leader-served EPF fencing
 *  reads (`STREAM.MSG.GET.EPF_<space>`: the acceptance-decision re-derivation and the
 *  terminal-observe/CAS-loser reads); the records-side fencing/CAS reads ride the barrier
 *  profile this composes onto. The `epw.>` ENQUEUE row is deliberately absent: the executor's
 *  reconcile is reachable only for items at/past their own `workExpiry` (the settlement seam
 *  refuses `expired` before the horizon), which structurally never takes the re-enqueue repair
 *  branch — if a code change ever reached it, the broker denies and the barrier fails loud.
 *
 *  D32 residuals, EXPLICIT (the relocated forge the bounded cleaner does NOT carry): KV subject
 *  permissions cannot distinguish CAS from overwrite or DEL/PURGE markers, and the `wrk`
 *  publish is payload-blind, so a compromised executor can forge a lease settlement or work
 *  terminal WITHIN the intent's exact pools (never beyond them); the space-wide EPF
 *  `STREAM.MSG.GET` exposure and the caller-selected-reply injection ride it like every
 *  API-holding profile. Op-bounded, intent-confined, revoked with the operation. */
export function barrierExecutorSettlementGrants(space: string, endpoint: string, pools: string[]): { publish: string[] } {
  if (!Array.isArray(pools) || pools.length === 0)
    throw new EpEnvelopeError("failed-precondition", "an executor settlement grant lists at least one exact pool (SPEC 13.9: the op intent enumerates them; a poolless settlement authority is none)");
  const e = endpointToken(endpoint);
  const publish: string[] = [];
  for (const pool of pools) {
    const p = assertPoolToken(pool);
    publish.push(
      `${spacePrefix(space)}.epf.${e}.wrk.${p}.>`,
      `$KV.${recordsBucket(space)}.lease.${e}.${p}.>`,
    );
  }
  publish.push(`$JS.API.STREAM.MSG.GET.${epfStreamName(space)}`);
  return { publish };
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
  /** Optional CONNZ principal tag (`owner.actor`). A bare authority connection is identified only
   *  by its nkey, which the delivery daemon's principal-scan eviction cannot target (it kicks by
   *  `owner.actor` tag, evict-exec.ts). A connection that must be VERIFIED-EVICTABLE (the per-op
   *  retirement cleaner) sets this so CONNZ surfaces it and `evictPrincipal(<owner>.<actor>)` can
   *  kill it. Omit for connections that are only ever torn down by close/TTL (writer/barrier/reader). */
  principal?: { owner: string; actor: string };
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
  /** The CONNZ principal `owner.actor` dot-form when {@link AuthorityClientOpts.principal} was set
   *  (the verified-evictable identity); absent for bare nkey-only connections. */
  principal?: string;
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
      { pub: { allow: grants.publish }, sub: { allow: grants.subscribe },
        ...(opts.principal ? { tags: principalTags(opts.principal.owner, opts.principal.actor) } : {}) },
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
    ...(opts.principal ? { principal: principalKey(opts.principal.owner, opts.principal.actor).key } : {}),
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
