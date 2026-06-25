import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startMembershipFeed, type MembershipFeedHandle } from "@cotal-ai/core";
import { findCotalRoot } from "@cotal-ai/workspace";

/**
 * The delivery daemon's thin composition root for the broker-sourced graph-membership feed. It loads the
 * two PRE-MINTED scoped creds + the DATA account id from `.cotal/` (written by `cotal up`; the daemon
 * never holds the signer) and hands them to the core feed engine ({@link startMembershipFeed}, which owns
 * the two connections + the poll loop).
 *
 * Deliberately ISOLATED from Plane-3: a separate module, separate connections, and a fail-soft contract —
 * if the creds aren't provisioned (a pre-feature space) or the feed can't start, it logs and returns
 * `undefined`; the graph degrades to traffic-only and delivery is untouched.
 */
export async function startMembership(opts: { space: string; server: string }): Promise<MembershipFeedHandle | undefined> {
  const dir = join(findCotalRoot(), ".cotal");
  const obsPath = join(dir, "membership-observer.creds");
  const rwPath = join(dir, "membership-rw.creds");
  const cfgPath = join(dir, "membership.json");

  if (!existsSync(obsPath) || !existsSync(rwPath) || !existsSync(cfgPath)) {
    console.error(
      "• membership: scoped creds not provisioned here — broker-sourced graph membership disabled (the graph falls back to traffic-only). Provisioned on a fresh `cotal up`; a space created before this feature needs its auth regenerated. Delivery is unaffected.",
    );
    return undefined;
  }

  const accountId = (JSON.parse(readFileSync(cfgPath, "utf8")) as { accountId?: string }).accountId;
  if (!accountId) {
    console.error("• membership: .cotal/membership.json has no accountId — membership disabled (delivery unaffected)");
    return undefined;
  }

  const intervalMs = Number(process.env.COTAL_MEMBERSHIP_INTERVAL_MS) || undefined; // test/ops override
  const handle = await startMembershipFeed({
    servers: opts.server,
    space: opts.space,
    accountId,
    observerCreds: readFileSync(obsPath, "utf8"),
    rwCreds: readFileSync(rwPath, "utf8"),
    intervalMs,
  });
  console.log(`✓ membership feed up (broker-sourced channel membership) — space ${opts.space}`);
  return handle;
}
