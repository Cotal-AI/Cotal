import {
  EpEnvelopeError,
  assertDerivedOwnerToken,
  assertLifecycleToken,
  assertValidOwnerToken,
  remoteManagerActors,
  type RemoteManagerAdminAuthorizationRequest,
  type RemoteManagerAdminAuthorizationResult,
} from "@cotal-ai/core";
import { timingSafeEqual } from "node:crypto";
import { findActorUnified } from "./ledger.js";
import { remoteManagerCurrentRegistrationProof } from "./retained-manager-validation.js";

const identityNames = ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"] as const;
const bad = (message: string): never => { throw new EpEnvelopeError("bad-request", `manager admin authorization request ${message}`); };

export function parseRemoteManagerAdminAuthorizationRequest(raw: unknown): RemoteManagerAdminAuthorizationRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) bad("must be an object");
  const o = raw as Record<string, unknown>;
  const fields = ["v", "kind", "space", "actor", "instanceId", "managerLifecycleUid", "requestId", "registrationProof", "serveEpoch", "identities", "caller"];
  for (const key of Object.keys(o)) if (!fields.includes(key)) bad(`carries unknown field ${JSON.stringify(key)} (the protocol is closed)`);
  if (o.v !== 1 || o.kind !== "manager-admin-authorization") bad('must carry { v: 1, kind: "manager-admin-authorization" }');
  for (const key of ["space", "actor", "instanceId", "managerLifecycleUid", "requestId", "registrationProof"] as const)
    if (typeof o[key] !== "string" || o[key].length === 0) bad(`requires non-empty ${key}`);
  assertValidOwnerToken(o.actor as string);
  assertLifecycleToken(o.instanceId as string, "manager admin authorization instanceId");
  assertLifecycleToken(o.managerLifecycleUid as string, "manager admin authorization lifecycleUid");
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(o.requestId as string)) bad("requestId must be a 22-64 character idempotency token");
  if (!/^sha256:[0-9a-f]{64}$/.test(o.registrationProof as string)) bad("requires a sha256 registrationProof");
  if (typeof o.serveEpoch !== "number" || !Number.isSafeInteger(o.serveEpoch) || o.serveEpoch < 0) bad("serveEpoch must be a non-negative safe integer");
  if (o.identities === null || typeof o.identities !== "object" || Array.isArray(o.identities)) bad("requires identities");
  const rawIds = o.identities as Record<string, unknown>;
  if (Object.keys(rawIds).sort().join(",") !== [...identityNames].sort().join(",")) bad(`identities must contain exactly ${identityNames.join(", ")}`);
  const identities = {} as RemoteManagerAdminAuthorizationRequest["identities"];
  for (const name of identityNames) {
    const item = rawIds[name];
    if (item === null || typeof item !== "object" || Array.isArray(item) || Object.keys(item as object).join(",") !== "id") bad(`identities.${name} must be exactly { id }`);
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || !/^U[A-Z2-7]{55}$/.test(id)) bad(`identities.${name}.id must be a user nkey`);
    identities[name] = { id: id as string };
  }
  if (o.caller === null || typeof o.caller !== "object" || Array.isArray(o.caller)) bad("requires caller");
  const caller = o.caller as Record<string, unknown>;
  if (Object.keys(caller).sort().join(",") !== "actor,lifecycleUid,owner") bad("caller must contain exactly owner, actor, lifecycleUid");
  for (const key of ["owner", "actor", "lifecycleUid"] as const)
    if (typeof caller[key] !== "string" || caller[key].length === 0) bad(`requires non-empty caller.${key}`);
  assertDerivedOwnerToken(caller.owner as string);
  assertValidOwnerToken(caller.actor as string);
  assertLifecycleToken(caller.lifecycleUid as string, "manager admin authorization caller lifecycleUid");
  return {
    v: 1, kind: "manager-admin-authorization", space: o.space as string, actor: o.actor as string,
    instanceId: o.instanceId as string, managerLifecycleUid: o.managerLifecycleUid as string,
    requestId: o.requestId as string, registrationProof: o.registrationProof as string,
    serveEpoch: o.serveEpoch as number, identities,
    caller: { owner: caller.owner as string, actor: caller.actor as string, lifecycleUid: caller.lifecycleUid as string },
  };
}

export async function authorizeRemoteManagerAdmin(args: {
  request: RemoteManagerAdminAuthorizationRequest;
  space: string;
  managerOwner: string;
  managerScope: string[];
  proofSecret: string | Uint8Array;
  dir: string;
  observeManagerGate: (instanceId: string) => Promise<{
    state: "open" | "frozen" | "retired"; principal: string; processEpoch: number; registrationRevision: number;
  } | null>;
}): Promise<RemoteManagerAdminAuthorizationResult> {
  const request = parseRemoteManagerAdminAuthorizationRequest(args.request);
  if (request.space !== args.space) throw new EpEnvelopeError("permission-denied", `manager admin authorization names space ${request.space}, not this host space ${args.space}`);
  if (!args.managerScope.includes("supervise")) throw new EpEnvelopeError("permission-denied", 'manager admin authorization needs manager scope "supervise"');
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
  let authorized = false;
  if (request.caller.owner === args.managerOwner) {
    const row = findActorUnified(args.dir, request.caller.owner, request.caller.actor);
    authorized = row?.lifecycleUid === request.caller.lifecycleUid && row.scope.includes("admin");
  }
  return { ...request, owner: args.managerOwner, authorized };
}
