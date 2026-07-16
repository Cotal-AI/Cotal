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
import { CotalEndpoint, mintCreds, newIdentity, type EvictionResult, type SpaceAuth } from "@cotal-ai/core";
import type { EvictPrincipal } from "./credential-ledger.js";

/**
 * Build the barrier executor's `evictPrincipal` capability over the delivery daemon's
 * `ctl.delivery-admin` rail. Per-call connection (an eviction is a rare, heavyweight barrier
 * step; a standing privileged connection would be a wider surface holding nothing).
 */
export function makeDeliveryAdminEvictor(opts: {
  space: string;
  server: string;
  dataAccount: { pub: string; signingSeed: string };
  log: (line: string) => void;
}): EvictPrincipal {
  // The stripped mint view (core's stripSpaceAuth shape): mintCreds reads ONLY space +
  // account.pub + account.signingSeed; the operator/system material is genuinely absent here.
  const auth: SpaceAuth = {
    space: opts.space,
    operator: { seed: "", jwt: "" },
    account: { pub: opts.dataAccount.pub, seed: "", jwt: "", signingSeed: opts.dataAccount.signingSeed, signingPub: "" },
    sys: { pub: "", jwt: "" },
  };
  const failClosed = (principal: string, note: string): EvictionResult => {
    opts.log(`auth-barrier-evict: ${principal}: ${note}`);
    return { principal, kicked: 0, remaining: 0, verifiedGone: false, scanComplete: false, note };
  };
  return async (principal: string): Promise<EvictionResult> => {
    const id = newIdentity();
    let ep: CotalEndpoint | undefined;
    try {
      const creds = await mintCreds(auth, id, "supervisor");
      ep = new CotalEndpoint({
        space: opts.space,
        servers: opts.server,
        creds,
        card: { id: id.id, name: "auth-barrier-evict", kind: "endpoint" },
        channels: [],
        consume: false,
        watchChannels: false,
        watchPresence: false,
        registerPresence: false,
      });
      ep.on("error", () => {});
      await ep.start();
      const r = await ep.requestDeliveryAdmin("evictPrincipal", { principal }, 15_000);
      if (!r.ok) return failClosed(principal, `the delivery daemon refused the eviction: ${r.error ?? "(no error copy)"}`);
      const d = r.data as Partial<EvictionResult> | undefined;
      if (
        d === undefined || d === null || d.principal !== principal ||
        typeof d.kicked !== "number" || typeof d.remaining !== "number" ||
        typeof d.verifiedGone !== "boolean" || typeof d.scanComplete !== "boolean"
      )
        return failClosed(principal, `the delivery daemon returned a garbled or foreign eviction result (${JSON.stringify(r.data ?? null)}); a result that does not verifiably describe this principal never authorizes`);
      return {
        principal,
        kicked: d.kicked,
        remaining: d.remaining,
        verifiedGone: d.verifiedGone,
        scanComplete: d.scanComplete,
        ...(typeof d.note === "string" ? { note: d.note } : {}),
      };
    } catch (e) {
      return failClosed(principal, `the delivery-admin rail is unreachable (${e instanceof Error ? e.message : String(e)}); eviction is UNKNOWN and the barrier fails closed`);
    } finally {
      await ep?.stop().catch(() => {});
    }
  };
}
