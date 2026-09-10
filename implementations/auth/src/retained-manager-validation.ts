import {
  EpEnvelopeError,
  assertDerivedOwnerToken,
  assertLifecycleToken,
  assertValidOwnerToken,
  remoteManagerActors,
  type RemoteRetainedAgentValidationRequest,
  type RemoteRetainedAgentValidationResult,
  type RetainedAgentAuthority,
} from "@cotal-ai/core";
import { createHmac, timingSafeEqual } from "node:crypto";

const identityNames = ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"] as const;

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

/** Parse the secret-bearing retained-validation request without retaining unknown input fields. */
export function parseRemoteRetainedAgentValidationRequest(raw: unknown): RemoteRetainedAgentValidationRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) requestError("must be an object");
  const o = raw as Record<string, unknown>;
  const allowed = new Set([
    "v", "kind", "space", "actor", "instanceId", "managerLifecycleUid", "requestId",
    "registrationProof", "serveEpoch", "identities", "target", "actorToken", "sentinelCreds",
  ]);
  for (const key of Object.keys(o)) if (!allowed.has(key)) requestError(`carries unknown field ${JSON.stringify(key)} (the protocol is closed)`);
  if (o.v !== 1 || o.kind !== "manager-retained-agent-validation")
    requestError('must carry { v: 1, kind: "manager-retained-agent-validation" }');
  for (const key of ["space", "actor", "instanceId", "managerLifecycleUid", "requestId", "registrationProof", "actorToken", "sentinelCreds"] as const)
    if (typeof o[key] !== "string" || o[key].length === 0) requestError(`requires non-empty ${key}`);
  if ((o.actorToken as string).length > 4096 || (o.sentinelCreds as string).length > 16 * 1024)
    requestError("secret material exceeds its bounded wire size");
  assertValidOwnerToken(o.actor as string);
  assertLifecycleToken(o.instanceId as string, "manager retained validation instanceId");
  assertLifecycleToken(o.managerLifecycleUid as string, "manager retained validation lifecycleUid");
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(o.requestId as string)) requestError("requestId must be a 22-64 character idempotency token");
  if (!/^sha256:[0-9a-f]{64}$/.test(o.registrationProof as string)) requestError("requires a sha256 registrationProof");
  if (typeof o.serveEpoch !== "number" || !Number.isSafeInteger(o.serveEpoch) || o.serveEpoch < 0)
    requestError("serveEpoch must be a non-negative safe integer");

  const ids = o.identities;
  if (ids === null || typeof ids !== "object" || Array.isArray(ids)) requestError("requires identities");
  const idObj = ids as Record<string, unknown>;
  if (Object.keys(idObj).sort().join(",") !== [...identityNames].sort().join(","))
    requestError(`identities must contain exactly ${identityNames.join(", ")}`);
  const identities = {} as RemoteRetainedAgentValidationRequest["identities"];
  for (const name of identityNames) {
    const item = idObj[name];
    if (item === null || typeof item !== "object" || Array.isArray(item) || Object.keys(item as object).join(",") !== "id")
      requestError(`identities.${name} must be exactly { id }`);
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || !/^U[A-Z2-7]{55}$/.test(id)) requestError(`identities.${name}.id must be a user nkey`);
    identities[name] = { id };
  }

  const target = o.target;
  if (target === null || typeof target !== "object" || Array.isArray(target) ||
      Object.keys(target as object).sort().join(",") !== "actor,lifecycleUid,owner")
    requestError("target must be exactly { owner, actor, lifecycleUid }");
  const t = target as Record<string, unknown>;
  if (typeof t.owner !== "string" || typeof t.actor !== "string" || typeof t.lifecycleUid !== "string")
    requestError("target must contain string owner, actor, and lifecycleUid");
  const parsedTarget = {
    owner: assertDerivedOwnerToken(t.owner),
    actor: assertValidOwnerToken(t.actor),
    lifecycleUid: assertLifecycleToken(t.lifecycleUid, "manager retained validation target lifecycleUid"),
  };

  return {
    v: 1,
    kind: "manager-retained-agent-validation",
    space: o.space as string,
    actor: o.actor as string,
    instanceId: o.instanceId as string,
    managerLifecycleUid: o.managerLifecycleUid as string,
    requestId: o.requestId as string,
    registrationProof: o.registrationProof as string,
    serveEpoch: o.serveEpoch,
    identities,
    target: parsedTarget,
    actorToken: o.actorToken as string,
    sentinelCreds: o.sentinelCreds as string,
  };
}

export interface AuthorizeRemoteRetainedAgentValidationArgs {
  request: RemoteRetainedAgentValidationRequest;
  space: string;
  owner: string;
  scope: string[];
  proofSecret: string | Uint8Array;
  observeManagerGate: (instanceId: string) => Promise<{
    state: "open" | "frozen" | "retired";
    principal: string;
    processEpoch: number;
    registrationRevision: number;
  } | null>;
}

/** Host policy authorizing one fresh, non-minting retained-agent continuity validation. */
export async function authorizeRemoteRetainedAgentValidation(
  args: AuthorizeRemoteRetainedAgentValidationArgs,
): Promise<RemoteRetainedAgentValidationRequest> {
  const r = parseRemoteRetainedAgentValidationRequest(args.request);
  if (r.space !== args.space)
    throw new EpEnvelopeError("permission-denied", `manager retained-agent validation request names space ${r.space}, not this host space ${args.space}`);
  if (!args.scope.includes("supervise"))
    throw new EpEnvelopeError("permission-denied", 'manager retained-agent validation needs scope "supervise"; spawn/admin do not imply it');
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
