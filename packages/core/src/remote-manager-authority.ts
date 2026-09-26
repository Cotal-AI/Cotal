import { rawDigest } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-error.js";
import { assertDerivedOwnerToken, assertLifecycleToken, assertValidChannel, assertValidOwnerToken } from "./subjects.js";

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
  /** Earliest `exp` among the envelope's credentials, in milliseconds, as the issuer computes it.
   * The manager never compares it with a clock: each credential is a signed JWT whose `exp` the
   * broker verifies at connect, which is where expiry is enforced. Locally it is a coherence
   * bound: `materialCredential` refuses a credential whose own `exp` disagrees with it. */
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

/** Closed host-owned maintenance request for one remote manager registration. The participant
 * names an operation and, for eviction, one claimed family holder. The host re-binds every
 * coordinate to the authenticated owner and current registration before it acts. */
export interface RemoteManagerMaintenanceRequest {
  v: 1;
  kind: "manager-service-maintenance";
  operation: "evict-family-principal" | "reconcile-registration";
  space: string;
  actor: string;
  instanceId: string;
  managerLifecycleUid: string;
  requestId: string;
  identities: RemoteManagerAuthorityRequest["identities"];
  /** Instance whose frozen gate or credential family the host operation touches. Eviction requires
   * this to equal `instanceId`; reconciliation may name a foreign slot holder in the same space. */
  targetInstanceId: string;
  /** Required only for `evict-family-principal`. Membership is host-enumerated, never trusted. */
  principal?: string;
}

/** Exact maintenance request echo plus the host-owned result. */
export interface RemoteManagerMaintenanceResult {
  v: 1;
  kind: "manager-service-maintenance";
  operation: RemoteManagerMaintenanceRequest["operation"];
  space: string;
  owner: string;
  actor: string;
  instanceId: string;
  managerLifecycleUid: string;
  requestId: string;
  identities: RemoteManagerAuthorityRequest["identities"];
  targetInstanceId: string;
  principal?: string;
  eviction?: import("./evict.js").EvictionResult;
  reconciliation?: import("./endpoint-reconcile.js").GateReconcileReport;
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

/** Closed, non-transferable serve-time admin decision for one exact endpoint caller. */
export interface RemoteManagerAdminAuthorizationRequest {
  v: 1;
  kind: "manager-admin-authorization";
  space: string;
  /** Interactive actor whose current `supervise` grant authorizes this manager lifecycle. */
  actor: string;
  instanceId: string;
  managerLifecycleUid: string;
  requestId: string;
  registrationProof: string;
  serveEpoch: number;
  identities: RemoteManagerAuthorityRequest["identities"];
  /** Registered manager relay of the broker-authenticated endpoint caller tuple. */
  caller: { owner: string; actor: string; lifecycleUid: string };
}

/** Exact echo plus one host-derived boolean. No scope or ledger row crosses the seam. */
export interface RemoteManagerAdminAuthorizationResult {
  v: 1;
  kind: "manager-admin-authorization";
  space: string;
  owner: string;
  actor: string;
  instanceId: string;
  managerLifecycleUid: string;
  requestId: string;
  registrationProof: string;
  serveEpoch: number;
  identities: RemoteManagerAuthorityRequest["identities"];
  caller: RemoteManagerAdminAuthorizationRequest["caller"];
  authorized: boolean;
}

/**
 * Closed wire request for host-owned managed agent enrollment (#1972).
 *
 * The participant generates the standing `actorToken` locally, persists it at 0600 BEFORE the
 * request, and sends ONLY its SHA-256 digest. The plaintext secret never leaves the participant
 * machine. The host alone picks the lifecycle UID, so the request carries none: a participant that
 * could name the UID could aim a fresh grant at a retired or retiring incarnation.
 */
export interface RemoteManagedAgentEnrollmentRequest {
  v: 1;
  kind: "manager-managed-agent-enrollment";
  space: string;
  /** The interactive actor whose fresh `supervise` grant authorizes this manager lifecycle. */
  actor: string;
  instanceId: string;
  managerLifecycleUid: string;
  requestId: string;
  registrationProof: string;
  serveEpoch: number;
  target: {
    actor: string;
    /** SHA-256 hash of the locally generated actorToken. Plaintext never leaves the participant. */
    tokenHash: string;
    role?: string;
    label?: string;
    capabilities?: string[];
    subscribe?: string[];
    allowSubscribe?: string[];
    allowPublish?: string[];
  };
  identities: RemoteManagerAuthorityRequest["identities"];
}

/** Host-issued authority material returned to the remote manager upon enrollment. */
export interface RemoteManagedAgentEnrollmentResult {
  v: 1;
  kind: "manager-managed-agent-enrollment";
  space: string;
  owner: string;
  actor: string;
  instanceId: string;
  managerLifecycleUid: string;
  requestId: string;
  registrationProof: string;
  serveEpoch: number;
  material: {
    owner: string;
    actor: string;
    lifecycleUid: string;
    /** Space-wide callout sentinel credentials, NOT per-agent material. */
    sentinelCreds: string;
    subscribe: string[];
    allowSubscribe: string[];
    allowPublish: string[];
    /** Pinned public auth-service base URL for agent bearer exchange. */
    agentBearerExchangeUrl: string;
  };
}

/**
 * Closed wire request for host preparation of terminal managed agent retirement (#1972 P0/P1).
 *
 * The opId is derived from the target lifecycle UID, never selected: the participant's retries,
 * the host's release, and the terminal auth barrier all converge on one operation.
 */
export interface RemoteManagedAgentPrepareRetirementRequest {
  v: 1;
  kind: "manager-managed-agent-prepare-retirement";
  space: string;
  actor: string;
  instanceId: string;
  managerLifecycleUid: string;
  requestId: string;
  registrationProof: string;
  serveEpoch: number;
  target: { owner: string; actor: string; lifecycleUid: string };
  opId: string;
  identities: RemoteManagerAuthorityRequest["identities"];
}

/** Release confirmation returned once the host committed phase P1. */
export interface RemoteManagedAgentPrepareRetirementResult {
  v: 1;
  kind: "manager-managed-agent-prepare-retirement";
  space: string;
  owner: string;
  actor: string;
  instanceId: string;
  managerLifecycleUid: string;
  requestId: string;
  target: RemoteManagedAgentPrepareRetirementRequest["target"];
  opId: string;
  prepared: true;
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

const IDENTITY_NAMES = ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"] as const;

/** The bound on one enrollment ACL list. A grant wider than this is a configuration mistake, and a
 *  request carrying thousands of patterns is a body-size attack on the host's derivation. */
const MAX_ENROLLMENT_LIST = 64;

function enrollmentError(what: string, detail: string): never {
  throw new EpEnvelopeError("bad-request", `${what} request ${detail}`);
}

/** The envelope fields every managed-agent request shares, validated once for both parsers. */
function parseManagedAgentEnvelope(
  o: Record<string, unknown>,
  what: string,
  kind: string,
): {
  space: string;
  actor: string;
  instanceId: string;
  managerLifecycleUid: string;
  requestId: string;
  registrationProof: string;
  serveEpoch: number;
  identities: RemoteManagerAuthorityRequest["identities"];
} {
  if (o.v !== 1 || o.kind !== kind) enrollmentError(what, `must carry { v: 1, kind: ${JSON.stringify(kind)} }`);
  for (const key of ["space", "actor", "instanceId", "managerLifecycleUid", "requestId", "registrationProof"] as const)
    if (typeof o[key] !== "string" || (o[key] as string).length === 0) enrollmentError(what, `requires non-empty ${key}`);
  assertValidOwnerToken(o.actor as string);
  assertLifecycleToken(o.instanceId as string, `${what} instanceId`);
  assertLifecycleToken(o.managerLifecycleUid as string, `${what} lifecycleUid`);
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(o.requestId as string))
    enrollmentError(what, "requestId must be a 22-64 character idempotency token");
  if (!/^sha256:[0-9a-f]{64}$/.test(o.registrationProof as string)) enrollmentError(what, "requires a sha256 registrationProof");
  if (typeof o.serveEpoch !== "number" || !Number.isSafeInteger(o.serveEpoch) || o.serveEpoch < 0)
    enrollmentError(what, "serveEpoch must be a non-negative safe integer");
  const ids = o.identities;
  if (ids === null || typeof ids !== "object" || Array.isArray(ids)) enrollmentError(what, "requires identities");
  const idObj = ids as Record<string, unknown>;
  if (Object.keys(idObj).sort().join(",") !== [...IDENTITY_NAMES].sort().join(","))
    enrollmentError(what, `identities must contain exactly ${IDENTITY_NAMES.join(", ")}`);
  const identities = {} as RemoteManagerAuthorityRequest["identities"];
  for (const name of IDENTITY_NAMES) {
    const item = idObj[name];
    if (item === null || typeof item !== "object" || Array.isArray(item) || Object.keys(item as object).join(",") !== "id")
      enrollmentError(what, `identities.${name} must be exactly { id }`);
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || !/^U[A-Z2-7]{55}$/.test(id)) enrollmentError(what, `identities.${name}.id must be a user nkey`);
    identities[name] = { id };
  }
  return {
    space: o.space as string,
    actor: o.actor as string,
    instanceId: o.instanceId as string,
    managerLifecycleUid: o.managerLifecycleUid as string,
    requestId: o.requestId as string,
    registrationProof: o.registrationProof as string,
    serveEpoch: o.serveEpoch,
    identities,
  };
}

/** One optional channel/pattern list on an enrollment target: bounded, string-only, in-grammar. */
function parseEnrollmentList(value: unknown, what: string, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) enrollmentError(what, `target.${field} must be an array of channel patterns when present`);
  if (value.length > MAX_ENROLLMENT_LIST)
    enrollmentError(what, `target.${field} carries ${value.length} entries, more than the ${MAX_ENROLLMENT_LIST}-entry bound`);
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) enrollmentError(what, `target.${field} must contain only non-empty strings`);
    assertValidChannel(item);
  }
  return [...(value as string[])];
}

/**
 * Parse the enrollment request without retaining unknown input fields. The host derives the
 * lifecycle UID, the role, and the effective ACLs itself, so this parser proves only that what
 * arrived is in-grammar and bounded; it never widens a grant.
 */
export function parseRemoteManagedAgentEnrollmentRequest(raw: unknown): RemoteManagedAgentEnrollmentRequest {
  const what = "managed agent enrollment";
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) enrollmentError(what, "must be an object");
  const o = raw as Record<string, unknown>;
  const allowed = new Set([
    "v", "kind", "space", "actor", "instanceId", "managerLifecycleUid", "requestId",
    "registrationProof", "serveEpoch", "target", "identities",
  ]);
  for (const key of Object.keys(o))
    if (!allowed.has(key)) enrollmentError(what, `carries unknown field ${JSON.stringify(key)} (the protocol is closed)`);
  const envelope = parseManagedAgentEnvelope(o, what, "manager-managed-agent-enrollment");
  const target = o.target;
  if (target === null || typeof target !== "object" || Array.isArray(target)) enrollmentError(what, "requires a target");
  const t = target as Record<string, unknown>;
  const targetAllowed = new Set(["actor", "tokenHash", "role", "label", "capabilities", "subscribe", "allowSubscribe", "allowPublish"]);
  for (const key of Object.keys(t))
    if (!targetAllowed.has(key)) enrollmentError(what, `target carries unknown field ${JSON.stringify(key)} (the protocol is closed)`);
  if (typeof t.actor !== "string" || t.actor.length === 0) enrollmentError(what, "target requires a non-empty actor");
  assertValidOwnerToken(t.actor);
  // The digest, never the secret: a request that carried the plaintext standing token would put an
  // agent's whole exchange authority on the wire and in the host's logs.
  if (typeof t.tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(t.tokenHash))
    enrollmentError(what, "target.tokenHash must be a lowercase hex sha256 digest of the locally held actorToken");
  if (t.role !== undefined && (typeof t.role !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(t.role)))
    enrollmentError(what, "target.role must be a 1-64 character role token when present");
  if (t.label !== undefined && (typeof t.label !== "string" || t.label.length === 0 || t.label.length > 256))
    enrollmentError(what, "target.label must be a 1-256 character string when present");
  if (t.capabilities !== undefined) {
    if (!Array.isArray(t.capabilities)) enrollmentError(what, "target.capabilities must be an array when present");
    if (t.capabilities.length > MAX_ENROLLMENT_LIST)
      enrollmentError(what, `target.capabilities carries ${t.capabilities.length} entries, more than the ${MAX_ENROLLMENT_LIST}-entry bound`);
    for (const cap of t.capabilities)
      if (typeof cap !== "string" || !/^[A-Za-z0-9_:-]{1,64}$/.test(cap))
        enrollmentError(what, "target.capabilities must contain only 1-64 character capability tokens");
  }
  const subscribe = parseEnrollmentList(t.subscribe, what, "subscribe");
  const allowSubscribe = parseEnrollmentList(t.allowSubscribe, what, "allowSubscribe");
  const allowPublish = parseEnrollmentList(t.allowPublish, what, "allowPublish");
  return {
    v: 1,
    kind: "manager-managed-agent-enrollment",
    ...envelope,
    target: {
      actor: t.actor,
      tokenHash: t.tokenHash,
      ...(t.role !== undefined ? { role: t.role as string } : {}),
      ...(t.label !== undefined ? { label: t.label as string } : {}),
      ...(t.capabilities !== undefined ? { capabilities: [...(t.capabilities as string[])] } : {}),
      ...(subscribe !== undefined ? { subscribe } : {}),
      ...(allowSubscribe !== undefined ? { allowSubscribe } : {}),
      ...(allowPublish !== undefined ? { allowPublish } : {}),
    },
  };
}

/**
 * Parse the prepare-retirement request without retaining unknown input fields. The opId is checked
 * against {@link managedRetirementOpId} here, so a caller cannot name a second operation for one
 * lifecycle and split the terminal barrier in two.
 */
export function parseRemoteManagedAgentPrepareRetirementRequest(raw: unknown): RemoteManagedAgentPrepareRetirementRequest {
  const what = "managed agent prepare-retirement";
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) enrollmentError(what, "must be an object");
  const o = raw as Record<string, unknown>;
  const allowed = new Set([
    "v", "kind", "space", "actor", "instanceId", "managerLifecycleUid", "requestId",
    "registrationProof", "serveEpoch", "target", "opId", "identities",
  ]);
  for (const key of Object.keys(o))
    if (!allowed.has(key)) enrollmentError(what, `carries unknown field ${JSON.stringify(key)} (the protocol is closed)`);
  const envelope = parseManagedAgentEnvelope(o, what, "manager-managed-agent-prepare-retirement");
  const target = o.target;
  if (target === null || typeof target !== "object" || Array.isArray(target) ||
      Object.keys(target as object).sort().join(",") !== "actor,lifecycleUid,owner")
    enrollmentError(what, "target must be exactly { owner, actor, lifecycleUid }");
  const t = target as Record<string, unknown>;
  if (typeof t.owner !== "string" || typeof t.actor !== "string" || typeof t.lifecycleUid !== "string")
    enrollmentError(what, "target must contain string owner, actor, and lifecycleUid");
  const parsedTarget = {
    owner: assertDerivedOwnerToken(t.owner),
    actor: assertValidOwnerToken(t.actor),
    lifecycleUid: assertLifecycleToken(t.lifecycleUid, `${what} target lifecycleUid`),
  };
  if (typeof o.opId !== "string" || o.opId.length === 0) enrollmentError(what, "requires a non-empty opId");
  assertLifecycleToken(o.opId, `${what} opId`);
  if (o.opId !== managedRetirementOpId(parsedTarget.lifecycleUid))
    enrollmentError(what, `opId must be the derived terminal operation id for lifecycle ${parsedTarget.lifecycleUid}`);
  return {
    v: 1,
    kind: "manager-managed-agent-prepare-retirement",
    ...envelope,
    target: parsedTarget,
    opId: o.opId,
  };
}
