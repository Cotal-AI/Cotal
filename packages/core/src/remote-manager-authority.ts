import { rawDigest } from "./canonical.js";
import { assertLifecycleToken } from "./subjects.js";

/**
 * Closed request for one remote manager-service authority lifecycle.
 *
 * The caller chooses the opaque manager instance/lifecycle ids and generates the connection nkeys
 * locally. The host derives every actor from the instance id, fresh-checks `supervise`, binds every
 * issuance to this lifecycle, and returns host-signed JWTs only. No private seed, profile name,
 * permissions object, signer, or static trust material crosses this seam.
 */
export interface RemoteManagerAuthorityRequest {
  v: 1;
  kind: "manager-service-authority";
  operation: "prepare" | "activate" | "renew" | "session" | "retire";
  space: string;
  /** The interactive ledger actor authenticating the request (normally `cli`). */
  actor: string;
  instanceId: string;
  managerLifecycleUid: string;
  requestId: string;
  /** Activate/renew proves the registration phase that preceded it. The opaque digest is minted
   * and validated by the host; it never carries permissions itself. */
  registrationProof?: string;
  /** Session only: one fresh caller-generated serving nkey and the exact session coordinates. */
  session?: { id: string; endpoint: string; sessionId: string; epoch: number; exp: number };
  /** Retire only: one fresh requester nkey plus the exact terminal operation. The opId is stable
   * across retries but is never bearer authority; the target is what the returned grant confines. */
  retirement?: {
    id: string;
    target: { owner: string; actor: string; lifecycleUid: string };
    opId: string;
    serveEpoch: number;
  };
  /** Activate only: the manager's canonical contract artifacts, already content-addressed by the
   * client. The host publishes exactly these after re-hashing and derives the registered surface;
   * arbitrary extra contracts are refused by closed artifact count/digest checks. */
  contractArtifacts?: unknown[];
  identities: {
    supervisor: { id: string };
    executor: { id: string };
    serve: { id: string };
    goalWriter: { id: string };
    sessionLedger: { id: string };
  };
}

/** A bounded host-signed user JWT returned for a caller-generated nkey. The private seed stays
 * on the participant machine; the caller combines this JWT with that seed when connecting. */
export interface RemoteManagerCredential {
  jwt: string;
  exp: number;
}

/** Server-selected actors. They are fixed functions of the opaque instance id, never client input. */
export interface RemoteManagerActors {
  supervisor: string;
  executor: string;
  serve: string;
  goalWriter: string;
  sessionLedger: string;
}

/** Host-issued material for one phase of exactly one manager lifecycle. */
export interface RemoteManagerAuthorityMaterial {
  v: 1;
  kind: "manager-service-authority";
  operation: RemoteManagerAuthorityRequest["operation"];
  space: string;
  owner: string;
  actor: string;
  instanceId: string;
  lifecycleUid: string;
  requestId: string;
  registrationProof?: string;
  retirement?: RemoteManagerAuthorityRequest["retirement"];
  issuedAt: number;
  expiresAt: number;
  actors: RemoteManagerActors;
  identities: RemoteManagerAuthorityRequest["identities"];
  /** `prepare` returns the supervisor; `activate` returns serve+goal/session; `renew` may
   * return every credential. An absent key is absent authority, never an implicit fallback. */
  /** Prepare returns the deterministic proof that the host will require on activate/renew. */
  nextRegistrationProof?: string;
  credentials: Partial<{
    supervisor: RemoteManagerCredential;
    executor: RemoteManagerCredential;
    serve: RemoteManagerCredential;
    goalWriter: RemoteManagerCredential;
    sessionLedger: RemoteManagerCredential;
    sessionServing: RemoteManagerCredential;
    retirementRequester: RemoteManagerCredential;
  }>;
}

/**
 * Closed request for a remote manager to revalidate one retained managed agent on its host.
 *
 * The actor token and sentinel credential are existing per-agent material, not new authority. They
 * cross only the authenticated manager-authority HTTPS exchange and are consumed by the host's
 * current provider state. The host returns no credential or secret, only the current non-secret
 * ledger authority shape.
 */
export interface RemoteRetainedAgentValidationRequest {
  v: 1;
  kind: "manager-retained-agent-validation";
  space: string;
  /** The interactive actor whose fresh `supervise` grant authorizes this manager lifecycle. */
  actor: string;
  instanceId: string;
  managerLifecycleUid: string;
  requestId: string;
  registrationProof: string;
  serveEpoch: number;
  identities: RemoteManagerAuthorityRequest["identities"];
  target: { owner: string; actor: string; lifecycleUid: string };
  actorToken: string;
  sentinelCreds: string;
}

/** Exact non-secret answer to one retained-agent validation request. */
export interface RemoteRetainedAgentValidationResult {
  v: 1;
  kind: "manager-retained-agent-validation";
  space: string;
  owner: string;
  actor: string;
  instanceId: string;
  managerLifecycleUid: string;
  requestId: string;
  registrationProof: string;
  serveEpoch: number;
  target: RemoteRetainedAgentValidationRequest["target"];
  authority: import("./auth-provider.js").RetainedAgentAuthority;
}

/** Closed host-owned boot scan. The participant supplies no filter and receives parsed manager
 * goal-index rows for its authenticated owner only, never a records credential or raw KV body. */
export interface RemoteManagerGoalIndexScanRequest {
  v: 1;
  kind: "manager-goal-index-scan";
  space: string;
  actor: string;
  instanceId: string;
  managerLifecycleUid: string;
  requestId: string;
  registrationProof: string;
  serveEpoch: number;
  identities: RemoteManagerAuthorityRequest["identities"];
}

export interface RemoteManagerGoalIndexScanResult {
  v: 1;
  kind: "manager-goal-index-scan";
  space: string;
  owner: string;
  actor: string;
  instanceId: string;
  managerLifecycleUid: string;
  requestId: string;
  registrationProof: string;
  serveEpoch: number;
  entries: import("./endpoint-action.js").GoalIndexEntry[];
}

export function remoteManagerActors(instanceId: string): RemoteManagerActors {
  return {
    supervisor: `manager_${instanceId}`,
    executor: `manager_exec_${instanceId}`,
    serve: `manager_serve_${instanceId}`,
    goalWriter: `manager_goal_${instanceId}`,
    sessionLedger: `manager_session_${instanceId}`,
  };
}

/** Deterministic proof binding one remote Manager lifecycle to its owner, identities, and artifacts. */
export function remoteManagerRegistrationProof(owner: string, request: RemoteManagerAuthorityRequest): string {
  const artifactDigests = request.operation === "session" ? [] : (request.contractArtifacts ?? []).map((value) => rawDigest(JSON.stringify(value)));
  return rawDigest(JSON.stringify({
    v: 1,
    space: request.space,
    owner,
    instanceId: request.instanceId,
    lifecycleUid: request.managerLifecycleUid,
    actors: remoteManagerActors(request.instanceId),
    identities: request.identities,
    artifactDigests,
  }));
}

/** The one terminal operation identity for a managed lifecycle. It is derived, never selected:
 * manager retries, hosted authority issuance, and the auth barrier therefore converge on one op. */
export function managedRetirementOpId(lifecycleUid: string): string {
  return rawDigest(`retire:${assertLifecycleToken(lifecycleUid)}`).slice("sha256:".length, "sha256:".length + 26);
}
