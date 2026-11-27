import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { JetStreamManager, MsgRequest } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import { fromPublic } from "@nats-io/nkeys";
import { EpEnvelopeError, canonicalJson, epAuthBucket, type EvictionResult, type KickTarget } from "@cotal-ai/core";
import { connectReaderDefinitiveRefusal, readConnectCredentialExpiry, type ConnectReader } from "./connect-reader.js";
import { assertWithinSpawnerGrant, findActorUnified, isDefinitiveLedgerRefusal, type ActorRow } from "./ledger.js";
import type { NativeIssuance } from "./native-issuance.js";
import type { ValidatedUserToken } from "./token.js";

const PREFIX = "managedconn.";
const PASS_MS = 1000;
const BATCH_PACE_MS = 100;
const BATCH = 64;
const MAX_EVICTIONS = 4;
const RETRY_MS = 5000;

type Receipt = { owner: string; actor: string; lifecycleUid: string; credentialId: string; grant: string; connection: KickTarget; iat: number; exp: number };
type Custody = { space: string; secret: string };

export function managedGrantImage(row: ActorRow): string {
  return createHash("sha256").update(canonicalJson([row.lifecycleUid, row.custody, row.tokenHash, row.parent ?? null, row.role ?? null,
    row.eventPayloads ?? null, [...row.scope].sort(), [...row.allowSubscribe].sort(), [...row.allowPublish].sort()])).digest("base64url");
}

/** Issuance and reconciliation share this unified grant and delegation read. */
export function managedConnectionGrant(dir: string, owner: string, actor: string, uid: string | undefined): ActorRow | undefined {
  const row = findActorUnified(dir, owner, actor);
  if (row?.kind !== "managed-agent" || !row.custody || row.custody.kind === "foreground" || row.lifecycleUid !== uid) return;
  assertWithinSpawnerGrant(dir, row, "exchange");
  return row;
}

function mac(opts: Custody, key: string, row: Receipt): Buffer {
  return createHmac("sha256", opts.secret).update(canonicalJson(["cotal-managed-connection-v1", opts.space, key, row])).digest();
}

/** Persist the broker's coordinates before releasing a long-lived connection JWT. */
export async function recordManagedConnection(kv: KV, i: NativeIssuance, opts: Custody): Promise<void> {
  const { token, connection, iat, exp } = i;
  const { lifecycleUid, credentialId } = token.act;
  if (!connection || !lifecycleUid || !credentialId || !i.managed || !Number.isSafeInteger(connection.cid) || connection.cid <= 0)
    throw new Error("managed issuance requires its exact broker connection and live root");
  fromPublic(i.userNkey);
  const key = `${PREFIX}${i.userNkey}`;
  const row = { owner: token.owner, actor: token.act.actor, lifecycleUid, credentialId, grant: i.managed, connection, iat, exp };
  const signature = mac(opts, key, row).toString("base64url");
  const ttl = Math.max(1, exp - Math.floor(Date.now() / 1000) + 60);
  await kv.create(key, JSON.stringify({ row, signature }), `${ttl}s`);
}

function authenticatedReceipt(value: unknown, key: string, opts: Custody): Receipt | undefined {
  try {
    const { row, signature } = value as { row: Receipt; signature: string };
    const expected = mac(opts, key, row), actual = Buffer.from(signature, "base64url");
    if (expected.length === actual.length && timingSafeEqual(expected, actual)) return row;
  } catch { /* unreadable or unauthenticated evidence cannot authorize KICK */ }
}

async function stillAuthorized(opts: SweepOptions, row: Receipt, cache: PassCache): Promise<boolean> {
  const { owner, actor, lifecycleUid, credentialId } = row;
  const principalKey = `${owner}\0${actor}\0${lifecycleUid}`;
  let grantImage = cache.grants.get(principalKey);
  if (!cache.grants.has(principalKey)) {
    try {
      const grant = managedConnectionGrant(opts.dir, owner, actor, lifecycleUid);
      grantImage = grant ? managedGrantImage(grant) : null;
      cache.grants.set(principalKey, grantImage);
    } catch (error) {
      if (!isDefinitiveLedgerRefusal(error) && !(error instanceof EpEnvelopeError && error.cause === undefined)) throw error;
      grantImage = null;
      cache.grants.set(principalKey, grantImage);
    }
  }
  if (!grantImage || grantImage !== row.grant) return false;
  const credKey = `${principalKey}\0${credentialId}`;
  let rootRead = cache.roots.get(credKey);
  if (!rootRead) {
    const token: ValidatedUserToken = { owner, space: opts.space, scope: [], ver: 1, exp: row.exp, act: { owner, actor, lifecycleUid, credentialId } };
    rootRead = Promise.resolve().then(() => readConnectCredentialExpiry(opts.reader(), token, Date.now)).catch((error: unknown) => {
      if (!connectReaderDefinitiveRefusal(error)) {
        cache.roots.delete(credKey);
        throw error;
      }
      return -1;
    });
    cache.roots.set(credKey, rootRead);
  }
  return (await rootRead) >= row.exp;
}

interface PassCache {
  grants: Map<string, string | null>;
  roots: Map<string, Promise<number>>;
}

export interface SweepOptions extends Custody {
  dir: string;
  kv: KV;
  jsm: JetStreamManager;
  reader(): ConnectReader;
  releaseWindowMs: number;
  canSweep(): boolean;
  evict(principal: string, connections: KickTarget[]): Promise<EvictionResult>;
  log(line: string): void;
}

async function reconcileReceipt(
  opts: SweepOptions,
  row: Receipt,
  cache: PassCache,
  purge: () => Promise<void>,
  logEvictionFailure: (note: string) => void,
): Promise<boolean> {
  if (row.exp <= Math.floor(Date.now() / 1000) || await stillAuthorized(opts, row, cache)) return true;
  if (!opts.canSweep()) return false;
  const releaseWindowClosed = Date.now() > row.iat * 1000 + opts.releaseWindowMs + 1000;
  const result = await opts.evict(`${row.owner}.${row.actor}`, [row.connection]);
  if (!result.verifiedGone) logEvictionFailure(result.note ?? "delivery did not verify absence");
  if (result.verifiedGone && releaseWindowClosed) await purge();
  return result.verifiedGone;
}

/** Reconcile durable receipts across grant writers and auth process restarts. */
export function startManagedConnectionSweep(opts: SweepOptions): () => Promise<void> {
  const bucket = epAuthBucket(opts.space), prefix = `$KV.${bucket}.`;
  let cursor = 1, stopped = false, noisy = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flight: Promise<void> = Promise.resolve();
  const retries = new Map<string, number>();
  const loggedEvictions = new Map<string, number>();
  const retry = (key: string): void => { retries.set(key, Date.now() + RETRY_MS); };
  let cache: PassCache = { grants: new Map(), roots: new Map() };
  const run = async (): Promise<number> => {
    const pending = new Set<Promise<void>>();
    try {
      for (let i = 0; i < BATCH && !stopped && opts.canSweep(); i++) {
        if (pending.size >= MAX_EVICTIONS) await Promise.race(pending);
        let m;
        try {
          m = await opts.jsm.streams.getMessage(`KV_${bucket}`, { seq: cursor, next_by_subj: `${prefix}${PREFIX}>` } as unknown as MsgRequest);
        } catch (error) {
          if ((error as { code?: unknown }).code === 10037) m = null;
          else throw error;
        }
        if (!m) {
          cursor = 1;
          cache = { grants: new Map(), roots: new Map() };
          for (const [key, at] of loggedEvictions) if (at <= Date.now()) loggedEvictions.delete(key);
          for (const [key, at] of retries) if (at <= Date.now() - RETRY_MS) retries.delete(key);
          return PASS_MS;
        }
        cursor = m.seq + 1;
        if (m.header?.get("KV-Operation")) continue;
        const key = m.subject.slice(prefix.length);
        if ((retries.get(key) ?? 0) > Date.now()) continue;
        let row: Receipt | undefined;
        try { row = authenticatedReceipt(m.json(), key, opts); } catch { continue; }
        if (!row) continue;
        const logEvictionFailure = (note: string) => {
          if (loggedEvictions.has(key) || stopped) return;
          loggedEvictions.set(key, row.exp * 1000);
          opts.log(`auth-plane: managed eviction unverified for ${row.owner}.${row.actor} on ${row.connection.serverId}/${row.connection.cid}: ${note}`);
        };
        const passCache = cache;
        const current = reconcileReceipt(opts, row, passCache, () => opts.kv.purge(key, { previousSeq: m.seq, ttl: "60s" }), logEvictionFailure)
          .then((done) => { if (done) retries.delete(key); else retry(key); }, (error: unknown) => {
            if (!retries.has(key) && !stopped) opts.log(`auth-plane: managed connection authority could not be checked: ${String(error)}`);
            retry(key);
          }).finally(() => { pending.delete(current); });
        pending.add(current);
      }
      return BATCH_PACE_MS;
    } finally { await Promise.all(pending); }
  };
  const schedule = (delay: number): void => {
    if (stopped || !opts.canSweep()) return;
    timer = setTimeout(() => {
      if (stopped || !opts.canSweep()) return;
      flight = run().then((next) => { noisy = false; schedule(next); }, (error: unknown) => {
        if (!noisy && !stopped) opts.log(`auth-plane: managed connection reconciliation failed: ${String(error)}`);
        noisy = true;
        schedule(PASS_MS);
      });
    }, delay);
    timer.unref?.();
  };
  schedule(PASS_MS);
  return async () => { stopped = true; clearTimeout(timer); await flight; };
}
