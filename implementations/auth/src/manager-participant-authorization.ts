import {
  EpEnvelopeError,
  assertDerivedOwnerToken,
  assertLifecycleToken,
  assertValidOwnerToken,
  parseRemoteManagerEnvelope,
  type RemoteManagerParticipantAuthorizationRequest,
  type RemoteManagerParticipantAuthorizationResult,
} from "@cotal-ai/core";
import { DelegationEnvelopeRefusal, assertWithinSpawnerGrant, findActorUnified, managedParentHoldsRun, type ActorRow } from "./ledger.js";
import type { ObserveManagerGate } from "./managed-agent-enrollment.js";
import { requireCurrentServeTimeManager } from "./manager-admin-authorization.js";

const WHAT = "manager participant authorization";
const bad = (message: string): never => { throw new EpEnvelopeError("bad-request", `${WHAT} request ${message}`); };

export function parseRemoteManagerParticipantAuthorizationRequest(raw: unknown): RemoteManagerParticipantAuthorizationRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) bad("must be an object");
  const o = raw as Record<string, unknown>;
  const fields = ["v", "kind", "space", "actor", "instanceId", "managerLifecycleUid", "requestId", "registrationProof", "serveEpoch", "identities", "participant"];
  for (const key of Object.keys(o)) if (!fields.includes(key)) bad(`carries unknown field ${JSON.stringify(key)} (the protocol is closed)`);
  const envelope = parseRemoteManagerEnvelope(o, "manager-participant-authorization", WHAT);
  if (typeof o.serveEpoch !== "number" || !Number.isSafeInteger(o.serveEpoch) || o.serveEpoch < 0) bad("serveEpoch must be a non-negative safe integer");
  if (o.participant === null || typeof o.participant !== "object" || Array.isArray(o.participant)) bad("requires participant");
  const participant = o.participant as Record<string, unknown>;
  if (Object.keys(participant).sort().join(",") !== "actor,lifecycleUid,owner") bad("participant must contain exactly owner, actor, lifecycleUid");
  for (const key of ["owner", "actor", "lifecycleUid"] as const)
    if (typeof participant[key] !== "string" || participant[key].length === 0) bad(`requires non-empty participant.${key}`);
  assertDerivedOwnerToken(participant.owner as string);
  assertValidOwnerToken(participant.actor as string);
  assertLifecycleToken(participant.lifecycleUid as string, `${WHAT} participant lifecycleUid`);
  return {
    v: 1, kind: "manager-participant-authorization", ...envelope, serveEpoch: o.serveEpoch as number,
    participant: { owner: participant.owner as string, actor: participant.actor as string, lifecycleUid: participant.lifecycleUid as string },
  };
}

/** The ledger's own delegation walk, with its clean refusals read as `false`. A corrupt or cyclic
 *  chain still throws. */
function withinDelegationEnvelope(dir: string, row: ActorRow): boolean {
  try {
    assertWithinSpawnerGrant(dir, row, "exchange");
    return true;
  } catch (e) {
    if (e instanceof DelegationEnvelopeRefusal) return false;
    throw e;
  }
}

/** Human holders only: the platform control door does not carry this kind. */
export async function authorizeRemoteManagerParticipant(args: {
  request: RemoteManagerParticipantAuthorizationRequest;
  space: string;
  managerOwner: string;
  managerScope: string[];
  proofSecret: string | Uint8Array;
  dir: string;
  observeManagerGate: ObserveManagerGate;
}): Promise<RemoteManagerParticipantAuthorizationResult> {
  const request = parseRemoteManagerParticipantAuthorizationRequest(args.request);
  await requireCurrentServeTimeManager(args, request, WHAT);

  // A current manager gets one non-oracular decision from rows read fresh for this call. Absence,
  // revocation, lifecycle drift, managed custody, a missing `run`, and a revoked or narrowed ancestor
  // are all `false`. A row or chain the ledger cannot read is `unavailable`, never `false`.
  const { participant } = request;
  let authorized = false;
  if (participant.owner === args.managerOwner) {
    try {
      const row = findActorUnified(args.dir, participant.owner, participant.actor);
      authorized = row?.kind === "managed-agent" && row.lifecycleUid === participant.lifecycleUid
        && row.custody?.kind === "foreground" && row.scope.includes("run")
        && withinDelegationEnvelope(args.dir, row) && managedParentHoldsRun(args.dir, row);
    } catch (e) {
      throw new EpEnvelopeError("unavailable", `${WHAT} cannot read the participant's current authority: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { ...request, owner: args.managerOwner, authorized };
}
