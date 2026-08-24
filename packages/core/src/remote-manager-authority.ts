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
  operation: "prepare" | "activate" | "renew" | "session";
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
  }>;
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
