import {
  EVICT_PRINCIPALS_MAX,
  EpEnvelopeError,
  assertLifecycleToken,
  epcredFamilyPrefix,
  parseLedgerRow,
  parseRemoteManagerEnvelope,
  remoteManagerActors,
  type RemoteManagerMaintenanceRequest,
  type RemoteManagerMaintenanceResult,
} from "@cotal-ai/core";
import type { AuthLedgerScanner } from "./ledger-scanner.js";
import type { ObserveManagerGate } from "./managed-agent-enrollment.js";
import { requireManagerAuthorityHolder, type ManagerAuthorityHolder } from "./platform-control.js";

function requestError(what: string): never {
  throw new EpEnvelopeError("bad-request", `manager-service maintenance request ${what}`);
}

export function parseRemoteManagerMaintenanceRequest(raw: unknown): RemoteManagerMaintenanceRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) requestError("must be an object");
  const o = raw as Record<string, unknown>;
  const allowed = new Set([
    "v", "kind", "operation", "space", "actor", "instanceId", "managerLifecycleUid",
    "requestId", "identities", "targetInstanceId", "principals",
  ]);
  for (const key of Object.keys(o)) if (!allowed.has(key)) requestError(`carries unknown field ${JSON.stringify(key)} (the protocol is closed)`);
  if (o.operation !== "evict-family-principal" && o.operation !== "reconcile-registration")
    requestError('operation must be "evict-family-principal" or "reconcile-registration"');
  const envelope = parseRemoteManagerEnvelope(o, "manager-service-maintenance", "manager-service maintenance", false);
  if (typeof o.targetInstanceId !== "string" || o.targetInstanceId.length === 0) requestError("requires non-empty targetInstanceId");
  assertLifecycleToken(o.targetInstanceId, "manager-service maintenance targetInstanceId");
  if (o.operation === "evict-family-principal") {
    const p = o.principals;
    if (!Array.isArray(p) || p.length === 0 || p.length > EVICT_PRINCIPALS_MAX ||
        p.some((x) => typeof x !== "string" || x.length === 0) || new Set(p).size !== p.length)
      requestError(`evict-family-principal requires 1 to ${EVICT_PRINCIPALS_MAX} distinct non-empty principals`);
  } else if (o.principals !== undefined) requestError("reconcile-registration must not carry principals");
  return {
    v: 1,
    kind: "manager-service-maintenance",
    operation: o.operation,
    ...envelope,
    targetInstanceId: o.targetInstanceId,
    ...(Array.isArray(o.principals) ? { principals: [...(o.principals as string[])] } : {}),
  };
}

export async function authorizeRemoteManagerMaintenance(args: ManagerAuthorityHolder & {
  request: RemoteManagerMaintenanceRequest;
  space: string;
  observeManagerGate: ObserveManagerGate;
  scanner: AuthLedgerScanner;
}): Promise<RemoteManagerMaintenanceRequest> {
  const r = parseRemoteManagerMaintenanceRequest(args.request);
  if (r.space !== args.space)
    throw new EpEnvelopeError("permission-denied", `manager maintenance request names space ${r.space}, not this host space ${args.space}`);
  requireManagerAuthorityHolder(args, r.instanceId, 'manager maintenance needs scope "supervise"; spawn/admin do not imply it');
  // The platform arm reaches only its own assigned instance, for both operations. The human arm may
  // still reconcile a foreign slot holder in its space.
  if (args.holder === "platform" && r.targetInstanceId !== args.assignment.instanceId)
    throw new EpEnvelopeError("permission-denied", `platform control maintenance may target only assigned instance ${args.assignment.instanceId}, not ${r.targetInstanceId}`);
  if (r.operation === "evict-family-principal" && r.targetInstanceId !== r.instanceId)
    throw new EpEnvelopeError("permission-denied", `manager maintenance eviction may target only caller instance ${r.instanceId}, not ${r.targetInstanceId}`);
  const gate = await args.observeManagerGate(r.targetInstanceId);
  if (!gate || gate.state === "retired")
    throw new EpEnvelopeError("failed-precondition", `manager maintenance found no live registration gate for instance ${r.targetInstanceId}`);
  if (args.holder === "platform" && gate.principal !== `${args.owner}.${remoteManagerActors(r.targetInstanceId).serve}`)
    throw new EpEnvelopeError("permission-denied", `platform control maintenance gate belongs to ${gate.principal}, not the platform serve principal`);
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
    const outside = r.principals!.filter((p) => !holders.has(p));
    if (outside.length > 0)
      throw new EpEnvelopeError("permission-denied", `manager maintenance may evict only holders enumerated in ${epcredFamilyPrefix("manager", r.targetInstanceId)}; outside that family: ${outside.join(", ")}`);
  }
  return r;
}

export function completeRemoteManagerMaintenance(
  request: RemoteManagerMaintenanceRequest,
  owner: string,
  result: Pick<RemoteManagerMaintenanceResult, "evictions" | "reconciliation">,
): RemoteManagerMaintenanceResult {
  return { ...request, owner, ...result };
}
