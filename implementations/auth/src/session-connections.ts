import type { JetStreamManager, MsgRequest } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import { epAuthBucket, sessionLedgerKey, sessionsBucket, type EvictionResult, type KickTarget, type SessionLedgerRow } from "@cotal-ai/core";
import type { NativeIssuance } from "./native-issuance.js";

/** Private auth-host evidence. This is not a native issuance or session ledger wire record. */
interface SessionConnection {
  sessionId: string;
  principal: string;
  lifecycleUid: string;
  connection: KickTarget;
  releaseAfter: number;
}

const PREFIX = "sessionconn.";

/** Persist exact broker coordinates before releasing a session caller's credential. */
export async function recordSessionConnection(kv: KV, issuance: NativeIssuance): Promise<void> {
  const { token, connection } = issuance;
  if (token.act.view !== "session-caller") return;
  if (!connection || !/^N[A-Z2-7]{55}$/.test(connection.serverId) || !Number.isSafeInteger(connection.cid) || connection.cid <= 0 ||
    !token.act.session || !token.act.lifecycleUid) throw new Error("session connection evidence requires broker coordinates and session authority");
  const row: SessionConnection = {
    sessionId: token.act.session.sessionId,
    principal: `${token.owner}.${token.act.actor}`,
    lifecycleUid: token.act.lifecycleUid,
    connection,
    releaseAfter: Date.now(),
  };
  await kv.create(`${PREFIX}${issuance.userNkey}`, JSON.stringify(row));
}

/** Reconcile a bounded, leader-read batch. Failed reads or kicks retain evidence for retry. */
export async function reconcileSessionConnections(opts: {
  jsm: JetStreamManager;
  kv: KV;
  space: string;
  seq: number;
  maxRows: number;
  releaseWindowMs: number;
  signal: AbortSignal;
  evict(principal: string, connections: KickTarget[]): Promise<EvictionResult>;
}): Promise<number | undefined> {
  const bucket = epAuthBucket(opts.space), prefix = `$KV.${bucket}.`;
  let seq = opts.seq;
  for (let visited = 0; visited < opts.maxRows; visited++) {
    opts.signal.throwIfAborted();
    const message = await opts.jsm.streams.getMessage(`KV_${bucket}`, { seq, next_by_subj: `${prefix}${PREFIX}>` } as unknown as MsgRequest);
    if (!message) return undefined;
    seq = message.seq + 1;
    if (message.header?.get("KV-Operation")) continue;
    const row = message.json<SessionConnection>();
    if (!row || typeof row.sessionId !== "string" || !row.sessionId || typeof row.principal !== "string" ||
      typeof row.lifecycleUid !== "string" || !row.connection || !/^N[A-Z2-7]{55}$/.test(row.connection.serverId) ||
      !Number.isSafeInteger(row.connection.cid) || row.connection.cid <= 0 || !Number.isSafeInteger(row.releaseAfter))
      throw new Error("session connection evidence is malformed");
    const sessions = sessionsBucket(opts.space);
    let session;
    try {
      session = await opts.jsm.streams.getMessage(`KV_${sessions}`, { last_by_subj: `$KV.${sessions}.${sessionLedgerKey(row.sessionId)}` });
    } catch (e) { if ((e as { code?: unknown }).code !== 10037) throw e; }
    let ended = !session || !!session.header?.get("KV-Operation");
    if (!ended) {
      const state = session!.json<SessionLedgerRow>();
      if (state.sessionId !== row.sessionId || state.holder?.principal !== row.principal || state.holder.lifecycleUid !== row.lifecycleUid ||
        !["issuing", "active", "closed", "expired", "superseded", "retired"].includes(state.state) || !Number.isSafeInteger(state.exp))
        throw new Error("session connection authority does not match its recorded holder");
      ended = state.state !== "active" || state.exp <= Date.now();
    }
    if (!ended) continue;
    const result = await opts.evict(row.principal, [row.connection]);
    if (!result.verifiedGone) throw new Error(`session eviction was not verified: ${result.note ?? "incomplete scan"}`);
    // A callout response can bind after the first scan. Repeat through its bounded release window.
    if (Date.now() <= row.releaseAfter + opts.releaseWindowMs) continue;
    await opts.kv.purge(message.subject.slice(prefix.length), { previousSeq: message.seq });
  }
  return seq;
}
