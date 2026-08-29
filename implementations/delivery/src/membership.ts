import { inspectCredHealth, startMembershipFeed, type MembershipFeedHandle, type SecretStore } from "@cotal-ai/core";
import { CONNECTION_EVICTOR_CREDS_KIND, findCotalRoot, membershipRwCredsKey, MEMBERSHIP_OBSERVER_CREDS_KIND, MEMBERSHIP_RW_CREDS_KIND, workspaceSecretStore } from "@cotal-ai/workspace";
import { loadSysPair, observerTenancyProblem, repairAdvice, tornRotationProblem, type SysCredsSource } from "./sys-creds.js";

/**
 * The delivery daemon's thin composition root for the broker-sourced graph-membership feed. Every
 * credential it needs — the DATA-account rw cred AND the SYSTEM-account observer — now resolves
 * through the {@link SecretStore} seam, so a hosted composition can supply all of them with no file
 * on disk. `store` is that injection point; with none, the workstation FS store is used (keys = the
 * filenames under `.cotal/`), so a local `cotal up` is byte-for-byte unchanged. It hands the two
 * creds + the account id to the core feed engine ({@link startMembershipFeed}, which owns the two
 * connections + the poll loop + the rw 75% renewal).
 *
 * The ACCOUNT ID is no longer read from `.cotal/membership.json`. It arrives as `opts.accountId` —
 * the account the daemon's own delivery cred authenticates as, pinned once at start — and the
 * observer is checked against it intrinsically (see `sys-creds.ts`). That file was never an
 * independent source: it sat in the same directory as the creds, so a wrong root was wrong for both.
 *
 * Deliberately ISOLATED from Plane-3: a separate module, separate connections, and a fail-soft
 * contract — if the creds aren't provisioned (a pre-feature space) or the feed can't start, it logs
 * and returns `{ down }`; the graph degrades to traffic-only and delivery is untouched.
 */

/** Why the feed is, or is not, running. `down` carries the DIAGNOSIS to the caller, because the
 *  daemon's log line is not the only place it is needed: an adoption reply that says only "the feed is
 *  not running" sends an operator hunting for a feed fault when the real one is an expired $SYS cred
 *  three layers down (the failure reported in #338). Exactly one of the two members is set. */
export type MembershipStart = { handle: MembershipFeedHandle; down?: undefined } | { handle?: undefined; down: string };

export async function startMembership(
  opts: { space: string; server: string; accountId: string },
  store?: SecretStore,
): Promise<MembershipStart> {
  // `injected` is the composition root's own fact, decided here before any I/O — never inferred by
  // probing the store or sniffing `.cotal/`, which would report "workstation" for a hosted daemon
  // and emit a CLI repair the host cannot run (design §4.1). The workstation arm carries the root
  // it resolved, because that is what lets `repairAdvice` ask whether the command it would name is
  // one this root can actually run; a hosted composition has no root and names no command.
  // Spelled as a branch, not a `??`, so the root is still resolved ONLY when no store was injected.
  let source: SysCredsSource;
  if (store === undefined) {
    const root = findCotalRoot();
    source = { secrets: workspaceSecretStore(root), space: opts.space, injected: false, root };
  } else {
    source = { secrets: store, space: opts.space, injected: true };
  }

  // Through the per-kind resolver (P7 §2 rule 1) — the source's arms ARE the composition it takes.
  // The rw cred is absent-means-MINT on the `up` side, so reading the canonical location past an
  // unmigrated copy would report the bundle incomplete and let the next `up` mint a second one.
  const rwKey = membershipRwCredsKey(opts.space, source);
  const rw = await source.secrets.get(rwKey);
  // Ask for both $SYS creds: the observer is REQUIRED, the evictor only feeds the torn-rotation
  // check below. A space with no evictor still runs a perfectly good feed (eviction refuses on its
  // own path, loudly), so its absence must not take the feed down.
  const sys = await loadSysPair(source, "both");
  const missing = [
    rw === undefined ? MEMBERSHIP_RW_CREDS_KIND : undefined,
    ...sys.missing.filter((k) => k !== CONNECTION_EVICTOR_CREDS_KIND),
  ].filter((f): f is string => f !== undefined);
  if (missing.length) {
    // Name the missing piece AND a repair that reaches it. The bundle has two halves with two
    // different repairs, and naming the wrong one costs an operator a full mesh stop for nothing.
    // The $SYS-signed half (observer, evictor) can only be minted while the never-persisted system
    // signing seed is in memory, so it takes a rotation. The DATA half (the rw cred) is signed by
    // the data account, whose seed IS persisted, so a plain `cotal up` heals it — that is what
    // `healMembershipDataCreds` in `up` does, on every path rather than only a fresh space.
    // Only the REPAIR tail forks on `injected`; this diagnosis half is identical in both.
    const sysMissing = missing.filter((m) => m === MEMBERSHIP_OBSERVER_CREDS_KIND);
    const down =
      missing.length === 1 && missing[0] === MEMBERSHIP_OBSERVER_CREDS_KIND
        ? `the $SYS observer cred is missing (kind "${MEMBERSHIP_OBSERVER_CREDS_KIND}") - ${repairAdvice(source, sysMissing)}`
        : `the membership bundle is incomplete here (missing ${missing.join(", ")}) - ${
            sysMissing.length === 0
              ? source.injected
                ? `re-sign the data-account half into the store under ${rwKey} (no rotation needed)`
                : "run `cotal up` to provision the data-account half (no rotation needed)"
              : `the $SYS-signed creds can only be re-minted while the system account is being provisioned: ${repairAdvice(source, sysMissing)}`
          }`;
    console.error(`• membership: ${down}. The graph falls back to traffic-only; delivery is unaffected.`);
    return { down };
  }
  const obsCreds = sys.observer as string; // required above; absence already returned

  // TENANCY, before connecting. The observer names its own DATA account in its CONNZ permission, so
  // it can be checked against the account this daemon's own cred authenticates as with no adjacent
  // file at all. The broker enforces the same scoping independently — this local read buys the
  // DIAGNOSIS (a line naming both accounts) rather than the guarantee.
  const tenancy = observerTenancyProblem(obsCreds, opts.accountId);
  if (tenancy) {
    console.error(`! membership: ${tenancy}; graph membership degraded, delivery unaffected`);
    return { down: tenancy };
  }

  // A TORN rotation is the other way this cred goes broker-dead without a byte of its own changing:
  // `rotateSystemCreds` commits the trust record, then writes both $SYS creds, so a crash between the
  // two leaves one on the retired system account, and the broker answers the same bare
  // "Authorization Violation" either way. Shared with the eviction path as of this change — it used
  // to live only here, which left eviction opening a half-rotated pair blind.
  if (sys.evictor !== undefined) {
    const torn = tornRotationProblem(obsCreds, sys.evictor, () => repairAdvice(source, [MEMBERSHIP_OBSERVER_CREDS_KIND, CONNECTION_EVICTOR_CREDS_KIND]));
    if (torn) {
      console.error(`! membership: ${torn}; graph membership degraded, delivery unaffected`);
      return { down: torn };
    }
  }

  // Check the OBSERVER's own expiry before connecting. It is `rotation-renewed`, so unlike every
  // renewable cred here nothing re-signs it: at its 30-day horizon the broker simply answers
  // "Authorization Violation", which names neither the credential nor the repair. Reading the JWT
  // costs nothing and turns the daemon's one loud line into the actual diagnosis: the difference
  // between an operator finding this in minutes and finding it in a support thread.
  const obs = inspectCredHealth(obsCreds);
  if (obs.state === "expired" || obs.state === "unreadable") {
    const down =
      obs.state === "expired"
        ? `the $SYS observer cred (kind "${MEMBERSHIP_OBSERVER_CREDS_KIND}") EXPIRED ${new Date((obs.exp ?? 0) * 1000).toISOString()} and the broker denies it - it is rotation-renewed, so nothing re-signs it: ${repairAdvice(source, [MEMBERSHIP_OBSERVER_CREDS_KIND])} (agents, creds and data are untouched)`
        : `the $SYS observer cred (kind "${MEMBERSHIP_OBSERVER_CREDS_KIND}") is unreadable (${obs.error})`;
    console.error(`! membership: ${down}; graph membership degraded, delivery unaffected`);
    return { down };
  }

  const intervalMs = Number(process.env.COTAL_MEMBERSHIP_INTERVAL_MS) || undefined; // test/ops override
  const handle = await startMembershipFeed({
    servers: opts.server,
    space: opts.space,
    accountId: opts.accountId,
    // Observer is rotation-renewed ($SYS): a static read — its renewal is a system rotation + restart.
    observerCreds: obsCreds,
    // rw is class-2 standing-renewable: read through the store seam and renewed on a 75% timer that
    // preflight-proves each candidate the manager re-signs into the store (D5 slice 5). The daemon
    // never sees the signer; the manager owns the re-sign.
    rwCreds: async () => {
      const cur = await source.secrets.get(rwKey);
      if (cur === undefined)
        throw new Error(`membership: the scoped rw cred is gone (kind "${MEMBERSHIP_RW_CREDS_KIND}") — restore it (locally: re-run \`cotal up\`) before the current JWT expires`);
      return cur;
    },
    intervalMs,
  });
  console.log(`✓ membership feed up (broker-sourced channel membership) — space ${opts.space}`);
  return { handle };
}
