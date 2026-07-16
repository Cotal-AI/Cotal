/**
 * The connect-time credential reader — the R1 "deny-new" substrate. At every connect the callout
 * must prove the presented bearer's `credentialId` still names a LIVE `cred.<uid>.<credid>` row,
 * so that revoking that row denies the NEXT connect (the v1 revocation lever that actually bites).
 *
 * The credential rows and the lifecycle head live in the DATA account, but the callout runs on the
 * CALLOUT account, and NATS accounts are isolated — so the auth service opens ONE standing
 * data-account reader connection (self-minted from the `dataAccount` signing seed it already
 * holds; see {@link authConnectReaderGrants}) and this module reads through it.
 *
 * Two authority stores, both leader-served and both shape-proved on EVERY (re)bind (SPEC 13.12):
 *  - `cred.<uid>.<credid>` lives in `KV_cotal_auth_<space>` (`allow_direct=false`);
 *  - the lifecycle head `lifecycle.<owner>.<actor>` (carrying `currentCredentialId`) lives in
 *    `KV_cotal_records_<space>`.
 * A follower/mirror can serve a STALE row that still reads `active` after a revoke, silently
 * defeating deny-new, so reads are leader-served `STREAM.MSG.GET` (never `DIRECT.GET`) AND the
 * store is proved primary/un-mirrored/non-evicting at bind. Any read/shape/parse failure DENIES
 * the connect; there is no file-only fallback.
 */
import type { NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager, type JetStreamManager } from "@nats-io/jetstream";
import { EpEnvelopeError, epAuthBucket, recordsBucket } from "@cotal-ai/core";
import { assertAuthorityStreamShape, openLifecycleMappingReader, readLifecycleMappingLeader, type LifecycleMappingReader } from "./lifecycle-registry.js";
import { credRowKey, parseLedgerRow, type CredentialLedgerRow } from "./credential-ledger.js";
import type { ValidatedUserToken } from "./token.js";

/**
 * The connect reader's SCOPED credential grant (SPEC 13.9). Read-only over BOTH authority stores,
 * plus the bind-time shape-proof INFO and a connection-scoped reply inbox. It holds NO write, NO
 * consumer create/update/delete, NO `DIRECT.GET`, and no account-wide inbox.
 *
 * D32 residual (named, not pretend-confined): `$JS.API.STREAM.MSG.GET.<stream>` is body-selected —
 * broker ACLs cannot scope it to only `cred.`/head subjects, so this grant is a space-wide read of
 * credential METADATA (holderPrincipal/state/chain/lifecycleUid/exp; NO secret key material rides
 * the row, confirmed against the closed `CredentialLedgerRow` schema) plus the caller-selected-reply
 * injection class every raw `MSG.GET` profile carries. Acceptable for this trusted, bounded-lived,
 * short-exp+renewed infra reader; a genuinely ledgered infra-reader family is the deferred
 * infra-mint work (a self-minted reader is revoked by stopping the service / rotating the seed, not
 * an agent-barrier revoke — it is not a managed-agent or endpoint descendant).
 */
export function authConnectReaderGrants(space: string, connId: string): { publish: string[]; subscribe: string[] } {
  const auth = `KV_${epAuthBucket(space)}`;
  const records = `KV_${recordsBucket(space)}`;
  if (!connId) throw new EpEnvelopeError("failed-precondition", "the connect reader grant requires a connection id for its scoped inbox (SPEC 13.9)");
  return {
    publish: [
      "$JS.API.INFO",
      `$JS.API.STREAM.INFO.${auth}`,
      `$JS.API.STREAM.INFO.${records}`,
      `$JS.API.STREAM.MSG.GET.${auth}`,
      `$JS.API.STREAM.MSG.GET.${records}`,
    ],
    subscribe: [`_INBOX_${connId}.>`],
  };
}

interface ConnectReaderInternals {
  space: string;
  jsm: JetStreamManager;
  mapping: LifecycleMappingReader;
}

/** A sealed, brand-checked connect reader (a hand-assembled context never authorizes). */
export interface ConnectReader {
  readonly space: string;
}

const READERS = new WeakMap<ConnectReader, ConnectReaderInternals>();

function internals(reader: ConnectReader): ConnectReaderInternals {
  const i = READERS.get(reader);
  if (!i)
    throw new EpEnvelopeError("failed-precondition", "the connect reader was not constructed by openConnectReader(); a hand-assembled context never authorizes (SPEC 13.12)");
  return i;
}

/**
 * Open (or re-open, on reconnect) the connect reader on a DATA-account connection, shape-proving
 * BOTH stores at bind (SPEC 13.12) — primary/un-mirrored/non-evicting, and the auth store
 * additionally `allow_direct=false`. Call this on every (re)bind: a dropped reader reconnecting
 * could land on a mirror/follower, so the primary-store proof must re-run before it serves any
 * connect read again. A store that cannot be proved never serves.
 */
export async function openConnectReader(nc: NatsConnection, space: string): Promise<ConnectReader> {
  const authBucket = epAuthBucket(space);
  let jsm: JetStreamManager;
  try {
    jsm = await jetstreamManager(nc);
    const authCfg = (await jsm.streams.info(`KV_${authBucket}`)).config;
    assertAuthorityStreamShape(authCfg, authBucket);
    if (authCfg.allow_direct !== false)
      throw new EpEnvelopeError("failed-precondition", `the auth store ${authBucket} has allow_direct=${String(authCfg.allow_direct)}, not false; a Direct-Get-capable credential store defeats leader-served deny-new (SPEC 13.1) — reprovision`);
  } catch (e) {
    if (e instanceof EpEnvelopeError) throw e;
    throw new EpEnvelopeError("failed-precondition", `the connect reader cannot bind + shape-prove the auth store ${authBucket} (SPEC 13.12): ${(e as Error)?.message ?? String(e)}`);
  }
  // The records-head reads go through the mapping reader, which shape-proves the records store the
  // same way at its own bind — so both stores are proved on this (re)bind.
  const mapping = await openLifecycleMappingReader(nc, space);
  const reader: ConnectReader = Object.freeze({ space });
  READERS.set(reader, { space, jsm, mapping });
  return reader;
}

/**
 * Leader-read a single credential-ledger row `cred.<uid>.<credid>` from the auth store (never a
 * follower `DIRECT.GET`: a stale replica could still read `active` after a revoke). Returns
 * `undefined` for a genuinely absent row; a DEL/PURGE marker or a garbled row THROWS (a deletion is
 * never absence, and garbled trusted-path state never authorizes).
 */
async function readCredRowLeader(reader: ConnectReader, uid: string, credid: string): Promise<CredentialLedgerRow | undefined> {
  const { jsm, space } = internals(reader);
  const bucket = epAuthBucket(space);
  const key = credRowKey(uid, credid);
  let m;
  try {
    m = await jsm.streams.getMessage(`KV_${bucket}`, { last_by_subj: `$KV.${bucket}.${key}` });
  } catch (e) {
    if ((e as { code?: unknown }).code === 10037) return undefined; // no message on the subject
    throw e;
  }
  if (!m) return undefined;
  const op = m.header?.get("KV-Operation");
  if (op)
    throw new EpEnvelopeError("failed-precondition", `the credential row ${key} carries a ${op} marker; a deletion is never absence — a revoked credential is a row with state:"revoked", not a tombstone (SPEC 13.1)`);
  return parseLedgerRow(m.data, key);
}

/** A source chain that is EXACTLY the single `root` member (the root-issuance case, whose deny-new
 *  also pins the lifecycle head's `currentCredentialId`). Session/handle chains are descendants. */
function isRootChain(chain: string[]): boolean {
  return chain.length === 1 && chain[0] === "root";
}

/**
 * The connect-time deny-new check (SPEC 13.1). Assumes the caller (the ledger connect authorizer)
 * has ALREADY run the actor-row + scope + lifecycle-equality checks; this adds the credential-row
 * liveness proof. THROWS to deny; returns on allow. Fail-closed throughout: absent/revoked/expired/
 * mismatched rows and every read failure deny.
 *
 *  1. the bearer MUST carry `act.credentialId` (grammar-valid from validateUserToken). Claimless =>
 *     deny (deny-new needs the claim; a pre-R1 bearer re-exchanges). A view bearer is NOT exempt;
 *     a bearer merely lacking `act.view` is a normal agent connect and is fine.
 *  2. leader-read `cred.<lifecycleUid>.<credid>`; require it exist, be `active`, be unexpired under
 *     the service clock, and bind holderPrincipal `<owner>.<actor>` + lifecycleUid + credentialId
 *     with NO normalization slack.
 *  3. root-issued credential (`sourceChain === ["root"]`): ALSO leader-read the lifecycle head and
 *     require it `active` with `currentCredentialId === credid`, so a SUPERSEDED root issuance is
 *     denied even if its old row still reads active (release-last keeps these consistent; head
 *     equality is the belt). A descendant (session/handle) leaf row is sufficient here: revoking an
 *     ancestor revokes the whole `cred.<uid>.>` family / `bysrc` chain and verified-evicts before
 *     the operation reports success, and after the leaf CAS deny-new holds.
 */
export async function authorizeConnectCredential(reader: ConnectReader, t: ValidatedUserToken, now: () => number): Promise<void> {
  const credid = t.act.credentialId;
  if (credid === undefined)
    throw new EpEnvelopeError("permission-denied", "the bearer carries no credential claim (act.credentialId); connect deny-new requires it — re-exchange for a fresh bearer (lifecycle credential-bound from v0.4 R1)");
  const uid = t.act.lifecycleUid;
  if (uid === undefined)
    throw new EpEnvelopeError("permission-denied", "the bearer carries no lifecycle claim; a credential row is keyed by lifecycle uid (SPEC 13.1)");

  const row = await readCredRowLeader(reader, uid, credid);
  if (row === undefined)
    throw new EpEnvelopeError("permission-denied", `no credential row cred.${uid}.${credid}; a revoked or never-issued credential does not connect (deny-new, SPEC 13.1)`);
  if (row.state !== "active")
    throw new EpEnvelopeError("permission-denied", `credential cred.${uid}.${credid} is "${row.state}", not active; a revoked credential does not connect (deny-new, SPEC 13.1)`);
  const holder = `${t.owner}.${t.act.actor}`;
  if (row.holderPrincipal !== holder)
    throw new EpEnvelopeError("permission-denied", `credential cred.${uid}.${credid} is held by "${row.holderPrincipal}", not the connecting principal "${holder}"; a credential never authorizes a different principal (SPEC 13.1)`);
  if (row.lifecycleUid !== uid)
    throw new EpEnvelopeError("permission-denied", `credential row cred.${uid}.${credid} names lifecycle ${row.lifecycleUid}, not ${uid} (key/value divergence, SPEC 13.1)`);
  if (row.credentialId !== credid)
    throw new EpEnvelopeError("permission-denied", `credential row cred.${uid}.${credid} names credentialId ${row.credentialId} (key/value divergence, SPEC 13.1)`);
  if (row.exp <= now())
    throw new EpEnvelopeError("permission-denied", `credential cred.${uid}.${credid} expired at ${row.exp}; a lapsed credential does not connect (SPEC 13.1)`);

  if (isRootChain(row.sourceChain)) {
    const head = await readLifecycleMappingLeader(internals(reader).mapping, t.owner, t.act.actor);
    if (head === undefined)
      throw new EpEnvelopeError("permission-denied", `no lifecycle head for "${t.owner}/${t.act.actor}"; a root credential connect requires the current head (SPEC 13.1)`);
    if (head.mapping.state !== "active")
      throw new EpEnvelopeError("permission-denied", `the lifecycle head for "${t.owner}/${t.act.actor}" is "${head.mapping.state}", not active; a root credential of a retiring/retired incarnation does not connect (SPEC 13.1)`);
    if (head.mapping.currentCredentialId !== credid)
      throw new EpEnvelopeError("permission-denied", `the current root credential for "${t.owner}/${t.act.actor}" is ${head.mapping.currentCredentialId ?? "(none)"}, not ${credid}; a superseded root issuance does not connect (deny-new, SPEC 13.1)`);
  }
}
