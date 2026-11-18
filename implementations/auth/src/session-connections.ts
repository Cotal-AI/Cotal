import { createHmac, timingSafeEqual } from "node:crypto";
import type { JetStreamManager, MsgRequest } from "@nats-io/jetstream";
import type { KV } from "@nats-io/kv";
import { fromPublic } from "@nats-io/nkeys";
import { EP_AUTH_MARKER_TTL_MS, assertLifecycleToken, epAuthBucket, parsePrincipalKey, sessionLedgerKey, sessionsBucket, type EvictionResult, type KickTarget, type SessionLedgerRow } from "@cotal-ai/core";
import type { NativeIssuance } from "./native-issuance.js";

/** Auth-host authenticated issuance evidence, including the session revision observed at release. */
interface SessionConnection {
  sessionId: string;
  principal: string;
  lifecycleUid: string;
  connection: KickTarget;
  releaseAfter: number;
  sessionRevision: number;
}
interface SignedSessionConnection { v: 1; row: SessionConnection; mac: string }
const PREFIX = "sessionconn.";
const markerTtl = `${EP_AUTH_MARKER_TTL_MS / 1000}s`;

function signature(secret: string, space: string, key: string, row: SessionConnection): Buffer {
  return createHmac("sha256", secret).update(JSON.stringify(["cotal-session-connection-v1", space, key, row])).digest();
}
function validateRow(raw: unknown): SessionConnection {
  const r = raw as SessionConnection | null;
  if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).length !== 6 ||
    typeof r.sessionId !== "string" || typeof r.principal !== "string" || typeof r.lifecycleUid !== "string" ||
    !r.connection || !/^N[A-Z2-7]{55}$/.test(r.connection.serverId) || !Number.isSafeInteger(r.connection.cid) || r.connection.cid <= 0 ||
    !Number.isSafeInteger(r.releaseAfter) || r.releaseAfter <= 0 || !Number.isSafeInteger(r.sessionRevision) || r.sessionRevision <= 0)
    throw new Error("session connection evidence is malformed");
  sessionLedgerKey(r.sessionId);
  parsePrincipalKey(r.principal);
  assertLifecycleToken(r.lifecycleUid, "session holder lifecycle");
  return r;
}
function sessionState(raw: unknown, row: Pick<SessionConnection, "sessionId" | "principal" | "lifecycleUid">): SessionLedgerRow {
  const state = raw as SessionLedgerRow | null;
  if (!state || state.sessionId !== row.sessionId || state.holder?.principal !== row.principal || state.holder.lifecycleUid !== row.lifecycleUid ||
    !["issuing", "active", "closed", "expired", "superseded", "retired"].includes(state.state) || !Number.isSafeInteger(state.exp))
    throw new Error("session connection authority does not match its recorded holder");
  return state;
}

/** Persist signed broker coordinates only after observing the caller's live session authority. */
export async function recordSessionConnection(kv: KV, issuance: NativeIssuance, authority: { jsm: JetStreamManager; space: string; secret: string }): Promise<void> {
  const { token, connection } = issuance;
  if (token.act.view !== "session-caller") return;
  if (!connection || !token.act.session || !token.act.lifecycleUid) throw new Error("session connection evidence requires broker coordinates and session authority");
  fromPublic(issuance.userNkey);
  const key = `${PREFIX}${issuance.userNkey}`;
  const bucket = sessionsBucket(authority.space);
  const session = await authority.jsm.streams.getMessage(`KV_${bucket}`, { last_by_subj: `$KV.${bucket}.${sessionLedgerKey(token.act.session.sessionId)}` });
  if (!session || session.header?.get("KV-Operation")) throw new Error("session connection requires an existing active session");
  const row = validateRow({ sessionId: token.act.session.sessionId, principal: `${token.owner}.${token.act.actor}`,
    lifecycleUid: token.act.lifecycleUid, connection, releaseAfter: Date.now(), sessionRevision: session.seq });
  const state = sessionState(session.json(), row);
  if (state.state !== "active" || state.exp <= Date.now()) throw new Error("session connection requires an existing active session");
  const evidence: SignedSessionConnection = { v: 1, row, mac: signature(authority.secret, authority.space, key, row).toString("base64url") };
  await kv.create(key, JSON.stringify(evidence));
}

/** Reconcile bounded leader reads. Invalid evidence is quarantined; transient failures retain rows and advance. */
export async function reconcileSessionConnections(opts: {
  jsm: JetStreamManager; kv: KV; space: string; secret: string; seq: number; maxRows: number; releaseWindowMs: number; signal: AbortSignal;
  log?: (line: string) => void;
  transient?: () => void;
  retryLogged?: Set<string>;
  retries?: Map<string, { nextAt: number; delayMs: number }>;
  evict(principal: string, connections: KickTarget[]): Promise<EvictionResult>;
}): Promise<number | undefined> {
  const bucket = epAuthBucket(opts.space), prefix = `$KV.${bucket}.`;
  const forget = (key: string) => { opts.retries?.delete(key); opts.retryLogged?.delete(key); };
  const retry = (key: string, diagnostic?: string) => {
    opts.transient?.();
    if (diagnostic && !opts.retryLogged?.has(key)) {
      opts.log?.(diagnostic);
      if (opts.retryLogged) {
        if (opts.retryLogged.size >= 1024) opts.retryLogged.delete(opts.retryLogged.values().next().value!);
        opts.retryLogged.add(key);
      }
    }
    if (opts.retries) {
      const delayMs = Math.min((opts.retries.get(key)?.delayMs ?? 1000) * 2, 30_000);
      if (!opts.retries.has(key) && opts.retries.size >= 1024) opts.retries.delete(opts.retries.keys().next().value!);
      opts.retries.set(key, { nextAt: Date.now() + delayMs, delayMs });
    }
  };
  let seq = opts.seq;
  for (let visited = 0; visited < opts.maxRows; visited++) {
    opts.signal.throwIfAborted();
    const message = await opts.jsm.streams.getMessage(`KV_${bucket}`, { seq, next_by_subj: `${prefix}${PREFIX}>` } as unknown as MsgRequest);
    if (!message) return undefined;
    opts.signal.throwIfAborted();
    seq = message.seq + 1;
    const key = message.subject.slice(prefix.length);
    if (message.header?.get("KV-Operation")) { forget(key); continue; }
    if ((opts.retries?.get(key)?.nextAt ?? 0) > Date.now()) continue;
    let row: SessionConnection;
    try {
      fromPublic(key.slice(PREFIX.length));
      const signed = message.json<SignedSessionConnection>();
      if (signed?.v !== 1 || typeof signed.mac !== "string") throw new Error("session connection evidence is unsigned");
      row = validateRow(signed.row);
      const expected = signature(opts.secret, opts.space, key, row), actual = Buffer.from(signed.mac, "base64url");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error("session connection evidence authentication failed");
    } catch {
      try {
        await opts.kv.purge(key, { previousSeq: message.seq, ttl: markerTtl });
        forget(key);
        opts.log?.("auth-plane: quarantined invalid session connection evidence");
      } catch { retry(key); }
      continue;
    }
    try {
      const sessions = sessionsBucket(opts.space);
      let session;
      try { session = await opts.jsm.streams.getMessage(`KV_${sessions}`, { last_by_subj: `$KV.${sessions}.${sessionLedgerKey(row.sessionId)}` }); }
      catch (e) { if ((e as { code?: unknown }).code !== 10037) throw e; }
      opts.signal.throwIfAborted();
      // A verified receipt proves a real session revision was observed before access was released.
      if (session && session.seq < row.sessionRevision) {
        retry(key, `auth-plane: session authority revision ${session.seq} precedes authenticated receipt revision ${row.sessionRevision}; evidence retained for retry`);
        continue;
      }
      let ended = !session || !!session.header?.get("KV-Operation");
      if (!ended) {
        let raw: SessionLedgerRow;
        try {
          raw = session!.json<SessionLedgerRow>();
          if (!raw || typeof raw !== "object" || typeof raw.sessionId !== "string" ||
            typeof raw.holder?.principal !== "string" || typeof raw.holder.lifecycleUid !== "string" ||
            !["issuing", "active", "closed", "expired", "superseded", "retired"].includes(raw.state) || !Number.isSafeInteger(raw.exp))
            throw new Error("invalid session authority");
        } catch {
          retry(key, "auth-plane: session authority is unreadable; authenticated evidence retained for retry");
          continue;
        }
        opts.retryLogged?.delete(key);
        let state: SessionLedgerRow;
        try { state = sessionState(raw, row); }
        catch {
          await opts.kv.purge(key, { previousSeq: message.seq, ttl: markerTtl });
          forget(key);
          opts.log?.("auth-plane: quarantined mismatched session connection authority");
          continue;
        }
        ended = state.state !== "active" || state.exp <= Date.now();
      }
      if (!ended) { forget(key); continue; }
      const result = await opts.evict(row.principal, [row.connection]);
      opts.signal.throwIfAborted();
      if (!result.verifiedGone) { retry(key); continue; }
      if (Date.now() <= row.releaseAfter + opts.releaseWindowMs) continue;
      await opts.kv.purge(key, { previousSeq: message.seq, ttl: markerTtl });
      forget(key);
    } catch (e) {
      if (opts.signal.aborted) throw e;
      retry(key);
    }
  }
  return seq;
}
