import {
  EpEnvelopeError,
  assertDerivedOwnerToken,
  assertLifecycleToken,
  assertPrincipalOwnerToken,
  assertValidOwnerToken,
  remoteManagerActors,
  parseRemoteManagerEnvelope,
  type RemoteRetainedAgentValidationRequest,
  type RemoteRetainedAgentValidationResult,
  type RetainedAgentAuthority,
} from "@cotal-ai/core";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ObserveManagerGate } from "./managed-agent-enrollment.js";
import { requireManagerAuthorityHolder, type ManagerAuthorityHolder } from "./platform-control.js";

/** Host-authenticated, stateless proof for one activated manager registration. The account signing
 * seed is already held by the host authority plane and never crosses this seam. */
export function remoteManagerCurrentRegistrationProof(
  secret: string | Uint8Array,
  owner: string,
  request: Pick<RemoteRetainedAgentValidationRequest, "space" | "actor" | "instanceId" | "managerLifecycleUid" | "identities">,
  current: { registrationRevision: number; processEpoch: number },
): string {
  const payload = JSON.stringify({
    v: 1,
    kind: "manager-current-registration",
    space: request.space,
    owner,
    actor: request.actor,
    instanceId: request.instanceId,
    lifecycleUid: request.managerLifecycleUid,
    actors: remoteManagerActors(request.instanceId),
    identities: request.identities,
    registrationRevision: current.registrationRevision,
    processEpoch: current.processEpoch,
  });
  return `sha256:${createHmac("sha256", secret).update("cotal/manager-current-registration/v1\0").update(payload).digest("hex")}`;
}

function requestError(what: string): never {
  throw new EpEnvelopeError("bad-request", `manager retained-agent validation request ${what}`);
}

/** Parse the secret-bearing retained-validation request without retaining unknown input fields.
 * `allowPlatform` admits a platform `p_…` target owner, for the platform control holder only
 * (SPEC 13.1); the holder's owner-equality check still decides whether that target is its own. */
export function parseRemoteRetainedAgentValidationRequest(raw: unknown, opts: { allowPlatform?: boolean } = {}): RemoteRetainedAgentValidationRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) requestError("must be an object");
  const o = raw as Record<string, unknown>;
  const allowed = new Set([
    "v", "kind", "space", "actor", "instanceId", "managerLifecycleUid", "requestId",
    "registrationProof", "serveEpoch", "identities", "target", "actorToken", "sentinelCreds",
  ]);
  for (const key of Object.keys(o)) if (!allowed.has(key)) requestError(`carries unknown field ${JSON.stringify(key)} (the protocol is closed)`);
  const envelope = parseRemoteManagerEnvelope(o, "manager-retained-agent-validation", "manager retained-agent validation");
  for (const key of ["actorToken", "sentinelCreds"] as const)
    if (typeof o[key] !== "string" || o[key].length === 0) requestError(`requires non-empty ${key}`);
  if ((o.actorToken as string).length > 4096 || (o.sentinelCreds as string).length > 16 * 1024)
    requestError("secret material exceeds its bounded wire size");
  if (typeof o.serveEpoch !== "number" || !Number.isSafeInteger(o.serveEpoch) || o.serveEpoch < 0)
    requestError("serveEpoch must be a non-negative safe integer");

  const target = o.target;
  if (target === null || typeof target !== "object" || Array.isArray(target) ||
      Object.keys(target as object).sort().join(",") !== "actor,lifecycleUid,owner")
    requestError("target must be exactly { owner, actor, lifecycleUid }");
  const t = target as Record<string, unknown>;
  if (typeof t.owner !== "string" || typeof t.actor !== "string" || typeof t.lifecycleUid !== "string")
    requestError("target must contain string owner, actor, and lifecycleUid");
  const parsedTarget = {
    owner: opts.allowPlatform ? assertPrincipalOwnerToken(t.owner, { allowPlatform: true }) : assertDerivedOwnerToken(t.owner),
    actor: assertValidOwnerToken(t.actor),
    lifecycleUid: assertLifecycleToken(t.lifecycleUid, "manager retained validation target lifecycleUid"),
  };

  return {
    v: 1,
    kind: "manager-retained-agent-validation",
    ...envelope,
    serveEpoch: o.serveEpoch,
    target: parsedTarget,
    actorToken: o.actorToken as string,
    sentinelCreds: o.sentinelCreds as string,
  };
}

export type AuthorizeRemoteRetainedAgentValidationArgs = ManagerAuthorityHolder & {
  request: RemoteRetainedAgentValidationRequest;
  space: string;
  proofSecret: string | Uint8Array;
  observeManagerGate: ObserveManagerGate;
};

/** Host policy authorizing one fresh, non-minting retained-agent continuity validation. */
export async function authorizeRemoteRetainedAgentValidation(
  args: AuthorizeRemoteRetainedAgentValidationArgs,
): Promise<RemoteRetainedAgentValidationRequest> {
  const r = parseRemoteRetainedAgentValidationRequest(args.request, { allowPlatform: args.holder === "platform" });
  if (r.space !== args.space)
    throw new EpEnvelopeError("permission-denied", `manager retained-agent validation request names space ${r.space}, not this host space ${args.space}`);
  requireManagerAuthorityHolder(args, r.instanceId, 'manager retained-agent validation needs scope "supervise"; spawn/admin do not imply it');
  if (r.target.owner !== args.owner)
    throw new EpEnvelopeError("permission-denied", `manager retained-agent validation may target only its authenticated owner ${args.owner}, not ${r.target.owner}`);
  const actors = remoteManagerActors(r.instanceId);
  const gate = await args.observeManagerGate(r.instanceId);
  if (!gate || gate.state !== "open")
    throw new EpEnvelopeError("failed-precondition", `manager retained-agent validation found no current open manager gate for instance ${r.instanceId}`);
  const servePrincipal = `${args.owner}.${actors.serve}`;
  if (gate.principal !== servePrincipal)
    throw new EpEnvelopeError("permission-denied", `manager retained-agent validation gate belongs to ${gate.principal}, not the server-derived serve principal ${servePrincipal}`);
  if (gate.processEpoch !== r.serveEpoch)
    throw new EpEnvelopeError("conflict", `manager retained-agent validation serve epoch ${r.serveEpoch} is stale; current is ${gate.processEpoch}`);
  const expectedProof = remoteManagerCurrentRegistrationProof(args.proofSecret, args.owner, r, gate);
  if (!timingSafeEqual(Buffer.from(r.registrationProof), Buffer.from(expectedProof)))
    throw new EpEnvelopeError("permission-denied", "manager retained-agent validation proof does not match the current host registration");

  return r;
}

/** Build the closed non-secret result after the fixed host provider validation succeeds. */
export function completeRemoteRetainedAgentValidation(
  r: RemoteRetainedAgentValidationRequest,
  owner: string,
  authority: RetainedAgentAuthority,
): RemoteRetainedAgentValidationResult {
  if (authority.owner !== r.target.owner || authority.actor !== r.target.actor || authority.lifecycleUid !== r.target.lifecycleUid)
    throw new EpEnvelopeError("conflict", "manager retained-agent validation host returned a replacement principal or lifecycle");
  return {
    v: 1,
    kind: "manager-retained-agent-validation",
    space: r.space,
    owner,
    actor: r.actor,
    instanceId: r.instanceId,
    managerLifecycleUid: r.managerLifecycleUid,
    requestId: r.requestId,
    registrationProof: r.registrationProof,
    serveEpoch: r.serveEpoch,
    target: r.target,
    authority,
  };
}
