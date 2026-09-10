import {
  EpEnvelopeError,
  assertLifecycleToken,
  assertValidOwnerToken,
  remoteManagerActors,
  type GoalIndexEntry,
  type RemoteManagerGoalIndexScanRequest,
  type RemoteManagerGoalIndexScanResult,
} from "@cotal-ai/core";
import { remoteManagerCurrentRegistrationProof } from "./retained-manager-validation.js";
import { timingSafeEqual } from "node:crypto";

const identityNames = ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"] as const;
const bad = (message: string): never => { throw new EpEnvelopeError("bad-request", `manager goal-index scan request ${message}`); };

export function parseRemoteManagerGoalIndexScanRequest(raw: unknown): RemoteManagerGoalIndexScanRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) bad("must be an object");
  const o = raw as Record<string, unknown>;
  const fields = ["v", "kind", "space", "actor", "instanceId", "managerLifecycleUid", "requestId", "registrationProof", "serveEpoch", "identities"];
  for (const key of Object.keys(o)) if (!fields.includes(key)) bad(`carries unknown field ${JSON.stringify(key)} (the protocol is closed)`);
  if (o.v !== 1 || o.kind !== "manager-goal-index-scan") bad('must carry { v: 1, kind: "manager-goal-index-scan" }');
  for (const key of ["space", "actor", "instanceId", "managerLifecycleUid", "requestId", "registrationProof"] as const)
    if (typeof o[key] !== "string" || o[key].length === 0) bad(`requires non-empty ${key}`);
  assertValidOwnerToken(o.actor as string);
  assertLifecycleToken(o.instanceId as string, "manager goal-index scan instanceId");
  assertLifecycleToken(o.managerLifecycleUid as string, "manager goal-index scan lifecycleUid");
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(o.requestId as string)) bad("requestId must be a 22-64 character idempotency token");
  if (!/^sha256:[0-9a-f]{64}$/.test(o.registrationProof as string)) bad("requires a sha256 registrationProof");
  if (typeof o.serveEpoch !== "number" || !Number.isSafeInteger(o.serveEpoch) || o.serveEpoch < 0) bad("serveEpoch must be a non-negative safe integer");
  if (o.identities === null || typeof o.identities !== "object" || Array.isArray(o.identities)) bad("requires identities");
  const rawIds = o.identities as Record<string, unknown>;
  if (Object.keys(rawIds).sort().join(",") !== [...identityNames].sort().join(",")) bad(`identities must contain exactly ${identityNames.join(", ")}`);
  const identities = {} as RemoteManagerGoalIndexScanRequest["identities"];
  for (const name of identityNames) {
    const item = rawIds[name];
    if (item === null || typeof item !== "object" || Array.isArray(item) || Object.keys(item as object).join(",") !== "id") bad(`identities.${name} must be exactly { id }`);
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || !/^U[A-Z2-7]{55}$/.test(id)) bad(`identities.${name}.id must be a user nkey`);
    identities[name] = { id: id as string };
  }
  return {
    v: 1, kind: "manager-goal-index-scan", space: o.space as string, actor: o.actor as string,
    instanceId: o.instanceId as string, managerLifecycleUid: o.managerLifecycleUid as string,
    requestId: o.requestId as string, registrationProof: o.registrationProof as string,
    serveEpoch: o.serveEpoch as number, identities,
  };
}

export async function authorizeRemoteManagerGoalIndexScan(args: {
  request: RemoteManagerGoalIndexScanRequest;
  space: string;
  owner: string;
  scope: string[];
  proofSecret: string | Uint8Array;
  observeManagerGate: (instanceId: string) => Promise<{
    state: "open" | "frozen" | "retired"; principal: string; processEpoch: number; registrationRevision: number;
  } | null>;
}): Promise<RemoteManagerGoalIndexScanRequest> {
  const request = parseRemoteManagerGoalIndexScanRequest(args.request);
  if (request.space !== args.space) throw new EpEnvelopeError("permission-denied", `manager goal-index scan names space ${request.space}, not this host space ${args.space}`);
  if (!args.scope.includes("supervise")) throw new EpEnvelopeError("permission-denied", 'manager goal-index scan needs scope "supervise"');
  const actors = remoteManagerActors(request.instanceId);
  const gate = await args.observeManagerGate(request.instanceId);
  if (!gate || gate.state !== "open") throw new EpEnvelopeError("failed-precondition", `manager goal-index scan found no current open manager gate for instance ${request.instanceId}`);
  const expectedPrincipal = `${args.owner}.${actors.serve}`;
  if (gate.principal !== expectedPrincipal) throw new EpEnvelopeError("permission-denied", `manager goal-index scan gate belongs to ${gate.principal}, not ${expectedPrincipal}`);
  if (gate.processEpoch !== request.serveEpoch) throw new EpEnvelopeError("conflict", `manager goal-index scan serve epoch ${request.serveEpoch} is stale; current is ${gate.processEpoch}`);
  const proof = remoteManagerCurrentRegistrationProof(args.proofSecret, args.owner, request, gate);
  if (!timingSafeEqual(Buffer.from(request.registrationProof), Buffer.from(proof)))
    throw new EpEnvelopeError("permission-denied", "manager goal-index scan proof does not match the current host registration");
  return request;
}

export function completeRemoteManagerGoalIndexScan(
  request: RemoteManagerGoalIndexScanRequest,
  owner: string,
  entries: GoalIndexEntry[],
): RemoteManagerGoalIndexScanResult {
  if (entries.some((entry) => entry.endpoint !== "manager" || entry.owner !== owner))
    throw new EpEnvelopeError("internal", "manager goal-index scanner returned a foreign endpoint or owner");
  return {
    v: 1, kind: "manager-goal-index-scan", space: request.space, owner, actor: request.actor,
    instanceId: request.instanceId, managerLifecycleUid: request.managerLifecycleUid,
    requestId: request.requestId, registrationProof: request.registrationProof,
    serveEpoch: request.serveEpoch, entries,
  };
}
