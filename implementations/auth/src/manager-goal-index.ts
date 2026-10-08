import {
  EpEnvelopeError,
  parseRemoteManagerEnvelope,
  type GoalIndexEntry,
  type RemoteManagerGoalIndexScanRequest,
  type RemoteManagerGoalIndexScanResult,
} from "@cotal-ai/core";
import { assertCurrentManagerRegistration } from "./retained-manager-validation.js";
import { requireManagerAuthorityHolder, type ManagerAuthorityHolder } from "./platform-control.js";
import type { ObserveManagerGate } from "./managed-agent-enrollment.js";

const bad = (message: string): never => { throw new EpEnvelopeError("bad-request", `manager goal-index scan request ${message}`); };

export function parseRemoteManagerGoalIndexScanRequest(raw: unknown): RemoteManagerGoalIndexScanRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) bad("must be an object");
  const o = raw as Record<string, unknown>;
  const fields = ["v", "kind", "space", "actor", "instanceId", "managerLifecycleUid", "requestId", "registrationProof", "serveEpoch", "identities"];
  for (const key of Object.keys(o)) if (!fields.includes(key)) bad(`carries unknown field ${JSON.stringify(key)} (the protocol is closed)`);
  const envelope = parseRemoteManagerEnvelope(o, "manager-goal-index-scan", "manager goal-index scan");
  if (typeof o.serveEpoch !== "number" || !Number.isSafeInteger(o.serveEpoch) || o.serveEpoch < 0) bad("serveEpoch must be a non-negative safe integer");
  return { v: 1, kind: "manager-goal-index-scan", ...envelope, serveEpoch: o.serveEpoch as number };
}

export async function authorizeRemoteManagerGoalIndexScan(args: ManagerAuthorityHolder & {
  request: RemoteManagerGoalIndexScanRequest;
  space: string;
  proofSecret: string | Uint8Array;
  observeManagerGate: ObserveManagerGate;
}): Promise<RemoteManagerGoalIndexScanRequest> {
  const request = parseRemoteManagerGoalIndexScanRequest(args.request);
  if (request.space !== args.space) throw new EpEnvelopeError("permission-denied", `manager goal-index scan names space ${request.space}, not this host space ${args.space}`);
  requireManagerAuthorityHolder(args, request.instanceId, 'manager goal-index scan needs scope "supervise"');
  await assertCurrentManagerRegistration(request, request.serveEpoch, args, "manager goal-index scan");
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
