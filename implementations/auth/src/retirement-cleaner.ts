/**
 * The per-op EXACT-POOL CLEANER credential lifecycle (SPEC 13.9 "Terminal pool cleanup" / #29
 * trigger slice, piece 1). The retirement barrier's {@link RetirementDeps} needs two cleaner seams
 * — `openCleaner` and `retireCleanerCredential` — wired to a REAL bounded credential, not the
 * static-conf user the smoke fakes. This module is that wiring; it is the production home of the
 * `barrierExecutorSettlementGrants` per-op credential the D14 audit flagged as unwired.
 *
 * The panel-agreed shape (distsys, #29 piece-1 vote (2)):
 *  - ONE distinct cleaner principal PER OP: `local.epcln_<opId-hash>`. Kill-live is by CONNZ
 *    principal TAG (`owner.actor`), not nkey — so a SHARED cleaner principal would let one op's
 *    `evictPrincipal` collateral-kill a concurrent op's cleaner. A per-op actor makes the evict hit
 *    exactly this op's connection. The actor token grammar forbids `-` (the principal name-form
 *    separator, subjects.ts), so the op id is joined with `_` and shortened to a deterministic
 *    16-hex digest to stay a single bounded `[a-z0-9_]` token.
 *  - the credential is minted from the DURABLE INTENT's `(endpoint, pools)` only, granted EXACTLY
 *    `retirementCleanerGrants ∪ barrierExecutorSettlementGrants` for those pools (bind-only on the
 *    pool durables + the op's `wrk`/`lease` writes + the EPF fencing read), short-TTL, and CONNZ
 *    principal-tagged so the barrier can verified-evict it.
 *    KNOWN, DEFERRED to #29 piece 2 (freelance a559d9c round): SPEC 13.9 SPLITS this union — the
 *    cleaner must hold NO lease/`wrk` write (its residual is terminal-free ACK suppression), and
 *    the op-bounded settlement EXECUTOR owns those writes on its OWN connection. Piece 1 unions
 *    them here AND runs the settlement code on the barrier's standing connection; the split (a
 *    distinct executor client whose grant carries the lease/`wrk` writes plus the EPW/records
 *    reads the settlement executes) lands with the piece-2 wiring, where a real executor
 *    connection exists and security reviews the new profile. The path is daemon-unwired today, so
 *    the over-grant is latent, not live.
 *  - ATOMIC acquisition (freelance a559d9c round): the principal is reserved SYNCHRONOUSLY before
 *    the first await (two concurrent same-op opens cannot both pass a check-then-connect gap), both
 *    JS handles are built INSIDE the transaction, and the client is published to the live map only
 *    on full success — a post-connect `$JS.API.INFO` failure closes the connection and releases the
 *    reservation rather than stranding a live, never-retired client.
 *  - `retireCleanerCredential` closes the connection (the deny-new half). The barrier then runs its
 *    OWN `evictPrincipal(bind.principal)` (the kill-live half) — this module never evicts, so the
 *    kill-live authority stays with the barrier's delivery-admin seam.
 *  - fail-closed: a mint failure throws, so the barrier leaves the gate frozen (no frontiers, no
 *    head terminal) rather than proceeding without a cleaner.
 */
import { createHash } from "node:crypto";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { barrierExecutorSettlementGrants, openAuthorityClient, type AuthorityClient } from "./authority-client.js";
import { principalKey, retirementCleanerGrants } from "@cotal-ai/core";
import type { PoolCleanerBind } from "./retirement-barrier.js";

/** The infra owner for cleaner principals — CONNZ-attributable (`local` passes the delivery
 *  daemon's owner check, evict-exec.ts), reserved so it never collides with an agent principal. */
const CLEANER_OWNER = "local";

/** `epcln_<16-hex-of-sha256(opId)>` — a single `[a-z0-9_]` actor token (no `-`, bounded), UNIQUE
 *  per op (64 bits of digest: collision-resistant across any realistic set of concurrent ops). */
function cleanerActor(opId: string): string {
  return `epcln_${createHash("sha256").update(opId).digest("hex").slice(0, 16)}`;
}

/**
 * Build the retirement cleaner seams over the data-account seed (the same self-mint substrate as
 * the barrier evictor). Returns `openCleaner`/`retireCleanerCredential` for a {@link RetirementDeps}.
 */
export function makeRetirementCleaners(opts: {
  server: string;
  space: string;
  dataAccount: { pub: string; signingSeed: string };
  log: (line: string) => void;
}): {
  openCleaner: (args: { opId: string; endpoint: string; pools: string[] }) => Promise<PoolCleanerBind>;
  retireCleanerCredential: (bind: PoolCleanerBind) => Promise<void>;
} {
  // principal -> the open (or reserving) client, so retireCleanerCredential closes exactly this
  // op's connection. `"opening"` is the SYNCHRONOUS reservation held across the connect+bind await.
  const clients = new Map<string, AuthorityClient | "opening">();
  return {
    openCleaner: async ({ opId, endpoint, pools }): Promise<PoolCleanerBind> => {
      const actor = cleanerActor(opId);
      const principal = principalKey(CLEANER_OWNER, actor).key;
      // ATOMIC, FAIL-CLOSED double-open guard: reserve the key SYNCHRONOUSLY (before the first
      // await), so two concurrent same-op opens cannot BOTH pass a check-then-connect gap and leak
      // the loser's connection (infinite-reconnect, so the process never drains) or make
      // retireCleanerCredential close the WRONG one. A crash-resume re-open is fine — the crashed
      // process's map is gone, so nothing is tracked here.
      if (clients.has(principal))
        throw new Error(`retirement cleaner already open (or opening) for op ${opId}; retire it before re-opening`);
      clients.set(principal, "opening");
      let client: AuthorityClient | undefined;
      try {
        client = await openAuthorityClient({
          server: opts.server,
          space: opts.space,
          dataAccount: opts.dataAccount,
          label: `cotal:ep-cleaner:${opts.space}:${opId}`,
          principal: { owner: CLEANER_OWNER, actor },
          grants: (connId) => {
            // Exactly the op's pools, from the durable intent: bind-only pool-durable reads +
            // wrk/lease settlement writes + the EPF fencing read + the scoped inbox. Nothing standing.
            const cleaner = retirementCleanerGrants(opts.space, endpoint, pools, connId);
            const settlement = barrierExecutorSettlementGrants(opts.space, endpoint, pools);
            return { publish: [...cleaner.publish, ...settlement.publish], subscribe: cleaner.subscribe };
          },
          log: opts.log,
        });
        // Build BOTH JS handles inside the transaction: `jetstreamManager` performs a `$JS.API.INFO`
        // that can reject AFTER the credential connected. Publish to the live map ONLY on full
        // success, so a post-connect failure never strands a live, never-retired tracked client.
        const bind: PoolCleanerBind = { jsm: await jetstreamManager(client.nc), js: jetstream(client.nc), principal };
        clients.set(principal, client);
        return bind;
      } catch (e) {
        clients.delete(principal); // release the reservation
        if (client !== undefined) await client.close().catch(() => { /* already failing loud */ });
        throw e;
      }
    },
    retireCleanerCredential: async (bind: PoolCleanerBind): Promise<void> => {
      // Deny-new: close this op's cleaner connection. Kill-live (evicting any lingering connection
      // that raced the close) is the BARRIER's job via its own evictPrincipal — never here, so the
      // delivery-admin KICK authority stays out of this seam.
      const tracked = clients.get(bind.principal);
      // A retire never closes a half-built client under a concurrent open (the reservation is not a
      // connection): only a fully-published client is closed.
      if (tracked !== undefined && tracked !== "opening") {
        clients.delete(bind.principal);
        await tracked.close();
      }
    },
  };
}
