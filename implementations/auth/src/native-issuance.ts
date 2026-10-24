/**
 * Native-key issuance evidence (SPEC 13.1 `natkey.`): one create-only row per callout success,
 * keyed by the broker-generated per-connection user public key and bound to the validated
 * bearer's own signed, row-checked claims. It is what lets a later revocation name the exact
 * native key a lifecycle was issued under. It is evidence of an issuance only: a row whose write
 * threw, or whose JWT was never answered, proves nothing about a client or an accepted connection.
 *
 * Coverage is honest and partial: connections admitted before this record existed, responders
 * that do not write it, and static (non-callout) JWTs have no row and are never inferred.
 */
import type { KV } from "@nats-io/kv";
import type { MsgRequest } from "@nats-io/jetstream";
import { fromPublic } from "@nats-io/nkeys";
import {
  EP_AUTH_MARKER_TTL_MS, SERVICE_ACCESS_TTL_SECONDS, contractDigest, epAuthBucket, epcredRowKey, nativeIssuanceKey,
  parseLedgerRow, parseServiceConnectionBinding, parseServiceRegistrationWitness,
  type ServiceConnectionBinding, type ServiceRegistrationWitness,
} from "@cotal-ai/core";
import { CLOCK_TOLERANCE_SEC, type ValidatedUserToken } from "./token.js";
import { registryStores, type LifecycleRegistry } from "./lifecycle-registry.js";

/** The closed v1 record. `connId` is the client's inbox nonce: an attribute, never an identity. */
export interface NativeIssuanceRecord {
  v: 1;
  space: string;
  owner: string;
  actor: string;
  lifecycleUid: string;
  credentialId: string;
  view: string;
  connId: string;
  /** The minted inner JWT's own `iat` and `exp` (seconds); a session-caller's is its grant's. */
  iat: number;
  exp: number;
  service?: { witness: ServiceRegistrationWitness; credentialId: string; connection: ServiceConnectionBinding };
}

/** One callout success, handed to the recorder after the mint and before the response. */
export interface NativeIssuance {
  userNkey: string;
  token: ValidatedUserToken;
  connId: string;
  iat: number;
  exp: number;
  service?: { credentialId: string; connection: ServiceConnectionBinding };
}

export type NativeIssuanceRecorder = (issuance: NativeIssuance) => Promise<void>;

const FIELDS = ["v", "space", "owner", "actor", "lifecycleUid", "credentialId", "view", "connId", "iat", "exp"] as const;

function assertUserNkey(userNkey: string): string {
  const key = nativeIssuanceKey(userNkey);
  fromPublic(userNkey); // the stock nkey codec: checksum and public-key prefix
  return key;
}

function assertSeconds(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) throw new Error(`natkey: ${what} must be a positive integer of seconds`);
  return v;
}

function parseServiceEvidence(raw: unknown): NonNullable<NativeIssuanceRecord["service"]> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("natkey: invalid service evidence");
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).length !== 3 || Object.keys(o).some((k) => !["witness", "credentialId", "connection"].includes(k))
    || typeof o.credentialId !== "string") throw new Error("natkey: invalid service evidence");
  const witness = parseServiceRegistrationWitness(o.witness), connection = parseServiceConnectionBinding(o.connection);
  epcredRowKey(witness.endpoint, witness.instanceId, o.credentialId);
  return { witness, credentialId: o.credentialId, connection };
}

async function verifyServiceEvidence(kv: KV, record: NativeIssuanceRecord): Promise<void> {
  const service = record.service!;
  const key = epcredRowKey(service.witness.endpoint, service.witness.instanceId, service.credentialId), entry = await kv.get(key);
  if (!entry || entry.operation !== "PUT") throw new Error("natkey: service issuance evidence is unavailable");
  const row = parseLedgerRow(entry.value, key);
  if (row.state !== "active" || row.holderPrincipal !== `${record.owner}.${record.actor}` || row.exp !== record.exp
    || row.sourceChain.length !== 1 || row.sourceChain[0] !== "root" || !row.serviceConnection
    || contractDigest(row.serviceConnection) !== contractDigest(service.connection))
    throw new Error("natkey: service issuance evidence does not match the connection");
}

/** Build the record from the validated token alone: never from a fresh alias lookup. */
export function nativeIssuanceRecord(space: string, i: NativeIssuance): NativeIssuanceRecord {
  const t = i.token;
  if (t.space !== space) throw new Error(`natkey: the bearer's space ${JSON.stringify(t.space)} is not this callout's space`);
  const { lifecycleUid, credentialId } = t.act;
  if (lifecycleUid === undefined || credentialId === undefined) throw new Error("natkey: the bearer carries no lifecycle or credential claim; an issuance is recorded only against both");
  const iat = assertSeconds(i.iat, "iat"), exp = assertSeconds(i.exp, "exp");
  if (exp <= iat) throw new Error("natkey: exp must follow iat");
  const record: NativeIssuanceRecord = { v: 1, space, owner: t.owner, actor: t.act.actor, lifecycleUid, credentialId,
    view: t.act.view ?? "agent", connId: i.connId, iat, exp };
  if (t.act.view === "service-endpoint") {
    if (!i.service || !t.act.service || exp > t.exp) throw new Error("natkey: service issuance requires bounded native evidence");
    record.service = parseServiceEvidence({ ...i.service, witness: t.act.service.witness });
    if (record.service.connection.userNkey !== i.userNkey) throw new Error("natkey: service evidence names a different user key");
  } else if (i.service !== undefined) throw new Error("natkey: ordinary issuance cannot carry service evidence");
  return record.service ? parseNativeIssuanceRecord(record) : record;
}

/** Parse a stored row; anything but the closed v1 shape refuses. */
export function parseNativeIssuanceRecord(raw: unknown): NativeIssuanceRecord {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("natkey: record is not an object");
  const keys = Object.keys(raw);
  if (keys.length !== FIELDS.length + (Object.hasOwn(raw, "service") ? 1 : 0) || !FIELDS.every((f) => keys.includes(f))
    || keys.some((key) => key !== "service" && !(FIELDS as readonly string[]).includes(key))) throw new Error(`natkey: record fields ${JSON.stringify(keys.sort())} are not the closed v1 set`);
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) throw new Error("natkey: record version is not 1");
  for (const f of ["space", "owner", "actor", "lifecycleUid", "credentialId", "view", "connId"] as const)
    if (typeof r[f] !== "string" || r[f] === "") throw new Error(`natkey: record ${f} is not a non-empty string`);
  assertSeconds(r.iat, "iat");
  assertSeconds(r.exp, "exp");
  if ((r.view === "service-endpoint") !== Object.hasOwn(r, "service")) throw new Error("natkey: service view and evidence must occur together");
  if (r.service !== undefined) {
    const service = parseServiceEvidence(r.service), witness = service.witness;
    if (r.space !== witness.space || r.owner !== witness.principal.owner || r.actor !== witness.principal.actor
      || r.lifecycleUid !== witness.principal.lifecycleUid || r.credentialId !== witness.rootCredentialId
      || (r.exp as number) <= (r.iat as number) || (r.exp as number) > (r.iat as number) + SERVICE_ACCESS_TTL_SECONDS)
      throw new Error("natkey: service evidence does not match its native root and lifetime");
    return { ...r, service } as unknown as NativeIssuanceRecord;
  }
  return r as unknown as NativeIssuanceRecord;
}

/**
 * The callout recorder: create-only write in the auth bucket (an existing row for the key, under
 * any lifecycle, refuses), then `fence` re-reads the lifecycle and credential authority in the
 * same stream. Any throw is the caller's signed deny; a row written before a throw stays as
 * harmless evidence of an issuance that was never released.
 */
export function makeNativeIssuanceRecorder(registry: LifecycleRegistry, fence: (t: ValidatedUserToken) => Promise<void>): NativeIssuanceRecorder {
  const { authKv, space } = registryStores(registry);
  return async (i) => {
    const key = assertUserNkey(i.userNkey);
    const record = nativeIssuanceRecord(space, i);
    const token = record.service ? structuredClone(i.token) : i.token;
    const bytes = new TextEncoder().encode(JSON.stringify(record));
    if (record.service) {
      await verifyServiceEvidence(authKv, record);
      await authKv.put(key, bytes, { previousSeq: 0 });
      await verifyServiceEvidence(authKv, record);
      const stored = await readNativeIssuance(authKv, i.userNkey);
      if (!stored || contractDigest(stored) !== contractDigest(record)) throw new Error("natkey: service receipt changed before release");
    } else await authKv.create(key, bytes);
    await fence(token);
    if (record.service && record.exp <= Math.floor(Date.now() / 1000))
      throw new Error("natkey: service issuance expired before release");
  };
}

/** Leader-read one key's evidence (the auth bucket is not Direct-capable). Absent is `undefined`. */
export async function readNativeIssuance(kv: KV, userNkey: string): Promise<NativeIssuanceRecord | undefined> {
  const entry = await kv.get(assertUserNkey(userNkey));
  if (!entry || entry.operation !== "PUT") return undefined;
  const record = parseNativeIssuanceRecord(entry.json());
  if (record.service && record.service.connection.userNkey !== userNkey) throw new Error("natkey: service receipt key does not match its connection");
  return record;
}

/**
 * Remove the rows whose minted JWT expired more than the clock tolerance ago (a session-caller's
 * row carries its grant's expiry, so it lives as long as that grant). The walk is the leader-served
 * `STREAM.MSG.GET` `next_by_subj` read over `natkey.` (no consumer: none may be created on the auth
 * bucket), and each removal is a KV purge pinned to the exact sequence read. A row that does not
 * parse throws: corrupt evidence is the caller's fault to surface, never a skipped row. The purge
 * marker carries the bucket's own marker TTL, so it expires too. Expired service evidence is
 * retained: elapsed JWT time alone is not topology-qualified absence or terminal retirement.
 */
export async function pruneNativeIssuance(registry: LifecycleRegistry, nowSec: number): Promise<{ live: number; pruned: number; retainedService: number }> {
  const { authKv, jsm, space } = registryStores(registry);
  const bucket = epAuthBucket(space);
  const prefix = `$KV.${bucket}.`;
  let seq = 1, live = 0, pruned = 0, retainedService = 0;
  for (;;) {
    const m = await jsm.streams.getMessage(`KV_${bucket}`, { seq, next_by_subj: `${prefix}natkey.>` } as unknown as MsgRequest);
    if (!m) break;
    seq = m.seq + 1;
    const op = m.header?.get("KV-Operation");
    if (op === "DEL" || op === "PURGE") continue;
    const key = m.subject.slice(prefix.length);
    if (assertUserNkey(key.slice("natkey.".length)) !== key) throw new Error(`natkey: stored subject ${JSON.stringify(m.subject)} is not a natkey row`);
    const record = parseNativeIssuanceRecord(m.json());
    if (record.service && nativeIssuanceKey(record.service.connection.userNkey) !== key)
      throw new Error("natkey: service receipt key does not match its connection");
    if (record.exp + CLOCK_TOLERANCE_SEC < nowSec && record.service) {
      retainedService++;
    } else if (record.exp + CLOCK_TOLERANCE_SEC < nowSec) {
      await authKv.purge(key, { previousSeq: m.seq, ttl: `${EP_AUTH_MARKER_TTL_MS / 1000}s` });
      pruned++;
    } else live++;
  }
  return { live, pruned, retainedService };
}
