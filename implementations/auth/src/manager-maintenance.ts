import {
  EpEnvelopeError,
  assertLifecycleToken,
  assertValidOwnerToken,
  epcredFamilyPrefix,
  parseLedgerRow,
  remoteManagerActors,
  type RemoteManagerMaintenanceRequest,
  type RemoteManagerMaintenanceResult,
} from "@cotal-ai/core";
import type { AuthLedgerScanner } from "./ledger-scanner.js";

const identityNames = ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"] as const;

function requestError(what: string): never {
  throw new EpEnvelopeError("bad-request", `manager-service maintenance request ${what}`);
}

export function parseRemoteManagerMaintenanceRequest(raw: unknown): RemoteManagerMaintenanceRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) requestError("must be an object");
  const o = raw as Record<string, unknown>;
  const allowed = new Set([
    "v", "kind", "operation", "space", "actor", "instanceId", "managerLifecycleUid",
    "requestId", "identities", "targetInstanceId", "principal",
  ]);
  for (const key of Object.keys(o)) if (!allowed.has(key)) requestError(`carries unknown field ${JSON.stringify(key)} (the protocol is closed)`);
  if (o.v !== 1 || o.kind !== "manager-service-maintenance")
    requestError('must carry { v: 1, kind: "manager-service-maintenance" }');
  if (o.operation !== "evict-family-principal" && o.operation !== "reconcile-registration")
    requestError('operation must be "evict-family-principal" or "reconcile-registration"');
  for (const key of ["space", "actor", "instanceId", "managerLifecycleUid", "requestId", "targetInstanceId"] as const)
    if (typeof o[key] !== "string" || o[key].length === 0) requestError(`requires non-empty ${key}`);
  assertValidOwnerToken(o.actor as string);
  assertLifecycleToken(o.instanceId as string, "manager maintenance instanceId");
  assertLifecycleToken(o.managerLifecycleUid as string, "manager maintenance lifecycleUid");
  assertLifecycleToken(o.targetInstanceId as string, "manager maintenance targetInstanceId");
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(o.requestId as string)) requestError("requestId must be a 22-64 character idempotency token");
  if (o.operation === "evict-family-principal") {
    if (typeof o.principal !== "string" || o.principal.length === 0) requestError("evict-family-principal requires principal");
  } else if (o.principal !== undefined) requestError("reconcile-registration must not carry principal");
  const ids = o.identities;
  if (ids === null || typeof ids !== "object" || Array.isArray(ids)) requestError("requires identities");
  const idObj = ids as Record<string, unknown>;
  if (Object.keys(idObj).sort().join(",") !== [...identityNames].sort().join(","))
    requestError(`identities must contain exactly ${identityNames.join(", ")}`);
  const identities = {} as RemoteManagerMaintenanceRequest["identities"];
  for (const name of identityNames) {
    const item = idObj[name];
    if (item === null || typeof item !== "object" || Array.isArray(item) || Object.keys(item as object).join(",") !== "id")
      requestError(`identities.${name} must be exactly { id }`);
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || !/^U[A-Z2-7]{55}$/.test(id)) requestError(`identities.${name}.id must be a user nkey`);
    identities[name] = { id };
  }
  return {
    v: 1,
    kind: "manager-service-maintenance",
    operation: o.operation,
    space: o.space as string,
    actor: o.actor as string,
    instanceId: o.instanceId as string,
    managerLifecycleUid: o.managerLifecycleUid as string,
    requestId: o.requestId as string,
    identities,
    targetInstanceId: o.targetInstanceId as string,
    ...(typeof o.principal === "string" ? { principal: o.principal } : {}),
  };
}

export async function authorizeRemoteManagerMaintenance(args: {
  request: RemoteManagerMaintenanceRequest;
  space: string;
  owner: string;
  scope: string[];
  observeManagerGate(instanceId: string): Promise<{
    state: "open" | "frozen" | "retired";
    principal: string;
    processEpoch: number;
    registrationRevision: number;
  } | null>;
  scanner: AuthLedgerScanner;
}): Promise<RemoteManagerMaintenanceRequest> {
  const r = parseRemoteManagerMaintenanceRequest(args.request);
  if (r.space !== args.space)
    throw new EpEnvelopeError("permission-denied", `manager maintenance request names space ${r.space}, not this host space ${args.space}`);
  if (!args.scope.includes("supervise"))
    throw new EpEnvelopeError("permission-denied", 'manager maintenance needs scope "supervise"; spawn/admin do not imply it');
  if (r.operation === "evict-family-principal" && r.targetInstanceId !== r.instanceId)
    throw new EpEnvelopeError("permission-denied", `manager maintenance eviction may target only caller instance ${r.instanceId}, not ${r.targetInstanceId}`);
  const gate = await args.observeManagerGate(r.targetInstanceId);
  if (!gate || gate.state === "retired")
    throw new EpEnvelopeError("failed-precondition", `manager maintenance found no live registration gate for instance ${r.targetInstanceId}`);
  if (r.operation === "evict-family-principal") {
    const servePrincipal = `${args.owner}.${remoteManagerActors(r.instanceId).serve}`;
    if (gate.principal !== servePrincipal)
      throw new EpEnvelopeError("permission-denied", `manager maintenance gate belongs to ${gate.principal}, not the caller's server-derived serve principal ${servePrincipal}`);
  }
  if (r.operation === "evict-family-principal") {
    const prefix = `${epcredFamilyPrefix("manager", r.targetInstanceId)}.`;
    const holders = new Set<string>();
    for (const entry of await args.scanner.scanEndpointCredentialFamily("manager", r.targetInstanceId)) {
      if (entry.op && entry.op !== "PUT")
        throw new EpEnvelopeError("failed-precondition", `manager maintenance found a ${entry.op} marker in the never-delete credential family at ${entry.key}`);
      holders.add(parseLedgerRow(entry.data, entry.key).holderPrincipal);
      if (!entry.key.startsWith(prefix))
        throw new EpEnvelopeError("internal", `the sealed manager-family scan returned foreign key ${entry.key}`);
    }
    if (!holders.has(r.principal!))
      throw new EpEnvelopeError("permission-denied", `manager maintenance may evict only a holder enumerated in ${epcredFamilyPrefix("manager", r.targetInstanceId)}; ${r.principal} is outside that family`);
  }
  return r;
}

export function completeRemoteManagerMaintenance(
  request: RemoteManagerMaintenanceRequest,
  owner: string,
  result: Pick<RemoteManagerMaintenanceResult, "eviction" | "reconciliation">,
): RemoteManagerMaintenanceResult {
  return { ...request, owner, ...result };
}
