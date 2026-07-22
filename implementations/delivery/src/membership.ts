import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startMembershipFeed, type MembershipFeedHandle, type SecretStore } from "@cotal-ai/core";
import { findCotalRoot, MEMBERSHIP_RW_CREDS_KEY, workspaceSecretStore } from "@cotal-ai/workspace";

/**
 * The delivery daemon's thin composition root for the broker-sourced graph-membership feed. It loads the
 * DATA account id + the SYSTEM-account observer cred from `.cotal/` (written by `cotal up`; the daemon
 * never holds the signer) and reads the DATA-account rw cred through the {@link SecretStore} seam — the
 * SAME seam the renewal owner (the manager) re-signs into — so a hosted composition can renew the feed's
 * writer end-to-end (KMS/Vault) without a daemon restart. `store` is that hosted injection point; with
 * none, the workstation FS store (keys = the filenames under `.cotal/`) is used, so a local `cotal up`
 * is byte-for-byte unchanged. It hands the two creds + the account id to the core feed engine
 * ({@link startMembershipFeed}, which owns the two connections + the poll loop + the rw 75% renewal).
 *
 * Deliberately ISOLATED from Plane-3: a separate module, separate connections, and a fail-soft contract —
 * if the creds aren't provisioned (a pre-feature space) or the feed can't start, it logs and returns
 * `undefined`; the graph degrades to traffic-only and delivery is untouched.
 *
 * Residual (deferred, non-blocking): the observer cred + `membership.json` (the account id) are still
 * read from `.cotal/` files, so a fully hosted feed on an injected store also needs those two threaded.
 * They are a static $SYS cred and non-secret config, respectively — the renewable rw kind is what 3b
 * migrates; the manager re-signs only it.
 */
export async function startMembership(opts: { space: string; server: string }, store?: SecretStore): Promise<MembershipFeedHandle | undefined> {
  const root = findCotalRoot();
  const dir = join(root, ".cotal");
  const obsPath = join(dir, "membership-observer.creds");
  const cfgPath = join(dir, "membership.json");
  const secrets = store ?? workspaceSecretStore(root);

  const rw = await secrets.get(MEMBERSHIP_RW_CREDS_KEY);
  if (rw === undefined || !existsSync(obsPath) || !existsSync(cfgPath)) {
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
    // Observer is rotation-renewed ($SYS): a static read — its renewal is a system rotation + restart.
    observerCreds: readFileSync(obsPath, "utf8"),
    // rw is class-2 standing-renewable: read through the store seam and renewed on a 75% timer that
    // preflight-proves each candidate the manager re-signs into the store (D5 slice 5). The daemon
    // never sees the signer; the manager owns the re-sign.
    rwCreds: async () => {
      const cur = await secrets.get(MEMBERSHIP_RW_CREDS_KEY);
      if (cur === undefined)
        throw new Error(`membership: the scoped rw cred is gone (key "${MEMBERSHIP_RW_CREDS_KEY}") — restore it (locally: re-run \`cotal up\`) before the current JWT expires`);
      return cur;
    },
    intervalMs,
  });
  console.log(`✓ membership feed up (broker-sourced channel membership) — space ${opts.space}`);
  return handle;
}
