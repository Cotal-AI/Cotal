/**
 * D5 slice 4 — BROKER-BACKED LIVE CONNECTION EVICTION.
 *
 * Revocation has two halves. DENY-NEW (ledger revoke, cred expiry, stripped signer, ACL removal)
 * stops the next exchange/connect — but a client that is ALREADY connected with a still-valid JWT
 * keeps its live core subscriptions until that JWT expires. KILL-LIVE closes that window now:
 * `$SYS.REQ.SERVER.<serverID>.KICK {cid}` disconnects one live client by connection id.
 *
 * This module is the kill-live primitive and its two credentials, kept deliberately small (the
 * simplicity-lane shape: one eviction path, not a parallel subsystem):
 *  - the OBSERVER read (account CONNZ, `auth:true`) projected to `{cid, serverId, principal}` — a
 *    DIFFERENT projection than the membership feed's channel-folding (it keeps cid+serverId, which
 *    the feed discards), so it is its own tiny scan, not duplicated filtering;
 *  - the kill: `evictPrincipal(observerConn, evictorConn, accountId, principal)` = scan → KICK each
 *    matching cid on the SERVER THE CID CAME FROM → re-scan to verify, bounded, structured.
 *
 * Two credentials by design (never one broad sys user that both enumerates and kills):
 *  - the existing `membership-observer` (CONNZ-read only) does discovery;
 *  - a NEW kick-only evictor (`$SYS.REQ.SERVER.*.KICK` and nothing else) does the kill.
 * Both are system-account users mintable ONLY at the `up` that provisions the account (the $SYS
 * signing seed is never persisted) — so the evictor is a standing, high-power, renewable credential,
 * classified with the observer, surfaced by the stale-auth diagnostics when absent.
 *
 * SEMANTICS, stated in the result (never inferred):
 *  - KICK has NO per-cid ack, so success is proven only by a re-scan showing the principal gone.
 *  - A PARTIAL/unavailable CONNZ read is `verifiedGone:false` with `scanComplete:false` — NEVER a
 *    silent success (the membership feed's truthium rule; a caller/flip gate stays blocked).
 *  - "principal not currently live" is a no-op SUCCESS (`kicked:0, remaining:0, verifiedGone:true`)
 *    — idempotent, so repair/doctor tooling never needs "already gone" special-casing.
 *  - This is ALWAYS paired with a committed deny-new by the caller: a kicked client reconnects with
 *    a fresh cid until its cred dies, so an evict-only loop would chase churn. The name says so.
 */
import type { NatsConnection } from "@nats-io/transport-node";
import { connzRequestSubject, principalFromConnz, serverKickSubject, MEMBERSHIP_INBOX_PREFIX } from "./subjects.js";

const enc = (s: string) => new TextEncoder().encode(s);
const MAX_PAGES = 64; // fan-out pagination guard (mirrors the membership feed's under-report ceiling)

/** One live connection, projected for eviction: which server holds it (KICK is per-server) and its
 *  attributed principal (the callout/mint-stamped `principal:` tag — NEVER the ephemeral nkey). */
interface LiveConn {
  cid: number;
  serverId: string;
  principal: string;
}

interface ConnzConn {
  cid?: number;
  tags?: string[];
  /** For a CALLOUT-minted user this carries the principal NAME-form (the JWT name); for a static
   *  user it's the ephemeral nkey. {@link principalFromConnz} disambiguates. */
  authorized_user?: string;
}
interface ConnzReply {
  server?: { id?: string };
  data?: { server_id?: string; total?: number; offset?: number; connections?: ConnzConn[] };
}

/** The structured outcome of an eviction attempt — every field a repair/flip gate reads to decide
 *  "done" vs "blocked". `verifiedGone` is the ONLY success signal; it is true only when a COMPLETE
 *  re-scan found zero live cids for the principal. */
export interface EvictionResult {
  principal: string;
  /** cids KICKed across all servers this attempt. */
  kicked: number;
  /** cids still live for the principal after the verify deadline (0 with `verifiedGone` = success). */
  remaining: number;
  /** True iff a COMPLETE re-scan proved the principal has no live connection. Partial/failed scans
   *  are false — a caller must treat false as "not verified", never "probably fine". */
  verifiedGone: boolean;
  /** False if any CONNZ round under-reported (no responder, pagination truncation) — the result is
   *  UNKNOWN, not success, even if `kicked` > 0. */
  scanComplete: boolean;
  /** Human-readable per-attempt note (scan errors, deadline hit) for the daemon log / doctor. */
  note?: string;
}

/** Options bounding the scan→kick→re-scan loop. Defaults suit a local single-server broker; the
 *  cluster case widens the settle window. */
export interface EvictOptions {
  /** How many verify re-scans to attempt before reporting `remaining` (default 3). */
  maxVerifyRounds?: number;
  /** Per-CONNZ-round settle window in ms after the last reply (default 250). */
  settleMs?: number;
  /** Hard per-round ceiling in ms (default 2000). */
  maxWaitMs?: number;
  pageLimit?: number;
}

/** Scan this account's live connections, projected to `{cid, serverId, principal}`. Returns
 *  `complete:false` when any round under-reported (zero replies = broker unreachable/denied, or a
 *  MAX_PAGES truncation) so a caller never mistakes a partial read for "no such connection". */
async function scanLive(
  observerConn: NatsConnection,
  accountId: string,
  opts: Required<Pick<EvictOptions, "settleMs" | "maxWaitMs" | "pageLimit">>,
): Promise<{ conns: LiveConn[]; complete: boolean }> {
  const conns: LiveConn[] = [];
  let gotAnyReply = false;
  let truncated = false;
  let seq = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * opts.pageLimit;
    const replies = await connzRound(observerConn, accountId, offset, opts, seq++);
    if (replies.length) gotAnyReply = true;
    let fullPageSomewhere = false;
    for (const r of replies) {
      const serverId = r.data?.server_id ?? r.server?.id;
      if (!serverId) continue; // a reply we can't route a KICK back to is unusable — skip (drops completeness below)
      const cs = r.data?.connections ?? [];
      for (const c of cs) {
        // Attribute across BOTH cred shapes — a callout user surfaces its principal as the
        // `authorized_user` name-form (no tags), a static user surfaces the `principal:` tag.
        const principal = principalFromConnz(c);
        if (typeof c.cid === "number" && principal) conns.push({ cid: c.cid, serverId, principal });
      }
      const total = r.data?.total ?? 0;
      if (cs.length >= opts.pageLimit && offset + cs.length < total) fullPageSomewhere = true;
    }
    if (!fullPageSomewhere) break; // no server still has a full page → done
    if (page === MAX_PAGES - 1) truncated = true;
  }
  return { conns, complete: gotAnyReply && !truncated };
}

/** One CONNZ round: fan out the account request, collect every server's reply within the window. */
function connzRound(
  observerConn: NatsConnection,
  accountId: string,
  offset: number,
  opts: Required<Pick<EvictOptions, "settleMs" | "maxWaitMs" | "pageLimit">>,
  seq: number,
): Promise<ConnzReply[]> {
  return new Promise((resolve) => {
    // The reply inbox MUST sit under the prefix the observer cred (`membership-observer`) grants sub
    // on — its ACL allows only `${MEMBERSHIP_INBOX_PREFIX}.>`, so a distinct `_INBOX.cotal-evict.*`
    // subject is broker-denied and the scan gets ZERO replies (a fail-closed under-report).
    const inbox = `${MEMBERSHIP_INBOX_PREFIX}.evict.${seq}`;
    const out: ConnzReply[] = [];
    let settle: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (settle) clearTimeout(settle);
      clearTimeout(hard);
      try { sub.unsubscribe(); } catch { /* draining */ }
      resolve(out);
    };
    const sub = observerConn.subscribe(inbox, {
      callback: (err, msg) => {
        if (err) return;
        try { out.push(msg.json<ConnzReply>()); } catch { /* skip undecodable */ }
        if (settle) clearTimeout(settle);
        settle = setTimeout(finish, opts.settleMs);
      },
    });
    const hard = setTimeout(finish, opts.maxWaitMs);
    observerConn.publish(
      connzRequestSubject(accountId),
      enc(JSON.stringify({ subscriptions: false, auth: true, offset, limit: opts.pageLimit })),
      { reply: inbox },
    );
  });
}

/** KICK one connection by cid on the server that reported it. No per-cid ack from the broker; the
 *  caller's re-scan is the verification. A publish/permission failure is surfaced (thrown up), so a
 *  mis-scoped evictor cred fails loud rather than silently not-kicking. */
async function kick(evictorConn: NatsConnection, conn: LiveConn): Promise<void> {
  // Request/reply so a broker-side error (bad permissions, unknown server) surfaces rather than a
  // fire-and-forget publish that a mis-scoped cred would swallow. The ServerAPIResponse `data` is
  // empty on success; we don't parse it (re-scan verifies) but DO honor an `error` field.
  const res = await evictorConn.request(serverKickSubject(conn.serverId), enc(JSON.stringify({ cid: conn.cid })), { timeout: 2000 });
  const body = res.json<{ error?: { description?: string } }>();
  if (body?.error) throw new Error(`KICK cid ${conn.cid} on ${conn.serverId} refused: ${body.error.description ?? "unknown"}`);
}

/**
 * Evict every live connection of one principal — the kill-live half of revocation, to be called
 * ONLY AFTER the deny-new is committed (ledger revoke / cred expiry / ACL removal). Scans, KICKs
 * each matching cid on its own server, then re-scans up to `maxVerifyRounds` to confirm the
 * principal is gone. Fail-closed: a partial scan is `verifiedGone:false, scanComplete:false`, and a
 * principal that was never live is an idempotent success no-op.
 *
 * The name carries the precondition: this is `evictDeniedPrincipal`-shaped — it does NOT deny new
 * connects; without a committed deny-new a kicked client reconnects with a fresh cid.
 */
export async function evictDeniedPrincipal(
  observerConn: NatsConnection,
  evictorConn: NatsConnection,
  accountId: string,
  principal: string,
  options: EvictOptions = {},
): Promise<EvictionResult> {
  const opts = {
    maxVerifyRounds: options.maxVerifyRounds ?? 3,
    settleMs: options.settleMs ?? 250,
    maxWaitMs: options.maxWaitMs ?? 2000,
    pageLimit: options.pageLimit ?? 1024,
  };
  const first = await scanLive(observerConn, accountId, opts);
  if (!first.complete)
    return { principal, kicked: 0, remaining: 0, verifiedGone: false, scanComplete: false, note: "CONNZ scan under-reported (no responder or truncated) — eviction UNKNOWN, not attempted" };

  const targets = first.conns.filter((c) => c.principal === principal);
  if (targets.length === 0)
    return { principal, kicked: 0, remaining: 0, verifiedGone: true, scanComplete: true, note: "principal not currently live — nothing to evict" };

  let kicked = 0;
  let note: string | undefined;
  for (const t of targets) {
    try {
      await kick(evictorConn, t);
      kicked++;
    } catch (e) {
      note = e instanceof Error ? e.message : String(e);
    }
  }

  // Verify by re-scan — a client kicked before deny-new fully propagates can reconnect with a fresh
  // cid, so loop until the principal is gone or the rounds run out (never one snapshot).
  for (let round = 0; round < opts.maxVerifyRounds; round++) {
    const rescan = await scanLive(observerConn, accountId, opts);
    if (!rescan.complete)
      return { principal, kicked, remaining: 0, verifiedGone: false, scanComplete: false, note: note ?? "verify re-scan under-reported — eviction UNKNOWN" };
    const still = rescan.conns.filter((c) => c.principal === principal);
    if (still.length === 0)
      return { principal, kicked, remaining: 0, verifiedGone: true, scanComplete: true, note };
    // Still live — kick the fresh cids and try again (bounded by maxVerifyRounds).
    for (const t of still) {
      try { await kick(evictorConn, t); kicked++; } catch (e) { note = e instanceof Error ? e.message : String(e); }
    }
    if (round === opts.maxVerifyRounds - 1)
      return { principal, kicked, remaining: still.length, verifiedGone: false, scanComplete: true, note: note ?? `${still.length} connection(s) still live after ${opts.maxVerifyRounds} verify rounds — is deny-new committed?` };
  }
  // Unreachable (the loop returns), but satisfies the type checker.
  return { principal, kicked, remaining: 0, verifiedGone: false, scanComplete: true, note };
}
