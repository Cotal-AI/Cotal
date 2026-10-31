import {
  EpEnvelopeError,
  assertDerivedOwnerToken,
  assertLifecycleToken,
  assertValidOwnerToken,
  parseRemoteManagerEnvelope,
  type RemoteManagerParticipationAuthorizationRequest,
  type RemoteManagerParticipationAuthorizationResult,
} from "@cotal-ai/core";
import { findActorUnified } from "./ledger.js";
import type { ObserveManagerGate } from "./managed-agent-enrollment.js";
import { requireCurrentServeTimeManager } from "./manager-admin-authorization.js";

const WHAT = "manager participation authorization";
const bad = (message: string): never => { throw new EpEnvelopeError("bad-request", `${WHAT} request ${message}`); };

export function parseRemoteManagerParticipationAuthorizationRequest(raw: unknown): RemoteManagerParticipationAuthorizationRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) bad("must be an object");
  const o = raw as Record<string, unknown>;
  const allowed = new Set(["v", "kind", "space", "actor", "instanceId", "managerLifecycleUid", "requestId", "registrationProof", "serveEpoch", "identities", "caller"]);
  for (const key of Object.keys(o)) if (!allowed.has(key)) bad(`carries unknown field ${JSON.stringify(key)} (the protocol is closed)`);
  const envelope = parseRemoteManagerEnvelope(o, "manager-participation-authorization", WHAT);
  if (typeof o.serveEpoch !== "number" || !Number.isSafeInteger(o.serveEpoch) || o.serveEpoch < 0) bad("serveEpoch must be a non-negative safe integer");
  const exact = (value: unknown, keys: string[], field: string): Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) bad(`${field} must contain exactly ${keys.join(", ")}`);
    return value as Record<string, unknown>;
  };
  const caller = exact(o.caller, ["owner", "actor", "lifecycleUid"], "caller");
  for (const key of ["owner", "actor", "lifecycleUid"] as const) if (typeof caller[key] !== "string" || caller[key].length === 0) bad(`requires non-empty caller.${key}`);
  return { v: 1, kind: "manager-participation-authorization", ...envelope, serveEpoch: o.serveEpoch as number,
    caller: { owner: assertDerivedOwnerToken(caller.owner as string), actor: assertValidOwnerToken(caller.actor as string), lifecycleUid: assertLifecycleToken(caller.lifecycleUid as string, `${WHAT} caller lifecycleUid`) } };
}

export async function authorizeRemoteManagerParticipation(args: {
  request: RemoteManagerParticipationAuthorizationRequest;
  space: string;
  managerOwner: string;
  managerScope: string[];
  proofSecret: string | Uint8Array;
  dir: string;
  observeManagerGate: ObserveManagerGate;
  readLifecycle: (owner: string, actor: string) => Promise<{ mapping: { lifecycleUid: string; state: string } } | undefined>;
}): Promise<RemoteManagerParticipationAuthorizationResult> {
  const request = parseRemoteManagerParticipationAuthorizationRequest(args.request);
  await requireCurrentServeTimeManager(args, request, WHAT);
  let authorized = false;
  if (request.caller.owner === args.managerOwner) {
    try {
      const row = findActorUnified(args.dir, request.caller.owner, request.caller.actor);
      const lifecycle = await args.readLifecycle(request.caller.owner, request.caller.actor);
      authorized = request.caller.actor.startsWith("pa_") && row?.kind === "managed-agent" &&
        row.lifecycleUid === request.caller.lifecycleUid && row.custody?.kind === "foreground" &&
        row.scope.includes("run") && lifecycle?.mapping.state === "active" &&
        lifecycle.mapping.lifecycleUid === request.caller.lifecycleUid;
    } catch (error) {
      if (error instanceof EpEnvelopeError && (error.code === "permission-denied" || error.code === "failed-precondition")) authorized = false;
      else throw new EpEnvelopeError("unavailable", `${WHAT} cannot read current caller authority: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ...request, owner: args.managerOwner, authorized };
}
