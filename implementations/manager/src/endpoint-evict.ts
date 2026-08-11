/**
 * The manager's VERIFIED-EVICTION seam for its own endpoint-registration barrier (SPEC 13.1, P2
 * item 3, slice 3a). A restart re-registers the SAME logical instanceId with an ADVANCED epoch, and
 * §13.1 requires the SUPERSEDED serve family to die BEFORE the new authority is visible — so the
 * registration barrier's PHASE 2 must VERIFY-EVICT the predecessor's serve principal. The `$SYS`
 * scan → KICK → verify capability lives with the DELIVERY DAEMON (co-located with the broker), never
 * in this process (the manager holds the DATA signing seed; the D5 rail-split keeps `$SYS` material
 * out of any seed-holder). This reaches the daemon over the privileged `ctl.delivery-admin` rail
 * with a per-call SCOPED `endpoint-evictor` credential (pub the delivery-admin subject + reply +
 * `$JS.API.INFO`, nothing else — narrower than the `supervisor` profile auth's barrier-evict reuses).
 *
 * NO-ORACLE = LOUD (no-fallbacks): if the daemon is unreachable the evictor THROWS an error NAMING
 * THE CURE, so the barrier's PHASE-2 failure carries it and the gate stays frozen for reconciliation
 * — a crash-restart on an auth mesh NEVER skips eviction. A reachable daemon that reports the
 * principal still connected (or a garbled/contradictory result) returns `false` (not verified),
 * which the barrier also treats as fail-closed. Verified-gone is conclusive only as (scan complete,
 * none remain).
 */
import { CotalEndpoint, mintCreds, newIdentity, type EvictionResult, type SpaceAuth } from "@cotal-ai/core";

/** Build the registration barrier's `evict(holderPrincipal) → verifiedGone` over the delivery
 *  daemon's `ctl.delivery-admin` rail. Per-call connection (eviction is a rare, heavyweight barrier
 *  step; a standing privileged connection would be a wider surface holding nothing). */
export function makeManagerEndpointEvictor(opts: {
  space: string;
  servers: string;
  auth: SpaceAuth;
  log: (line: string) => void;
}): (holderPrincipal: string) => Promise<boolean> {
  return async (principal: string): Promise<boolean> => {
    const id = newIdentity();
    let ep: CotalEndpoint | undefined;
    try {
      // A per-eviction SCOPED cred for ONE ~15s delivery-admin call (60s TTL bounds a copied cred to
      // a minute). endpoint-evictor holds EXACTLY its own delivery-admin request+reply rail — no
      // lease, presence, store, consumer, KV, or executing right.
      const creds = await mintCreds(opts.auth, id, "endpoint-evictor", { expiresInSeconds: 60 });
      ep = new CotalEndpoint({
        space: opts.space,
        servers: opts.servers,
        creds,
        card: { id: id.id, name: "manager-endpoint-evict", kind: "endpoint" },
        channels: [],
        consume: false,
        watchChannels: false,
        watchPresence: false,
        registerPresence: false,
      });
      ep.on("error", () => {});
      await ep.start();
      const r = await ep.requestDeliveryAdmin("evictPrincipal", { principal }, 15_000);
      if (!r.ok) {
        // The daemon is REACHABLE but refused (e.g. the principal is still connected — a genuine live
        // predecessor). Not verified gone → fail-closed (the barrier leaves the gate frozen).
        opts.log(`manager-endpoint-evict: ${principal}: the delivery daemon refused the eviction: ${r.error ?? "(no error copy)"}`);
        return false;
      }
      const d = r.data as Partial<EvictionResult> | undefined;
      if (
        d === undefined || d === null || d.principal !== principal ||
        typeof d.kicked !== "number" || !Number.isSafeInteger(d.kicked) || d.kicked < 0 ||
        typeof d.remaining !== "number" || !Number.isSafeInteger(d.remaining) || d.remaining < 0 ||
        typeof d.verifiedGone !== "boolean" || typeof d.scanComplete !== "boolean"
      ) {
        opts.log(`manager-endpoint-evict: ${principal}: garbled or foreign eviction result (${JSON.stringify(r.data ?? null)}); a result that does not verifiably describe this principal never authorizes`);
        return false;
      }
      // An internally CONTRADICTORY success never authorizes (verified-gone is (scan complete, none remain)).
      if (d.verifiedGone === true && (d.scanComplete !== true || d.remaining !== 0)) {
        opts.log(`manager-endpoint-evict: ${principal}: verifiedGone with scanComplete=${String(d.scanComplete)} remaining=${d.remaining}; a contradictory result never authorizes`);
        return false;
      }
      return d.verifiedGone === true;
    } catch (e) {
      // NO-ORACLE = LOUD (pin 3, SPEC 13.1, no-fallbacks): the delivery-admin rail is unreachable, so
      // eviction is UNKNOWN. THROW naming the cure so the barrier's PHASE-2 error carries it and the
      // gate stays frozen — never a silent skip that could resurrect old-epoch authority.
      throw new Error(
        `the delivery daemon is not reachable on the ctl.delivery-admin rail (${e instanceof Error ? e.message : String(e)}); ` +
        `a restart on an auth mesh cannot verify-evict the superseded serve family principal "${principal}" without the liveness oracle. ` +
        `Start the delivery daemon (\`cotal up\` runs it) and retry — eviction is never skipped (SPEC 13.1)`,
      );
    } finally {
      await ep?.stop().catch(() => {});
    }
  };
}
