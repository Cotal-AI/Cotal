import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  evictDeniedPrincipalWithCreds,
  isPlaneConnTuple,
  isPrincipalOwnerToken,
  observePlaneLivenessWithCreds,
  observePrincipalLivenessWithCreds,
  parsePrincipalKey,
  type EvictionResult,
  type PlaneLivenessQuery,
  type PlaneLivenessResult,
  type PrincipalLivenessResult,
} from "@cotal-ai/core";
import { CONNECTION_EVICTOR_CREDS_KIND, findCotalRoot, membershipConfigPath, MEMBERSHIP_OBSERVER_CREDS_KIND } from "@cotal-ai/workspace";
import { loadSysPair, observerTenancyProblem, repairAdvice, tornRotationProblem, type SysCredsSource } from "./sys-creds.js";


/**
 * THE SCAN TARGET, resolved fail-closed and BOUND TO THE DAEMON'S OWN TENANCY.
 *
 * Every executor below sweeps an ACCOUNT, and a complete, well-formed sweep of the WRONG account is
 * indistinguishable from "the principal is gone" — it is a healthy-looking answer that authorizes
 * eviction and gate reconciliation. The account used to be read from `findCotalRoot()` at REQUEST
 * time with nothing tying it to the space the daemon serves, so a daemon whose working directory
 * resolved a different mesh root (a parent mesh, a home mesh, a leftover scratch root, a service
 * unit with the wrong WorkingDirectory) would sweep a foreign tenant and answer `gone` for a
 * principal that was alive on its own.
 *
 * Two independent guards, because either alone leaves a real case open:
 *  - the root is PINNED AT DAEMON START, so it cannot drift with `process.cwd()` between requests;
 *  - the OBSERVER CRED is CROSS-CHECKED against the account the daemon's own credential
 *    authenticates as. Pinning alone cannot notice a daemon that started in the wrong root to
 *    begin with; the tenancy check can, because neither side of it is read from that root.
 *
 * The second guard used to compare `.cotal/membership.json` against `expectedAccount`. It now
 * compares the OBSERVER'S OWN CONNZ PERMISSION against it (`sys-creds.ts`), which is strictly
 * stronger: the file sat in the same directory as the creds, so a wrong root was wrong for both, and
 * its independence came from `expectedAccount` being derived from the cred anyway — the cred was
 * always the real authority and the file was the thing being checked. The disk file is still read as
 * a SECOND source on the workstation path, where the root genuinely can drift; it is no longer
 * required, and a hosted composition has none.
 *
 * A mismatch REFUSES LOUD and names both sides. Note the asymmetry that makes this necessary: an
 * observer scoped to account A with accountId B under-reports (broker-denied → `unknown`, safe),
 * but observer A with accountId A while the GATE lives on B is internally consistent and answers a
 * confident, wrong `gone`.
 */
export interface ScanTarget {
  /** The mesh root resolved ONCE at daemon start — never re-resolved per request. */
  root: string;
  /** The account the daemon's own delivery credential authenticates as. */
  expectedAccount: string;
  /** Where the $SYS pair is read from, and whether that store was injected (hosted) — the latter
   *  selects the repair idiom only, never the failure semantics. */
  source: SysCredsSource;
}

/**
 * Pin check + the WORKSTATION-ONLY second source.
 *
 * The account to sweep is `target.expectedAccount` — the daemon's own credential, pinned at start.
 * `membership.json` is no longer consulted for it. On the workstation path the file is still
 * cross-checked WHEN PRESENT, because there a wrong root is a real, enumerated failure mode
 * (see the cases above) and a second independent-ish source costs nothing. It is no longer
 * REQUIRED: its absence is not an error, and a hosted composition never has one.
 */
export function validateScanTarget(target: ScanTarget, verb = "delivery startup"): { accountId: string } {
  const live = findCotalRoot();
  if (live !== target.root)
    throw new Error(
      `${verb}: the mesh root resolved at this request (${live}) is not the one this daemon started in (${target.root}); ` +
      "the scan account would be read from a different workspace than the one this daemon serves. Refusing — a sweep of the wrong account looks exactly like a dead principal",
    );
  if (!target.source.injected) {
    // Through the kind's resolver (P7 §2 rule 1), not a hand-composed `.cotal/membership.json`:
    // the file is per-space now, and reading the canonical location past an unmigrated copy would
    // silently drop this second source — turning a wrong-root refusal into a confident sweep.
    // `target.source.space` is the space the daemon started in, pinned with the rest of the source.
    const cfgPath = membershipConfigPath(target.root, target.source.space);
    if (existsSync(cfgPath)) {
      // A malformed file on a path that no longer needs it must not take eviction down; only a file
      // that names a DIFFERENT account is evidence of the drift this check exists to catch.
      let onDisk: string | undefined;
      try { onDisk = (JSON.parse(readFileSync(cfgPath, "utf8")) as { accountId?: string }).accountId; }
      catch { onDisk = undefined; }
      if (onDisk !== undefined && onDisk !== target.expectedAccount)
        throw new Error(
          `${verb}: ${cfgPath} names account ${onDisk}, but this daemon's own credential authenticates as ${target.expectedAccount}. ` +
          "That disk material belongs to a different mesh, and sweeping it would return a confident, WRONG answer (a complete sweep of the wrong account is indistinguishable from a gone principal). Refusing — start the daemon from the workspace root whose account it serves",
        );
    }
  }
  return { accountId: target.expectedAccount };
}

/** Startup admission for the scan-backed delivery-admin rail.
 *
 * Root stability alone is not a tenancy proof for an injected store: the hosted composition has no
 * `membership.json`, and the store may return another tenant's structurally valid observer. Read
 * the pair through the exact source the executors will use, then validate the observer before the
 * endpoint exists or lease.0 can be acquired. The observer is required because every liveness
 * verdict needs an account-scoped complete scan. The evictor remains optional for pre-eviction
 * spaces (their documented posture is deny-new-only), but when present it participates in the
 * torn-rotation check so a mixed generation cannot be admitted as healthy.
 */
export async function validateScanTargetAdmission(target: ScanTarget): Promise<{ accountId: string }> {
  const scan = validateScanTarget(target);
  const sys = await loadSysPair(target.source, "both");
  if (sys.observer === undefined)
    throw new Error(
      `delivery startup: the $SYS observer cred is not provisioned here (missing ${MEMBERSHIP_OBSERVER_CREDS_KIND}) - ${
        repairAdvice(target.source, [MEMBERSHIP_OBSERVER_CREDS_KIND])
      }. Refusing before endpoint construction and lease admission because this daemon cannot establish which account its scan rail serves`,
    );
  const tenancy = observerTenancyProblem(sys.observer, target.expectedAccount);
  if (tenancy) throw new Error(`delivery startup: ${tenancy}. Refusing before endpoint construction and lease admission`);
  if (sys.evictor !== undefined) {
    const torn = tornRotationProblem(sys.observer, sys.evictor, () =>
      repairAdvice(target.source, [MEMBERSHIP_OBSERVER_CREDS_KIND, CONNECTION_EVICTOR_CREDS_KIND]));
    if (torn) throw new Error(`delivery startup: ${torn}. Refusing before endpoint construction and lease admission`);
  }
  return scan;
}

/** Read the $SYS material for one verb and run every pre-connect check, or THROW.
 *
 *  Fail-loud is the whole posture here (design §4.2): a missing key is a REFUSAL, full stop. In
 *  particular a missing evictor must NOT silently fall back to deny-new-only inside the executor —
 *  that posture is the CALLER's documented degradation, reached by handling this refusal, never
 *  something the executor may choose on its own. And absence (`undefined` per the `SecretStore`
 *  contract) is the only thing treated as "not provisioned": a `get()` that throws is a refusal,
 *  not an absence, and propagates untouched from `loadSysPair`. */
async function loadCheckedSys(target: ScanTarget, verb: string, need: "observer" | "both"): Promise<{ observer: string; evictor?: string }> {
  const sys = await loadSysPair(target.source, need);
  if (sys.missing.length)
    throw new Error(
      `${verb}: the $SYS ${need === "both" ? "observer/evictor creds are" : "observer creds are"} not provisioned here ` +
      `(missing ${sys.missing.join(", ")}; a space created before live eviction) - ${repairAdvice(target.source, sys.missing)}. ` +
      "Until then removal is deny-new-only (durable reauth)",
    );
  const observer = sys.observer as string;
  const tenancy = observerTenancyProblem(observer, target.expectedAccount);
  if (tenancy) throw new Error(`${verb}: ${tenancy}. Refusing`);
  if (sys.evictor !== undefined) {
    // The torn-rotation check now covers this path too. It used to exist only in the feed, so
    // eviction could open a half-rotated pair and get a bare "Authorization Violation" from the
    // broker with nothing naming the cause.
    const torn = tornRotationProblem(observer, sys.evictor, () => repairAdvice(target.source, [MEMBERSHIP_OBSERVER_CREDS_KIND, CONNECTION_EVICTOR_CREDS_KIND]));
    if (torn) throw new Error(`${verb}: ${torn}. Refusing`);
  }
  return { observer, ...(sys.evictor !== undefined ? { evictor: sys.evictor } : {}) };
}

/**
 * The delivery daemon's LIVE-EVICTION executor (D5 slice 6, on the privileged delivery-admin rail):
 * force-drop a denied principal's live connections via the core scan→KICK→verify primitive. The two
 * $SYS creds are the real gate — the KICK-only evictor and the CONNZ observer, both minted only at a
 * fresh `up` — and core opens them PER CALL (eviction is a rare repair/flip step, never a standing
 * $SYS connection in the daemon). A space provisioned before the evictor existed refuses loudly with
 * the regeneration step — deny-new-only (durable reauth) remains its honest posture.
 */
export async function executeEviction(server: string, target: ScanTarget, principal: string): Promise<EvictionResult> {
  // Fail-closed principal validation — the KICK targets come from the observer's own CONNZ scan,
  // but the FILTER must be a REAL principal: syntax alone is not enough, because CONNZ attribution
  // only ever surfaces owners that pass isPrincipalOwnerToken (`local` / derived `u_…`), so a
  // syntactically-valid non-principal like `foo.bar` could scan completely, match nothing, and
  // return a HEALTHY verified no-op — false confidence for a typo'd or old-shape target (the
  // critic's slice-6 catch). Same owner boundary as attribution, refused loudly instead.
  const parsed = parsePrincipalKey(principal);
  if (!parsed || !isPrincipalOwnerToken(parsed.owner))
    throw new Error(`evictPrincipal: "${principal}" is not a real owner.actor principal (owner must be \`local\` or a derived \`u_…\` token — the only shapes CONNZ attribution can surface)`);
  const { accountId } = validateScanTarget(target, "evictPrincipal");
  const sys = await loadCheckedSys(target, "evictPrincipal", "both");
  return evictDeniedPrincipalWithCreds({
    servers: server,
    observerCreds: sys.observer,
    evictorCreds: sys.evictor as string,
    accountId,
    principal,
  });
}

/**
 * The delivery daemon's PLANE-LIVENESS oracle executor (#29 HIGH 3, on the privileged
 * delivery-admin rail): answer whether the auth plane's two claimed sealed-scanner connections are
 * live/gone/unknown via the $SYS CONNZ observer cred (opened per call; READ-ONLY — the KICK
 * evictor cred never enters this path). The query is a CLOSED shape: exactly two role-keyed
 * connection tuples; anything else refuses loudly. A space provisioned before the observer existed
 * refuses with the regeneration step — the auth plane treats that refusal as UNKNOWN and never
 * reclaims over it (fail-closed).
 *
 * Asks for the observer ONLY, so the KICK cred is not even read into this process's memory on a
 * read-only path. The cost is that the torn-rotation check cannot run here (it needs both halves);
 * that is safe rather than a gap — a torn pair whose observer is the stale half is refused by the
 * broker, and this path reads any refusal as UNKNOWN, which is already fail-closed.
 */
export async function executePlaneLiveness(server: string, target: ScanTarget, query: unknown): Promise<PlaneLivenessResult> {
  const q = query as Partial<PlaneLivenessQuery> | undefined;
  if (q === undefined || q === null || typeof q !== "object" ||
      Object.keys(q).some((k) => k !== "ledger" && k !== "records") || // closed top-level shape
      !isPlaneConnTuple(q.ledger) || !isPlaneConnTuple(q.records))
    throw new Error("planeConnLiveness: the query must be exactly { ledger, records } connection tuples ({ serverId, cid, userNkey }); refusing a malformed or wider query");
  const { accountId } = validateScanTarget(target, "planeConnLiveness");
  const sys = await loadCheckedSys(target, "planeConnLiveness", "observer");
  return observePlaneLivenessWithCreds({
    servers: server,
    observerCreds: sys.observer,
    accountId,
    query: { ledger: q.ledger, records: q.records },
  });
}

/**
 * The delivery daemon's FREEZE-HOLDER LIVENESS probe (#391, on the privileged delivery-admin rail):
 * answer whether ONE principal still holds a live connection, via the $SYS CONNZ observer cred
 * (opened per call; READ-ONLY — the KICK evictor cred never enters this path, and is not even read
 * from the store here).
 *
 * This is the READ half of {@link executeEviction}, and it exists because the write half cannot
 * serve as its own precheck: a repair that must REFUSE while the holder is alive would, using
 * `evictPrincipal` to find out, kill the holder before it could refuse. Same observer cred, same
 * sweep, same refusal posture as the plane oracle — a space provisioned before the observer existed
 * refuses with the regeneration step, and the caller treats that refusal as UNKNOWN and never
 * repairs over it (fail-closed).
 */
export async function executePrincipalLiveness(server: string, target: ScanTarget, principal: unknown): Promise<PrincipalLivenessResult> {
  // Same fail-closed principal boundary the eviction filter applies, for the same reason: CONNZ
  // attribution only ever surfaces `local` / derived `u_…` owners, so a syntactically-valid
  // non-principal would sweep completely, match nothing, and read as a healthy `gone` — false
  // confidence for a typo'd or old-shape holder, on the exact verdict that authorizes the repair.
  if (typeof principal !== "string" || principal.trim().length === 0)
    throw new Error("principalLiveness: a principal (owner.actor dot-form) is required");
  const wanted = principal.trim();
  const parsed = parsePrincipalKey(wanted);
  if (!parsed || !isPrincipalOwnerToken(parsed.owner))
    throw new Error(`principalLiveness: "${wanted}" is not a real owner.actor principal (owner must be \`local\` or a derived \`u_…\` token — the only shapes CONNZ attribution can surface)`);
  const { accountId } = validateScanTarget(target, "principalLiveness");
  const sys = await loadCheckedSys(target, "principalLiveness", "observer");
  return observePrincipalLivenessWithCreds({
    servers: server,
    observerCreds: sys.observer,
    accountId,
    principal: wanted,
  });
}
