import {
  EpEnvelopeError,
  assertDerivedOwnerToken,
  assertPrincipalOwnerToken,
  assertLifecycleToken,
  assertValidOwnerToken,
  remoteManagerActors,
  parseRemoteManagerEnvelope,
  type RemoteManagerAdminAuthorizationRequest,
  type RemoteManagerAdminAuthorizationResult,
  type PlatformControlAssignment,
} from "@cotal-ai/core";
import { timingSafeEqual } from "node:crypto";
import { findActorUnified } from "./ledger.js";
import type { ObserveManagerGate } from "./managed-agent-enrollment.js";
import { requireManagerAuthorityHolder } from "./platform-control.js";
import { remoteManagerCurrentRegistrationProof } from "./retained-manager-validation.js";

const bad = (message: string): never => { throw new EpEnvelopeError("bad-request", `manager admin authorization request ${message}`); };

/** `allowPlatform` admits a platform `p_…` caller owner, for the platform control holder only
 * (SPEC 13.1), so its admin check answers the same non-oracular decision as any other caller. */
export function parseRemoteManagerAdminAuthorizationRequest(raw: unknown, opts: { allowPlatform?: boolean } = {}): RemoteManagerAdminAuthorizationRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) bad("must be an object");
  const o = raw as Record<string, unknown>;
  const fields = ["v", "kind", "space", "actor", "instanceId", "managerLifecycleUid", "requestId", "registrationProof", "serveEpoch", "identities", "caller"];
  for (const key of Object.keys(o)) if (!fields.includes(key)) bad(`carries unknown field ${JSON.stringify(key)} (the protocol is closed)`);
  const envelope = parseRemoteManagerEnvelope(o, "manager-admin-authorization", bad);
  if (typeof o.serveEpoch !== "number" || !Number.isSafeInteger(o.serveEpoch) || o.serveEpoch < 0) bad("serveEpoch must be a non-negative safe integer");
  if (o.caller === null || typeof o.caller !== "object" || Array.isArray(o.caller)) bad("requires caller");
  const caller = o.caller as Record<string, unknown>;
  if (Object.keys(caller).sort().join(",") !== "actor,lifecycleUid,owner") bad("caller must contain exactly owner, actor, lifecycleUid");
  for (const key of ["owner", "actor", "lifecycleUid"] as const)
    if (typeof caller[key] !== "string" || caller[key].length === 0) bad(`requires non-empty caller.${key}`);
  if (opts.allowPlatform) assertPrincipalOwnerToken(caller.owner as string, { allowPlatform: true });
  else assertDerivedOwnerToken(caller.owner as string);
  assertValidOwnerToken(caller.actor as string);
  assertLifecycleToken(caller.lifecycleUid as string, "manager admin authorization caller lifecycleUid");
  return {
    v: 1, kind: "manager-admin-authorization", ...envelope, serveEpoch: o.serveEpoch as number,
    caller: { owner: caller.owner as string, actor: caller.actor as string, lifecycleUid: caller.lifecycleUid as string },
  };
}

export async function authorizeRemoteManagerAdmin(args: {
  request: RemoteManagerAdminAuthorizationRequest;
  space: string;
  managerOwner: string;
  proofSecret: string | Uint8Array;
  dir: string;
  observeManagerGate: ObserveManagerGate;
} & ({ managerScope: string[]; managerAssignment?: never } | { managerAssignment: PlatformControlAssignment; managerScope?: never })): Promise<RemoteManagerAdminAuthorizationResult> {
  const request = parseRemoteManagerAdminAuthorizationRequest(args.request, { allowPlatform: args.managerAssignment !== undefined });
  if (request.space !== args.space) throw new EpEnvelopeError("permission-denied", `manager admin authorization names space ${request.space}, not this host space ${args.space}`);
  requireManagerAuthorityHolder(
    args.managerAssignment !== undefined
      ? { holder: "platform", owner: args.managerOwner, assignment: args.managerAssignment }
      : { owner: args.managerOwner, scope: args.managerScope ?? [] },
    request.instanceId,
    'manager admin authorization needs manager scope "supervise"',
  );
  const actors = remoteManagerActors(request.instanceId);
  const gate = await args.observeManagerGate(request.instanceId);
  if (!gate || gate.state !== "open") throw new EpEnvelopeError("failed-precondition", `manager admin authorization found no current open manager gate for instance ${request.instanceId}`);
  const expectedPrincipal = `${args.managerOwner}.${actors.serve}`;
  if (gate.principal !== expectedPrincipal) throw new EpEnvelopeError("permission-denied", `manager admin authorization gate belongs to ${gate.principal}, not ${expectedPrincipal}`);
  if (gate.processEpoch !== request.serveEpoch) throw new EpEnvelopeError("conflict", `manager admin authorization serve epoch ${request.serveEpoch} is stale; current is ${gate.processEpoch}`);
  const proof = remoteManagerCurrentRegistrationProof(args.proofSecret, args.managerOwner, request, gate);
  if (!timingSafeEqual(Buffer.from(request.registrationProof), Buffer.from(proof)))
    throw new EpEnvelopeError("permission-denied", "manager admin authorization proof does not match the current host registration");

  // A valid current-manager request gets one non-oracular decision. The authoritative unified row is
  // read fresh for every call. Absence, revocation, a narrowed scope, owner drift, and lifecycle drift
  // are all the same `false`; corrupt/unreadable state throws and therefore fails the operation closed.
  // The ledger holds rows for derived owners only, so a platform owner's caller is that same absence.
  let authorized = false;
  if (request.caller.owner === args.managerOwner && args.managerAssignment === undefined) {
    const row = findActorUnified(args.dir, request.caller.owner, request.caller.actor);
    authorized = row?.lifecycleUid === request.caller.lifecycleUid && row.scope.includes("admin");
  }
  return { ...request, owner: args.managerOwner, authorized };
}
