import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  evictDeniedPrincipalWithCreds,
  parsePrincipalKey,
  type EvictionResult,
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
  // but the FILTER must be a well-formed owner.actor key or a typo silently evicts nothing.
  if (!parsePrincipalKey(principal))
    throw new Error(`evictPrincipal: "${principal}" is not a valid owner.actor principal (dot-form)`);
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
