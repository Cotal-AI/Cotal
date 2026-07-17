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
  // principal -> the open client, so retireCleanerCredential can close exactly this op's connection.
  const clients = new Map<string, AuthorityClient>();
  return {
    openCleaner: async ({ opId, endpoint, pools }): Promise<PoolCleanerBind> => {
      const actor = cleanerActor(opId);
      // Fail-loud on a double-open of a LIVE op's cleaner: a silent map overwrite would leak the
      // first connection (infinite-reconnect, so the process never drains) and make
      // retireCleanerCredential close the WRONG one. A crash-resume re-open is fine — the crashed
      // process's map is gone, so nothing is tracked here.
      if (clients.has(principalKey(CLEANER_OWNER, actor).key))
        throw new Error(`retirement cleaner already open for op ${opId}; retire it before re-opening`);
      const client = await openAuthorityClient({
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
      const principal = client.principal!; // set because we passed `principal`
      clients.set(principal, client);
      return { jsm: await jetstreamManager(client.nc), js: jetstream(client.nc), principal };
    },
    retireCleanerCredential: async (bind: PoolCleanerBind): Promise<void> => {
      // Deny-new: close this op's cleaner connection. Kill-live (evicting any lingering connection
      // that raced the close) is the BARRIER's job via its own evictPrincipal — never here, so the
      // delivery-admin KICK authority stays out of this seam.
      const client = clients.get(bind.principal);
      if (client) {
        clients.delete(bind.principal);
        await client.close();
      }
    },
  };
}
