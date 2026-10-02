/**
 * #2312: the identity plane's decision for a user-mode session redemption.
 *
 * On a user-auth mesh the CLI holds no seed, so it cannot mint the per-session `session-caller`
 * credential the static arm signs locally. Instead it presents its bearer identity together with the
 * session grant, and THIS module decides whether that principal may hold that one session. The
 * manager signs grants with an in-memory key the auth plane never sees, so the verifiable artifact is
 * the durable `session.<sessionId>` row the manager's redemption wrote (create-only CAS, then
 * finalized `active`), read leader-served from the dedicated sessions store. The grant's signature
 * must equal the row's `grantSig`, so a forged or altered grant that reuses a session id refuses.
 *
 * Run at the exchange (before a bearer is signed) and again at the callout mint (before the broker
 * credential exists), so a session that ends or a manager that restarts in between still refuses.
 */
import type { JetStreamManager } from "@nats-io/jetstream";
import { EpEnvelopeError, sessionLedgerKey, sessionsBucket, type SessionGrant } from "@cotal-ai/core";
import type { UserTokenSession } from "./token.js";

/** What the verifier reads: the leader-served session row, and the serving manager's current gate. */
export interface SessionRedemptionReads {
  jsm: JetStreamManager;
  space: string;
  /** The serving manager gate's verdict for (owner, instanceId) and its current process epoch. */
  managerGate: (owner: string, instanceId: string) => Promise<{ verdict: string; processEpoch?: number }>;
}

interface Row {
  sessionId: string;
  endpoint: string;
  serving: { instanceId: string; epoch: number };
  holder: { principal: string; lifecycleUid: string };
  grantSig: string;
  state: string;
  exp: number;
}

const deny = (why: string): never => {
  throw new EpEnvelopeError("permission-denied", `session redemption refused: ${why}`);
};

async function readRow(r: SessionRedemptionReads, sessionId: string): Promise<Row> {
  const bucket = sessionsBucket(r.space);
  let m;
  try {
    m = await r.jsm.streams.getMessage(`KV_${bucket}`, { last_by_subj: `$KV.${bucket}.${sessionLedgerKey(sessionId)}` });
  } catch (e) {
    if ((e as { code?: unknown }).code === 10037) deny(`no session row for ${sessionId}`);
    throw e;
  }
  if (!m) deny(`no session row for ${sessionId}`);
  if (m!.header?.get("KV-Operation")) deny(`the session row for ${sessionId} is deleted`);
  return JSON.parse(new TextDecoder().decode(m!.data)) as Row;
}

/**
 * Decide whether `principal` (owner + actor + lifecycleUid from a validated bearer) may hold the
 * session named by `claim`. `grantSig` is present at the exchange (the presented grant) and absent at
 * the callout, which re-checks the same row by its coordinates. Returns the session claim to stamp,
 * with the expiry taken from the ROW (unix seconds), never from the caller. THROWS to refuse.
 */
export async function verifySessionRedemption(
  r: SessionRedemptionReads,
  principal: { owner: string; actor: string; lifecycleUid?: string },
  claim: { endpoint: string; sessionId: string; epoch: number; grantSig?: string },
  now: number = Date.now(),
): Promise<UserTokenSession> {
  const row = await readRow(r, claim.sessionId);
  if (row.state !== "active") deny(`session ${claim.sessionId} is "${row.state}", not active`);
  if (claim.grantSig !== undefined && row.grantSig !== claim.grantSig) deny("the presented grant is not the one this session was redeemed with");
  const holder = `${principal.owner}.${principal.actor}`;
  if (row.holder.principal !== holder) deny(`session ${claim.sessionId} was issued to ${row.holder.principal}, not ${holder}`);
  if (principal.lifecycleUid === undefined || row.holder.lifecycleUid !== principal.lifecycleUid) deny("the bearer's lifecycle is not the session holder's");
  if (row.endpoint !== claim.endpoint) deny(`session ${claim.sessionId} is on endpoint ${row.endpoint}, not ${claim.endpoint}`);
  if (row.serving.epoch !== claim.epoch) deny(`session ${claim.sessionId} is pinned to serving epoch ${row.serving.epoch}, not ${claim.epoch}`);
  if (row.exp <= now) deny(`session ${claim.sessionId} expired at ${new Date(row.exp).toISOString()}`);
  const gate = await r.managerGate(principal.owner, row.serving.instanceId);
  if (gate.verdict !== "candidate") deny(`the serving manager ${row.serving.instanceId} is ${gate.verdict}`);
  if (gate.processEpoch !== row.serving.epoch) deny(`the serving manager's epoch is ${String(gate.processEpoch)}, not the session's ${row.serving.epoch}`);
  return { endpoint: row.endpoint, sessionId: row.sessionId, epoch: row.serving.epoch, exp: Math.floor(row.exp / 1000) };
}

/** The grant fields the exchange reads. The grant is never trusted for anything the row does not
 *  confirm: only its coordinates select the row, and its signature must equal the row's. */
export function grantCoordinates(raw: unknown): { endpoint: string; sessionId: string; epoch: number; grantSig: string } {
  const g = raw as Partial<SessionGrant> | null;
  if (!g || typeof g !== "object" || typeof g.sessionId !== "string" || typeof g.endpoint !== "string" ||
      typeof g.sig !== "string" || typeof g.serving?.epoch !== "number")
    throw new Error("sessionGrant is not a session grant");
  return { endpoint: g.endpoint, sessionId: g.sessionId, epoch: g.serving.epoch, grantSig: g.sig };
}
