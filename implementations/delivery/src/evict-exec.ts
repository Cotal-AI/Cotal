import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  evictDeniedPrincipalWithCreds,
  isPlaneConnTuple,
  isPrincipalOwnerToken,
  observePlaneLivenessWithCreds,
  parsePrincipalKey,
  type EvictionResult,
  type PlaneLivenessQuery,
  type PlaneLivenessResult,
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
  if (!existsSync(obsPath) || !existsSync(evPath) || !existsSync(cfgPath))
    throw new Error(
      "evictPrincipal: the $SYS observer/evictor creds are not provisioned here (a space created before live eviction) — regenerate the space auth (`cotal down` + fresh `cotal up`); until then removal is deny-new-only (durable reauth)",
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
  if (!existsSync(obsPath) || !existsSync(cfgPath))
    throw new Error(
      "planeConnLiveness: the $SYS observer creds are not provisioned here (a space created before live observation) — regenerate the space auth (`cotal down` + fresh `cotal up`)",
    );
  const accountId = (JSON.parse(readFileSync(cfgPath, "utf8")) as { accountId?: string }).accountId;
  if (!accountId) throw new Error("planeConnLiveness: .cotal/membership.json has no accountId");
  return observePlaneLivenessWithCreds({
    servers: server,
    observerCreds: readFileSync(obsPath, "utf8"),
    accountId,
    query: { ledger: q.ledger, records: q.records },
  });
}
