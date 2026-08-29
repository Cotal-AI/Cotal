import { credsClaims, type SecretStore } from "@cotal-ai/core";
import {
  assertSingleSpaceBroker, authDir, connectionEvictorCredsKey, CONNECTION_EVICTOR_CREDS_KIND,
  membershipObserverCredsKey, MEMBERSHIP_OBSERVER_CREDS_KIND, segmentedKey,
} from "@cotal-ai/workspace";

/**
 * THE `$SYS` PAIR, read through the {@link SecretStore} seam and checked before it is used.
 *
 * Both consumers of the observer/evictor creds — the graph feed (`membership.ts`) and the
 * eviction/liveness executors (`evict-exec.ts`) — resolve them here so the three checks that make a
 * `$SYS` cred trustworthy cannot drift apart or exist on only one path:
 *
 *  1. TENANCY (the observer names its own account — {@link observerTenancyProblem});
 *  2. TORN ROTATION (the pair was signed by ONE system account — {@link tornRotationProblem});
 *  3. STORE-AWARE REPAIR (the advice names something the reader can actually do —
 *     {@link repairAdvice}).
 *
 * Check 2 previously existed ONLY in the feed path, so the eviction path could open a half-rotated
 * pair and get a bare "Authorization Violation" from the broker. Sharing it is the point of this
 * module, not a side effect of it.
 *
 * This module DECIDES NOTHING ABOUT POSTURE. It reports problems as strings and absence as a list
 * of missing keys; whether that is a fail-soft `down` (the feed) or a loud throw (eviction) belongs
 * to the caller, because the two postures are deliberately different and flattening them here is
 * exactly the refactor `docs/design/u3-membership-sys-injection.md` §4 exists to prevent.
 */

/** The `$SYS` creds' source: the store to read them from, the SPACE they are scoped to, and whether
 *  that store was INJECTED. `injected` is the composition root's own fact (`store !== undefined` at
 *  the runner) — never inferred by probing the store or sniffing `.cotal/`, both of which report
 *  "workstation" for a hosted daemon and would emit CLI advice a host cannot run (design §4.1).
 *
 *  A UNION rather than a flag plus an optional root, because the workstation arm cannot do its job
 *  without a root and the hosted arm has none: {@link repairAdvice} must ASK the root whether the
 *  command it is about to name would run, and a `root?: string` would let a composition build a
 *  workstation source with no root and silently fall back to advice nobody checked. Same idiom as
 *  the rest of this module — the unsound call is made impossible to express rather than guarded
 *  against at runtime. The two arms are exactly workspace's `SpaceMaterialComposition`, which is
 *  what {@link loadSysPair} hands the per-kind resolvers.
 *
 *  `space` joined it in P7: the pair is per-space material now, so a source that named only a store
 *  and a root no longer names a location. It is on BOTH arms because both need it — the workstation
 *  arm to migrate and read, the hosted arm to build the key it tells an operator to `put` under. */
export type SysCredsSource =
  | { secrets: SecretStore; space: string; injected: true; root?: undefined }
  | { secrets: SecretStore; space: string; injected: false; root: string };

/** The broker-wide operation `repairAdvice` would send a workstation operator to, phrased so the
 *  guard's own refusal reads as a sentence when it is quoted back. */
const ROTATE_SYS = "re-minting the $SYS pair (`cotal up --rotate-sys`)";

/** Why the rotation would refuse on this root, or `undefined` if it would run.
 *
 *  ASKED OF THE GUARD ITSELF, never re-derived from a tenant count read here. The advice is only
 *  honest if it agrees with the thing that actually refuses, and a second implementation of the
 *  single-space rule is a second thing to drift. Every throw counts as a refusal, including the
 *  fail-CLOSED corrupt-inventory one: an operator sent to a command that refuses for a reason this
 *  function could not read is in exactly the state this check exists to end. */
function rotationRefusal(root: string): string | undefined {
  try {
    assertSingleSpaceBroker(authDir(root), ROTATE_SYS);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Repair advice for missing/unusable `$SYS` material, in the reader's own idiom.
 *
 *  The DIAGNOSIS half (which key, which account) is identical in both compositions and is built by
 *  the caller; only this repair TAIL forks. On a workstation the repair is a real command; against a
 *  hosted store it is the mint window plus the key to `put` under, because `cotal up --rotate-sys`
 *  is unactionable there — and emitting it into a hosted log degrades the diagnosis even when the
 *  failure semantics are right. Both halves say the same true thing: the `$SYS` pair can only be
 *  minted while the never-persisted system signing seed is in memory.
 *
 *  THERE IS A THIRD CASE, and until now this function could not see it: on a root hosting several
 *  spaces the workstation advice names two verbs that BOTH refuse. `cotal up --rotate-sys` and
 *  `cotal down` are broker-wide and `assertSingleSpaceBroker` turns them away naming the tenants,
 *  so the operator whose observer is missing is handed a command, runs it, and is refused — with
 *  the refusal itself explaining that the remedy does not exist yet. That is advice which cannot
 *  succeed, the same defect `healMembershipDataCreds`'s own comment records, and it was reachable
 *  on a real root (`docs/design/space-segmentation-p7-p1.md` §6, probe-executed).
 *
 *  So the workstation arm consults the guard before naming its command, and where the guard would
 *  refuse it states the truth instead: the guard's own words, then the reason no other command can
 *  substitute. NAMING NOTHING IS THE POINT — there is no verb to offer here, and inventing a
 *  gentler-sounding one would restore the defect.
 *
 *  This makes the function read the filesystem on the workstation arm, which is why the callers
 *  pass it as a THUNK: it is built only on a path that has already failed, never on a healthy one. */
export function repairAdvice(source: SysCredsSource, kinds: readonly string[]): string {
  const named = kinds.length ? kinds.join(" + ") : "the $SYS pair";
  // The hosted arm names a KEY to `put` under, so it must name the SEGMENTED one — the kind alone is
  // the pre-P7 key and putting there would leave the daemon still reading an empty location. The
  // workstation arm names a command, not a key, so it keeps the kinds an operator recognises.
  // Non-migrating on purpose: this builds a STRING for a store the process cannot reach.
  if (source.injected)
    return `re-mint the $SYS pair at a system-account rotation (the seed is in memory only at that moment) and \`put\` it under ${
      kinds.length ? kinds.map((k) => segmentedKey(k, source.space)).join(" + ") : "the $SYS pair's per-space keys"
    }`;
  const refusal = rotationRefusal(source.root);
  if (refusal === undefined) return "re-mint it with `cotal down` then `cotal up --rotate-sys`";
  return (
    `${refusal}. There is no other command that mints ${named}: the $SYS signing seed is discarded at provisioning, ` +
    "so nothing can re-sign it on this root until per-space segmentation lands"
  );
}

/** The DATA account an observer cred is scoped to, read out of its own `$SYS.REQ.ACCOUNT.<id>.CONNZ`
 *  publish permission, or `undefined` if it carries none.
 *
 *  This is a LOCAL read of a signed document, and it buys the DIAGNOSIS, not the guarantee: the
 *  broker independently refuses a CONNZ request for any other account, because the permission is in
 *  the JWT it validates. Doing it here, before connecting, is what turns that refusal from a bare
 *  "Authorization Violation" into a line naming both accounts (design §4.3). */
export function connzAccountOf(observerCreds: string): string | undefined {
  for (const subject of credsClaims(observerCreds).nats?.pub?.allow ?? []) {
    const m = /^\$SYS\.REQ\.ACCOUNT\.(A[A-Z2-7]{55})\.CONNZ$/.exec(subject);
    if (m) return m[1];
  }
  return undefined;
}

/**
 * THE TENANCY CHECK — the guard that replaces the eliminated `membership.json` cross-check.
 *
 * Every sweep below resolves an ACCOUNT, and a complete, well-formed sweep of the WRONG account is
 * indistinguishable from "the principal is gone": a healthy-looking answer that authorizes eviction.
 * Note the asymmetry that makes this necessary — an observer scoped to A used with accountId B
 * under-reports (broker-denied → `unknown`, safe), but observer A used with accountId A while the
 * GATE lives on B is internally consistent and answers a confident, WRONG `gone`.
 *
 * Checking the observer against the account the daemon's OWN cred authenticates as is strictly
 * stronger than the file it replaces: the file sat in the same `.cotal/` dir as the creds, so a root
 * that was wrong was wrong for both, and its independence came from `expectedAccount` being derived
 * from the cred anyway. The cred was always the real authority; the file was the thing being checked.
 *
 * An observer carrying NO CONNZ permission is refused rather than trusted: it cannot do the job, and
 * treating "no account named" as "any account" is the exact failure this guard exists to stop.
 */
export function observerTenancyProblem(observerCreds: string, expectedAccount: string): string | undefined {
  let scoped: string | undefined;
  try {
    scoped = connzAccountOf(observerCreds);
  } catch (e) {
    return `the $SYS observer cred is unreadable (${(e as Error).message})`;
  }
  if (scoped === undefined)
    return "the $SYS observer cred carries no `$SYS.REQ.ACCOUNT.<id>.CONNZ` permission, so it names no account to sweep and cannot be checked against this daemon's own tenancy";
  if (scoped !== expectedAccount)
    return (
      `the $SYS observer cred is scoped to account ${scoped}, but this daemon's own credential authenticates as ${expectedAccount}. ` +
      "That credential belongs to a different mesh, and sweeping it would return a confident, WRONG answer (a complete sweep of the wrong account is indistinguishable from a gone principal)"
    );
  return undefined;
}

/**
 * THE TORN-ROTATION CHECK — two `$SYS` creds signed by DIFFERENT system accounts.
 *
 * `rotateSystemCreds` commits the trust record, then writes both creds, so a crash between the two
 * leaves one of them on the RETIRED system account. The broker answers the same bare "Authorization
 * Violation" either way, and the daemon cannot ask the trust record which account is current (it
 * deliberately never loads the signer) — but it does not need to: the pair is written by ONE
 * rotation, so two different issuers prove one of them is stale, with no signer read at all.
 *
 * Shared by both paths as of this change. It previously lived only in the feed, which left eviction
 * — the path that actually kills connections — opening a half-rotated pair blind.
 *
 * `advice` is a THUNK because {@link repairAdvice} now reads the root's tenant list: both call sites
 * sit on a healthy path (`loadCheckedSys` runs per eviction), and eagerly building advice nobody
 * will read would put a directory listing on every successful call.
 */
export function tornRotationProblem(observerCreds: string, evictorCreds: string, advice: () => string): string | undefined {
  let obsIss: string | undefined, evIss: string | undefined;
  try {
    obsIss = credsClaims(observerCreds).iss;
    evIss = credsClaims(evictorCreds).iss;
  } catch {
    return undefined; // an undecodable cred is the health check's case, reported with its own message
  }
  if (obsIss === undefined || evIss === undefined || obsIss === evIss) return undefined;
  return (
    `the two $SYS creds are signed by DIFFERENT system accounts (observer ${obsIss.slice(0, 12)}…, evictor ${evIss.slice(0, 12)}…) - ` +
    `a system-account rotation did not finish, so one of them is broker-dead: ${advice()} to land a complete generation`
  );
}

/** What {@link loadSysPair} was asked for. The liveness verbs are READ-ONLY and must not even read
 *  the KICK cred — least privilege is not only about what a connection may do, but about what the
 *  process reads into memory on a path that never needs it. */
export type SysCredsNeed = "observer" | "both";

export interface SysPair {
  observer?: string;
  evictor?: string;
  /** Keys the store returned `undefined` for — ABSENCE, per the `SecretStore` contract. A `get()`
   *  that THROWS is a refusal, not an absence, and propagates out of {@link loadSysPair}. */
  missing: string[];
}

/** Read the `$SYS` pair through the store. Absence is reported; every other failure propagates.
 *
 *  The distinction is load-bearing: `undefined` means "not provisioned here", which each caller
 *  answers in its own posture, whereas a KMS timeout or a revoked role is a REFUSAL that must not be
 *  mistaken for an unprovisioned space and quietly degraded into deny-new-only.
 *
 *  Reading per call (rather than once at start) is strictly better than the `readFileSync` it
 *  replaces: a hosted store re-keyed by a rotation is picked up on the next eviction with no daemon
 *  restart. No renewal timer is added, and none is wanted — these stay `rotation-renewed`. */
export async function loadSysPair(source: SysCredsSource, need: SysCredsNeed): Promise<SysPair> {
  // The per-kind RESOLVERS (P7 §2 rule 1). The source's two arms ARE the composition they take, so
  // a workstation daemon moves a legacy flat pair on this first touch and a hosted one never
  // touches a filesystem. Reading the canonical location WITHOUT that move is the failure the
  // resolver exists to stop: it answers `undefined`, which every caller here treats as "not
  // provisioned", and sends an operator to a rotation for creds that are sitting on the same disk.
  const observer = await source.secrets.get(membershipObserverCredsKey(source.space, source));
  const evictor = need === "both" ? await source.secrets.get(connectionEvictorCredsKey(source.space, source)) : undefined;
  // Reported as KINDS, never the segmented keys: `missing` is read by operators and compared
  // against by callers (`membership.ts` filters the evictor out of its own diagnosis by name), and
  // a `space.<hex>/` prefix would break both. The hosted arm's `put` key is named by `repairAdvice`.
  const missing = [
    observer === undefined ? MEMBERSHIP_OBSERVER_CREDS_KIND : undefined,
    need === "both" && evictor === undefined ? CONNECTION_EVICTOR_CREDS_KIND : undefined,
  ].filter((k): k is string => k !== undefined);
  return { ...(observer !== undefined ? { observer } : {}), ...(evictor !== undefined ? { evictor } : {}), missing };
}
