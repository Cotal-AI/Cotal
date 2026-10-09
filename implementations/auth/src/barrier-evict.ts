/**
 * The auth service's VERIFIED-EVICTION seam (SPEC 13.1/13.9). The lifecycle barriers require
 * `verifiedGone === true` before any epoch advance or head terminal, and the `$SYS` scan → KICK →
 * verify capability lives with the DELIVERY DAEMON (co-located with the broker) — NEVER in this
 * process: the auth service holds the data-account signing seed, and the D5 rail-split exists
 * precisely so no seed-holding process also holds broker-admin `$SYS` material. This module
 * reaches the daemon over the wire on the privileged `ctl.delivery-admin` control rail (the
 * exact mechanism `cotal actor revoke` uses), with a caller credential self-minted per call from
 * the data-account seed the service already holds.
 *
 * FAIL-CLOSED MAPPING: every failure — no daemon (NoResponders/timeout), a refusal, a garbled
 * reply, or a reply describing a DIFFERENT principal — returns `verifiedGone:false` with an
 * honest note. The calling barrier then throws and its gate stays frozen/resumable; this seam
 * never fabricates success and never throws raw (the barrier owns the canonical error copy).
 *
 * Named residual (panel-reviewable): the caller credential rides the SUPERVISOR profile (the
 * `cotal actor revoke` precedent) — only that profile holds the `ctl.delivery-admin` publish
 * grant. The service holds the account signing seed, so this confers no authority it does not
 * already have; a dedicated narrow delivery-admin infra profile is the cleaner target once the
 * ledgered infra-mint family (#30) lands — migrate there, do not invent it here.
 */
import { EVICT_PRINCIPALS_MAX, type EvictionResult } from "@cotal-ai/core";
import type { EvictPrincipal } from "./credential-ledger.js";
import { withDeliveryAdminEndpoint } from "./delivery-admin.js";

/** Accept one daemon eviction result only when it verifiably describes `principal`; anything else
 *  maps to `failClosed`, so it never authorizes. */
function checkedEviction(principal: string, data: unknown, failClosed: (principal: string, note: string) => EvictionResult): EvictionResult {
  const d = data as Partial<EvictionResult> | undefined;
  if (
    d === undefined || d === null || d.principal !== principal ||
    typeof d.kicked !== "number" || !Number.isSafeInteger(d.kicked) || d.kicked < 0 ||
    typeof d.remaining !== "number" || !Number.isSafeInteger(d.remaining) || d.remaining < 0 ||
    typeof d.verifiedGone !== "boolean" || typeof d.scanComplete !== "boolean"
  )
    return failClosed(principal, `the delivery daemon returned a garbled or foreign eviction result (${JSON.stringify(data ?? null)}); a result that does not verifiably describe this principal never authorizes`);
  // An internally CONTRADICTORY success never authorizes: the barriers gate on
  // `verifiedGone === true` alone, so a tuple claiming verified-gone while admitting an
  // incomplete scan or surviving connections would launder a partial answer into an epoch
  // advance / head terminal. Verified-gone is conclusive only as (scan complete, none remain).
  if (d.verifiedGone === true && (d.scanComplete !== true || d.remaining !== 0))
    return failClosed(principal, `the delivery daemon claimed verifiedGone with scanComplete=${String(d.scanComplete)} and remaining=${d.remaining}; an internally contradictory eviction result never authorizes`);
  return {
    principal,
    kicked: d.kicked,
    remaining: d.remaining,
    verifiedGone: d.verifiedGone,
    scanComplete: d.scanComplete,
    ...(typeof d.note === "string" ? { note: d.note } : {}),
  };
}

/**
 * Build the barrier executor's `evictPrincipal` capability over the delivery daemon's
 * `ctl.delivery-admin` rail. Per-call connection (an eviction is a rare, heavyweight barrier
 * step; a standing privileged connection would be a wider surface holding nothing).
 */
export function makeDeliveryAdminEvictor(opts: {
  space: string;
  server: string;
  dataAccount: { pub: string; signingSeed: string };
  onConnection?: import("./authority-client.js").AuthorityClientOpts["onConnection"];
  log: (line: string) => void;
}): EvictPrincipal {
  const failClosed = (principal: string, note: string): EvictionResult => {
    opts.log(`auth-barrier-evict: ${principal}: ${note}`);
    return { principal, kicked: 0, remaining: 0, verifiedGone: false, scanComplete: false, note };
  };
  return async (principal: string): Promise<EvictionResult> => {
    try {
      return await withDeliveryAdminEndpoint(opts, "supervisor", "auth-barrier-evict", async (ep) => {
        const r = await ep.requestDeliveryAdmin("evictPrincipal", { principal }, 15_000);
        if (!r.ok) return failClosed(principal, `the delivery daemon refused the eviction: ${r.error ?? "(no error copy)"}`);
        return checkedEviction(principal, r.data, failClosed);
      });
    } catch (e) {
      return failClosed(principal, `the delivery-admin rail is unreachable (${e instanceof Error ? e.message : String(e)}); eviction is UNKNOWN and the barrier fails closed`);
    }
  };
}

/**
 * The family evictor: verify-evict a SET of holders over ONE per-call connection, with one
 * `evictPrincipals` request (one shared daemon sweep) per {@link EVICT_PRINCIPALS_MAX} holders.
 * Answers one `EvictionResult` per holder in input order, with the same fail-closed mapping: a
 * refusal, an unreachable rail or an unusable reply leaves every holder it covers unverified.
 */
export function makeDeliveryAdminHolderEvictor(opts: Parameters<typeof makeDeliveryAdminEvictor>[0]): (holderPrincipals: readonly string[]) => Promise<EvictionResult[]> {
  const failClosed = (principal: string, note: string): EvictionResult => {
    opts.log(`auth-barrier-evict: ${principal}: ${note}`);
    return { principal, kicked: 0, remaining: 0, verifiedGone: false, scanComplete: false, note };
  };
  return async (principals) => {
    const evictions: EvictionResult[] = [];
    try {
      await withDeliveryAdminEndpoint(opts, "supervisor", "auth-barrier-evict", async (ep) => {
        for (let i = 0; i < principals.length; i += EVICT_PRINCIPALS_MAX) {
          const chunk = principals.slice(i, i + EVICT_PRINCIPALS_MAX);
          const r = await ep.requestDeliveryAdmin("evictPrincipals", { principals: chunk }, 15_000);
          const results = r.ok && Array.isArray(r.data) && r.data.length === chunk.length ? (r.data as unknown[]) : undefined;
          const why = !r.ok
            ? `the delivery daemon refused the family eviction: ${r.error ?? "(no error copy)"}`
            : `the delivery daemon answered a family eviction result set that does not match the ${chunk.length} holder(s) asked about`;
          chunk.forEach((p, j) => evictions.push(results ? checkedEviction(p, results[j], failClosed) : failClosed(p, why)));
        }
      });
    } catch (e) {
      const note = `the delivery-admin rail is unreachable (${e instanceof Error ? e.message : String(e)}); eviction is UNKNOWN and the barrier fails closed`;
      for (const p of principals.slice(evictions.length)) evictions.push(failClosed(p, note));
    }
    return evictions;
  };
}
