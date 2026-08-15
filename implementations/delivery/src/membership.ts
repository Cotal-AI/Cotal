import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { credsClaims, inspectCredHealth, startMembershipFeed, type MembershipFeedHandle, type SecretStore } from "@cotal-ai/core";
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

/** Why the feed is, or is not, running. `down` carries the DIAGNOSIS to the caller, because the
 *  daemon's log line is not the only place it is needed: an adoption reply that says only "the feed is
 *  not running" sends an operator hunting for a feed fault when the real one is an expired $SYS cred
 *  three layers down (the failure reported in #338). Exactly one of the two members is set. */
export type MembershipStart = { handle: MembershipFeedHandle; down?: undefined } | { handle?: undefined; down: string };

export async function startMembership(opts: { space: string; server: string }, store?: SecretStore): Promise<MembershipStart> {
  const root = findCotalRoot();
  const dir = join(root, ".cotal");
  const obsPath = join(dir, "membership-observer.creds");
  const cfgPath = join(dir, "membership.json");
  const secrets = store ?? workspaceSecretStore(root);

  const rw = await secrets.get(MEMBERSHIP_RW_CREDS_KEY);
  const missing = [
    rw === undefined ? MEMBERSHIP_RW_CREDS_KEY : undefined,
    existsSync(obsPath) ? undefined : "membership-observer.creds",
    existsSync(cfgPath) ? undefined : "membership.json",
  ].filter((f): f is string => f !== undefined);
  if (missing.length) {
    // Name the missing piece AND a repair that reaches it. The bundle has two halves with two
    // different repairs, and naming the wrong one costs an operator a full mesh stop for nothing.
    // The $SYS-signed half (observer, evictor) can only be minted while the never-persisted system
    // signing seed is in memory, so it takes a rotation. The DATA half (rw cred, account id) is
    // signed by the data account, whose seed IS persisted, so a plain `cotal up` heals it — that is
    // what `healMembershipDataCreds` in `up` does, on every path rather than only a fresh space.
    const down =
      missing.length === 1 && missing[0] === "membership-observer.creds"
        ? "the $SYS observer cred is missing - re-mint it with `cotal down` then `cotal up --rotate-sys`"
        // Name the remedy that matches the MISSING piece, because the two halves are repaired by
        // different acts. The data half (`membership-rw.creds`, `membership.json`) is signed by the
        // data account, whose seed is persisted, so a plain `cotal up` mints it. The $SYS half
        // (observer, evictor) can only be re-minted while the never-persisted $SYS seed is in
        // memory, which is a system-account rotation. Telling an operator to rotate when a plain
        // `up` would do it sends them through a full mesh stop for nothing.
        : `the membership bundle is incomplete here (missing ${missing.join(", ")}) - ${
            missing.every((m) => m === MEMBERSHIP_RW_CREDS_KEY || m === "membership.json")
              ? "run `cotal up` to provision the data-account half (no rotation needed)"
              : "the $SYS-signed creds can only be re-minted while the system account is being provisioned: `cotal down` then `cotal up --rotate-sys`"
          }`;
    console.error(`• membership: ${down}. The graph falls back to traffic-only; delivery is unaffected.`);
    return { down };
  }

  const accountId = (JSON.parse(readFileSync(cfgPath, "utf8")) as { accountId?: string }).accountId;
  if (!accountId) {
    const down = ".cotal/membership.json has no accountId";
    console.error(`• membership: ${down}; membership disabled (delivery unaffected)`);
    return { down };
  }

  // Check the OBSERVER's own expiry before connecting. It is `rotation-renewed`, so unlike every
  // renewable cred here nothing re-signs it: at its 30-day horizon the broker simply answers
  // "Authorization Violation", which names neither the credential nor the repair. Reading the JWT
  // costs nothing and turns the daemon's one loud line into the actual diagnosis: the difference
  // between an operator finding this in minutes and finding it in a support thread.
  const obsCreds = readFileSync(obsPath, "utf8");
  // A TORN rotation is the other way this cred goes broker-dead without a byte of its own changing:
  // `rotateSystemCreds` commits the trust record, then writes both $SYS creds, so a crash between the
  // two leaves one file on the retired system account. The broker answers the same bare
  // "Authorization Violation" either way. The daemon cannot ask the trust record which account is
  // current (it deliberately never loads the signer), but it does not need to: the pair is written
  // by one rotation, so two DIFFERENT issuers prove one of them is stale, with no signer read at all.
  // (`doctor auth`, which legitimately holds the record, checks each file against it directly.)
  const evPath = join(dir, "connection-evictor.creds");
  if (existsSync(evPath)) {
    let obsIss: string | undefined, evIss: string | undefined;
    try {
      obsIss = credsClaims(obsCreds).iss;
      evIss = credsClaims(readFileSync(evPath, "utf8")).iss;
    } catch { /* an unreadable file is the health check's case just below */ }
    if (obsIss !== undefined && evIss !== undefined && obsIss !== evIss) {
      const down = `the two $SYS creds are signed by DIFFERENT system accounts (observer ${obsIss.slice(0, 12)}…, evictor ${evIss.slice(0, 12)}…) - a system-account rotation did not finish, so one of them is broker-dead: re-run \`cotal down\` then \`cotal up --rotate-sys\` to land a complete generation`;
      console.error(`! membership: ${down}; graph membership degraded, delivery unaffected`);
      return { down };
    }
  }
  const obs = inspectCredHealth(obsCreds);
  if (obs.state === "expired" || obs.state === "unreadable") {
    const down =
      obs.state === "expired"
        ? `the $SYS observer cred (${obsPath}) EXPIRED ${new Date((obs.exp ?? 0) * 1000).toISOString()} and the broker denies it - it is rotation-renewed, so nothing re-signs it: run \`cotal down\` then \`cotal up --rotate-sys\` (agents, creds and data are untouched)`
        : `the $SYS observer cred (${obsPath}) is unreadable (${obs.error})`;
    console.error(`! membership: ${down}; graph membership degraded, delivery unaffected`);
    return { down };
  }

  const intervalMs = Number(process.env.COTAL_MEMBERSHIP_INTERVAL_MS) || undefined; // test/ops override
  const handle = await startMembershipFeed({
    servers: opts.server,
    space: opts.space,
    accountId,
    // Observer is rotation-renewed ($SYS): a static read — its renewal is a system rotation + restart.
    observerCreds: obsCreds,
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
  return { handle };
}
