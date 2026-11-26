import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { JetStreamManager, MsgRequest } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import { fromPublic } from "@nats-io/nkeys";
import { canonicalJson, epAuthBucket, EpEnvelopeError, type EvictionResult, type KickTarget } from "@cotal-ai/core";
import { readConnectCredentialExpiry, type ConnectReader } from "./connect-reader.js";
import { assertWithinSpawnerGrant, findManagedActor, type ActorRow } from "./ledger.js";
import type { NativeIssuance } from "./native-issuance.js";
import type { ValidatedUserToken } from "./token.js";

const PREFIX = "managedconn.";
const PASS_MS = 1000;
const BATCH = 64;
const MAX_EVICTIONS = 4;
const MAX_RETRIES = 1024;

type Receipt = { owner: string; actor: string; lifecycleUid: string; credentialId: string; grant: string; connection: KickTarget; iat: number; exp: number };
type Custody = { space: string; secret: string };

export function managedGrantImage(row: ActorRow): string {
  return createHash("sha256").update(canonicalJson([row.lifecycleUid, row.custody, row.tokenHash, row.parent ?? null, row.role ?? null,
    row.eventPayloads ?? null, [...row.scope].sort(), [...row.allowSubscribe].sort(), [...row.allowPublish].sort()])).digest("base64url");
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

async function stillAuthorized(opts: SweepOptions, row: Receipt): Promise<boolean> {
  const grant = findManagedActor(opts.dir, row.owner, row.actor);
  if (!grant || managedGrantImage(grant) !== row.grant) return false;
  try { assertWithinSpawnerGrant(opts.dir, grant, "exchange"); }
  catch { return false; }
  const { owner, actor, lifecycleUid, credentialId } = row;
  const token: ValidatedUserToken = { owner, space: opts.space, scope: [], ver: 1, exp: row.exp, act: { owner, actor, lifecycleUid, credentialId } };
  try {
    return await readConnectCredentialExpiry(opts.reader(), token, Date.now) >= row.exp;
  } catch (error) {
    if (error instanceof EpEnvelopeError && error.code === "permission-denied") return false;
    throw error;
  }
}

interface SweepOptions extends Custody {
  dir: string;
  kv: KV;
  jsm: JetStreamManager;
  reader(): ConnectReader;
  releaseWindowMs: number;
  canSweep(): boolean;
  evict(principal: string, connections: KickTarget[]): Promise<EvictionResult>;
  log(line: string): void;
}

async function reconcileReceipt(opts: SweepOptions, row: Receipt, purge: () => Promise<void>): Promise<boolean> {
  if (row.exp <= Math.floor(Date.now() / 1000) || await stillAuthorized(opts, row)) return true;
  if (!opts.canSweep()) return false;
  const releaseWindowClosed = Date.now() > row.iat * 1000 + opts.releaseWindowMs + 1000;
  const result = await opts.evict(`${row.owner}.${row.actor}`, [row.connection]);
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
  const retry = (key: string): void => {
    if (!retries.has(key) && retries.size >= MAX_RETRIES) retries.delete(retries.keys().next().value!);
    retries.set(key, Date.now() + 5000);
  };
  const run = async (): Promise<number> => {
    const pending = new Set<Promise<void>>();
    try {
      for (let i = 0; i < BATCH && !stopped && opts.canSweep(); i++) {
        if (pending.size >= MAX_EVICTIONS) await Promise.race(pending);
        const m = await opts.jsm.streams.getMessage(`KV_${bucket}`, { seq: cursor, next_by_subj: `${prefix}${PREFIX}>` } as unknown as MsgRequest);
        if (!m) { cursor = 1; return PASS_MS; }
        cursor = m.seq + 1;
        if (m.header?.get("KV-Operation")) continue;
        const key = m.subject.slice(prefix.length);
        if ((retries.get(key) ?? 0) > Date.now()) continue;
        let row: Receipt | undefined;
        try { row = authenticatedReceipt(m.json(), key, opts); } catch { continue; }
        if (!row) continue;
        const current = reconcileReceipt(opts, row, () => opts.kv.purge(key, { previousSeq: m.seq, ttl: "60s" }))
          .then((done) => { if (done) retries.delete(key); else retry(key); }, (error: unknown) => {
            if (!retries.has(key) && !stopped) opts.log(`auth-plane: managed connection authority could not be checked: ${String(error)}`);
            retry(key);
          }).finally(() => { pending.delete(current); });
        pending.add(current);
      }
      return 0;
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
