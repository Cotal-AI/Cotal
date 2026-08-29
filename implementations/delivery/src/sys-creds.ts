import { credsClaims, type SecretStore } from "@cotal-ai/core";
import { CONNECTION_EVICTOR_CREDS_KEY, MEMBERSHIP_OBSERVER_CREDS_KEY } from "@cotal-ai/workspace";

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

/** The `$SYS` creds' source: the store to read them from, plus whether that store was INJECTED.
 *  `injected` is the composition root's own fact (`store !== undefined` at the runner) — never
 *  inferred by probing the store or sniffing `.cotal/`, both of which report "workstation" for a
 *  hosted daemon and would emit CLI advice a host cannot run (design §4.1). */
export interface SysCredsSource {
  secrets: SecretStore;
  injected: boolean;
}

/** Repair advice for missing/unusable `$SYS` material, in the reader's own idiom.
 *
 *  The DIAGNOSIS half (which key, which account) is identical in both compositions and is built by
 *  the caller; only this repair TAIL forks. On a workstation the repair is a real command; against a
 *  hosted store it is the mint window plus the key to `put` under, because `cotal up --rotate-sys`
 *  is unactionable there — and emitting it into a hosted log degrades the diagnosis even when the
 *  failure semantics are right. Both halves say the same true thing: the `$SYS` pair can only be
 *  minted while the never-persisted system signing seed is in memory. */
export function repairAdvice(source: SysCredsSource, keys: readonly string[]): string {
  const named = keys.length ? keys.join(" + ") : "the $SYS pair";
  return source.injected
    ? `re-mint the $SYS pair at a system-account rotation (the seed is in memory only at that moment) and \`put\` it under ${named}`
    : "re-mint it with `cotal down` then `cotal up --rotate-sys`";
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
 */
export function tornRotationProblem(observerCreds: string, evictorCreds: string, advice: string): string | undefined {
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
    `a system-account rotation did not finish, so one of them is broker-dead: ${advice} to land a complete generation`
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
  const observer = await source.secrets.get(MEMBERSHIP_OBSERVER_CREDS_KEY);
  const evictor = need === "both" ? await source.secrets.get(CONNECTION_EVICTOR_CREDS_KEY) : undefined;
  const missing = [
    observer === undefined ? MEMBERSHIP_OBSERVER_CREDS_KEY : undefined,
    need === "both" && evictor === undefined ? CONNECTION_EVICTOR_CREDS_KEY : undefined,
  ].filter((k): k is string => k !== undefined);
  return { ...(observer !== undefined ? { observer } : {}), ...(evictor !== undefined ? { evictor } : {}), missing };
}
