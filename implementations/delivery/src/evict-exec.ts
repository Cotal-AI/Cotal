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
import { findCotalRoot } from "@cotal-ai/workspace";

/**
 * The delivery daemon's LIVE-EVICTION executor (D5 slice 6, on the privileged delivery-admin rail):
 * force-drop a denied principal's live connections via the core scan→KICK→verify primitive. The two
 * $SYS creds are the real gate — the KICK-only evictor and the CONNZ observer, both minted only at a
 * fresh `up` — and core opens them PER CALL (eviction is a rare repair/flip step, never a standing
 * $SYS connection in the daemon). A space provisioned before the evictor existed refuses loudly with
 * the regeneration step — deny-new-only (durable reauth) remains its honest posture.
 */
export async function executeEviction(server: string, principal: string): Promise<EvictionResult> {
  // Fail-closed principal validation — the KICK targets come from the observer's own CONNZ scan,
  // but the FILTER must be a REAL principal: syntax alone is not enough, because CONNZ attribution
  // only ever surfaces owners that pass isPrincipalOwnerToken (`local` / derived `u_…`), so a
  // syntactically-valid non-principal like `foo.bar` could scan completely, match nothing, and
  // return a HEALTHY verified no-op — false confidence for a typo'd or old-shape target (the
  // critic's slice-6 catch). Same owner boundary as attribution, refused loudly instead.
  const parsed = parsePrincipalKey(principal);
  if (!parsed || !isPrincipalOwnerToken(parsed.owner))
    throw new Error(`evictPrincipal: "${principal}" is not a real owner.actor principal (owner must be \`local\` or a derived \`u_…\` token — the only shapes CONNZ attribution can surface)`);
  const dir = join(findCotalRoot(), ".cotal");
  const obsPath = join(dir, "membership-observer.creds");
  const evPath = join(dir, "connection-evictor.creds");
  const cfgPath = join(dir, "membership.json");
  if (!existsSync(obsPath) || !existsSync(evPath))
    throw new Error(
      "evictPrincipal: the $SYS observer/evictor creds are not provisioned here (a space created before live eviction); mint them with `cotal down` then `cotal up --rotate-sys`. Until then removal is deny-new-only (durable reauth)",
    );
  if (!existsSync(cfgPath))
    throw new Error(
      `evictPrincipal: ${cfgPath} is missing, so the account to scan is unknown; until then removal is deny-new-only (durable reauth)`,
    );
  const accountId = (JSON.parse(readFileSync(cfgPath, "utf8")) as { accountId?: string }).accountId;
  if (!accountId) throw new Error("evictPrincipal: .cotal/membership.json has no accountId");
  return evictDeniedPrincipalWithCreds({
    servers: server,
    observerCreds: readFileSync(obsPath, "utf8"),
    evictorCreds: readFileSync(evPath, "utf8"),
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
 */
export async function executePlaneLiveness(server: string, query: unknown): Promise<PlaneLivenessResult> {
  const q = query as Partial<PlaneLivenessQuery> | undefined;
  if (q === undefined || q === null || typeof q !== "object" ||
      Object.keys(q).some((k) => k !== "ledger" && k !== "records") || // closed top-level shape
      !isPlaneConnTuple(q.ledger) || !isPlaneConnTuple(q.records))
    throw new Error("planeConnLiveness: the query must be exactly { ledger, records } connection tuples ({ serverId, cid, userNkey }); refusing a malformed or wider query");
  const dir = join(findCotalRoot(), ".cotal");
  const obsPath = join(dir, "membership-observer.creds");
  const cfgPath = join(dir, "membership.json");
  if (!existsSync(obsPath))
    throw new Error(
      "planeConnLiveness: the $SYS observer creds are not provisioned here (a space created before live observation); mint them with `cotal down` then `cotal up --rotate-sys`",
    );
  if (!existsSync(cfgPath)) throw new Error(`planeConnLiveness: ${cfgPath} is missing, so the account to scan is unknown`);
  const accountId = (JSON.parse(readFileSync(cfgPath, "utf8")) as { accountId?: string }).accountId;
  if (!accountId) throw new Error("planeConnLiveness: .cotal/membership.json has no accountId");
  return observePlaneLivenessWithCreds({
    servers: server,
    observerCreds: readFileSync(obsPath, "utf8"),
    accountId,
    query: { ledger: q.ledger, records: q.records },
  });
}

/**
 * The delivery daemon's FREEZE-HOLDER LIVENESS probe (#391, on the privileged delivery-admin rail):
 * answer whether ONE principal still holds a live connection, via the $SYS CONNZ observer cred
 * (opened per call; READ-ONLY — the KICK evictor cred never enters this path, and is not even read
 * from disk here).
 *
 * This is the READ half of {@link executeEviction}, and it exists because the write half cannot
 * serve as its own precheck: a repair that must REFUSE while the holder is alive would, using
 * `evictPrincipal` to find out, kill the holder before it could refuse. Same observer cred, same
 * sweep, same refusal posture as the plane oracle — a space provisioned before the observer existed
 * refuses with the regeneration step, and the caller treats that refusal as UNKNOWN and never
 * repairs over it (fail-closed).
 */
export async function executePrincipalLiveness(server: string, principal: unknown): Promise<PrincipalLivenessResult> {
  // Same fail-closed principal boundary the eviction filter applies, for the same reason: CONNZ
  // attribution only ever surfaces `local` / derived `u_…` owners, so a syntactically-valid
  // non-principal would sweep completely, match nothing, and read as a healthy `gone` — false
  // confidence for a typo'd or old-shape holder, on the exact verdict that authorizes the repair.
  if (typeof principal !== "string" || principal.trim().length === 0)
    throw new Error("principalLiveness: a principal (owner.actor dot-form) is required");
  const target = principal.trim();
  const parsed = parsePrincipalKey(target);
  if (!parsed || !isPrincipalOwnerToken(parsed.owner))
    throw new Error(`principalLiveness: "${target}" is not a real owner.actor principal (owner must be \`local\` or a derived \`u_…\` token — the only shapes CONNZ attribution can surface)`);
  const dir = join(findCotalRoot(), ".cotal");
  const obsPath = join(dir, "membership-observer.creds");
  const cfgPath = join(dir, "membership.json");
  if (!existsSync(obsPath))
    throw new Error(
      "principalLiveness: the $SYS observer creds are not provisioned here (a space created before live observation); mint them with `cotal down` then `cotal up --rotate-sys`",
    );
  if (!existsSync(cfgPath)) throw new Error(`principalLiveness: ${cfgPath} is missing, so the account to scan is unknown`);
  const accountId = (JSON.parse(readFileSync(cfgPath, "utf8")) as { accountId?: string }).accountId;
  if (!accountId) throw new Error("principalLiveness: .cotal/membership.json has no accountId");
  return observePrincipalLivenessWithCreds({
    servers: server,
    observerCreds: readFileSync(obsPath, "utf8"),
    accountId,
    principal: target,
  });
}
