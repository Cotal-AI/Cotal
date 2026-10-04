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
 * — a crash-restart on an auth mesh NEVER skips eviction. A reachable daemon that REFUSES throws its
 * own reason instead (it answered, so it is never reported as unreachable), and a garbled or
 * contradictory answer throws too; the barrier treats all of these as fail-closed. Verified-gone is
 * conclusive only as (scan complete, none remain).
 */
import { CotalEndpoint, EVICT_PRINCIPALS_MAX, mintCreds, newIdentity, type ControlReply, type EvictionResult, type SpaceAuth } from "@cotal-ai/core";

/** Accept one daemon eviction result only when it verifiably describes `principal`. A garbled,
 *  foreign or internally contradictory result throws, so it never authorizes. */
function checkedEviction(principal: string, data: unknown, log: (line: string) => void): EvictionResult {
  const d = data as Partial<EvictionResult> | undefined;
  if (
    d === undefined || d === null || d.principal !== principal ||
    typeof d.kicked !== "number" || !Number.isSafeInteger(d.kicked) || d.kicked < 0 ||
    typeof d.remaining !== "number" || !Number.isSafeInteger(d.remaining) || d.remaining < 0 ||
    typeof d.verifiedGone !== "boolean" || typeof d.scanComplete !== "boolean"
  ) {
    log(`manager-endpoint-evict: ${principal}: garbled or foreign eviction result (${JSON.stringify(data ?? null)}); a result that does not verifiably describe this principal never authorizes`);
    throw new Error(`the delivery daemon returned garbled or foreign eviction evidence for "${principal}"`);
  }
  // An internally CONTRADICTORY success never authorizes (verified-gone is (scan complete, none remain)).
  if (d.verifiedGone === true && (d.scanComplete !== true || d.remaining !== 0)) {
    log(`manager-endpoint-evict: ${principal}: verifiedGone with scanComplete=${String(d.scanComplete)} remaining=${d.remaining}; a contradictory result never authorizes`);
    throw new Error(`the delivery daemon returned contradictory eviction evidence for "${principal}"`);
  }
  return d as EvictionResult;
}

/** Build the registration barrier's `evict(holderPrincipal) → verifiedGone` over the delivery
 *  daemon's `ctl.delivery-admin` rail. Per-call connection (eviction is a rare, heavyweight barrier
 *  step; a standing privileged connection would be a wider surface holding nothing). */
export function makeManagerEndpointEvictionEvidence(opts: {
  space: string;
  servers: string;
  auth: SpaceAuth;
  log: (line: string) => void;
}): (holderPrincipal: string) => Promise<EvictionResult> {
  return async (principal: string): Promise<EvictionResult> => {
    const id = newIdentity();
    let ep: CotalEndpoint | undefined;
    let r: ControlReply;
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
      r = await ep.requestDeliveryAdmin("evictPrincipal", { principal }, 15_000);
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
    // The daemon ANSWERED from here on, so nothing below is relabelled as unreachable: a refusal
    // carries the daemon's own reason (e.g. a missing $SYS cred and how to re-mint it).
    if (!r.ok) {
      // The daemon is REACHABLE but refused (e.g. the principal is still connected — a genuine live
      // predecessor). Not verified gone → fail-closed (the barrier leaves the gate frozen).
      opts.log(`manager-endpoint-evict: ${principal}: the delivery daemon refused the eviction: ${r.error ?? "(no error copy)"}`);
      throw new Error(`the delivery daemon refused eviction of "${principal}": ${r.error ?? "no error copy"}`);
    }
    return checkedEviction(principal, r.data, opts.log);
  };
}

/** Boolean adapter for barriers that only consume the verified-gone decision. */
export function makeManagerEndpointEvictor(opts: Parameters<typeof makeManagerEndpointEvictionEvidence>[0]): (holderPrincipal: string) => Promise<boolean> {
  const evidence = makeManagerEndpointEvictionEvidence(opts);
  return async (principal) => (await evidence(principal)).verifiedGone;
}

/** The repair's family evictor: verify-evict a SET of holders over ONE scoped connection, with one
 *  `evictPrincipals` request (one shared daemon sweep) per {@link EVICT_PRINCIPALS_MAX} holders.
 *  Answers `verifiedGone` per holder in input order. A daemon that does not serve the batch verb,
 *  or any unreachable or unusable reply, throws naming the cure: nothing is reported verified. */
export function makeManagerEndpointHolderEvictor(opts: Parameters<typeof makeManagerEndpointEvictionEvidence>[0]): (holderPrincipals: readonly string[]) => Promise<boolean[]> {
  return async (principals) => {
    const id = newIdentity();
    let ep: CotalEndpoint | undefined;
    try {
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
      const verified: boolean[] = [];
      for (let i = 0; i < principals.length; i += EVICT_PRINCIPALS_MAX) {
        const chunk = principals.slice(i, i + EVICT_PRINCIPALS_MAX);
        const r = await ep.requestDeliveryAdmin("evictPrincipals", { principals: chunk }, 15_000);
        if (!r.ok) {
          opts.log(`manager-endpoint-evict: the delivery daemon refused the family eviction: ${r.error ?? "(no error copy)"}`);
          throw new Error(`the delivery daemon refused the family eviction: ${r.error ?? "no error copy"}`);
        }
        if (!Array.isArray(r.data) || r.data.length !== chunk.length) {
          opts.log(`manager-endpoint-evict: the family eviction answered ${Array.isArray(r.data) ? r.data.length : "no"} result(s) for ${chunk.length} holder(s); a result set that does not match the request never authorizes`);
          throw new Error(`the delivery daemon returned a family eviction result set that does not match the ${chunk.length} holder(s) asked about`);
        }
        chunk.forEach((p, j) => verified.push(checkedEviction(p, (r.data as unknown[])[j], opts.log).verifiedGone));
      }
      return verified;
    } catch (e) {
      throw new Error(
        `the delivery daemon could not verify-evict the credential family on the ctl.delivery-admin rail (${e instanceof Error ? e.message : String(e)}); ` +
        `the gate stays frozen. Start the delivery daemon (\`cotal up\` runs it) at this version and retry — eviction is never skipped (SPEC 13.1)`,
      );
    } finally {
      await ep?.stop().catch(() => {});
    }
  };
}
