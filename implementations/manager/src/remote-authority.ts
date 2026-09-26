import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  credsFromJwt,
  managedRetirementOpId,
  mintLifecycleUid,
  newIdentity,
  remoteManagerActors,
  writeSecretFileAtomic,
  type Identity,
  type RemoteManagerAdminAuthorizationRequest,
  type RemoteManagerAdminAuthorizationResult,
  type RemoteManagerAuthorityMaterial,
  type RemoteManagerAuthorityRequest,
  type RemoteManagerGoalIndexScanRequest,
  type RemoteManagerGoalIndexScanResult,
  type RemoteManagerMaintenanceRequest,
  type RemoteManagerMaintenanceResult,
  type RemoteManagedAgentEnrollmentRequest,
  type RemoteManagedAgentEnrollmentResult,
  type RemoteManagedAgentPrepareRetirementRequest,
  type RemoteManagedAgentPrepareRetirementResult,
  type RemoteRetainedAgentValidationRequest,
  type RemoteRetainedAgentValidationResult,
  type RetainedAgentAuthority,
} from "@cotal-ai/core";

interface RemoteManagerIdentityState {
  v: 1;
  space: string;
  instanceId: string;
  lifecycleUid: string;
  identities: {
    supervisor: Identity;
    executor: Identity;
    serve: Identity;
    goalWriter: Identity;
    sessionLedger: Identity;
  };
}

export function remoteManagerAdminAuthorizationRequest(
  state: RemoteManagerIdentityState,
  actor: string,
  registrationProof: string,
  serveEpoch: number,
  caller: { owner: string; actor: string; lifecycleUid: string },
): RemoteManagerAdminAuthorizationRequest {
  return {
    v: 1,
    kind: "manager-admin-authorization",
    space: state.space,
    actor,
    instanceId: state.instanceId,
    managerLifecycleUid: state.lifecycleUid,
    requestId: `admin${mintLifecycleUid()}`,
    registrationProof,
    serveEpoch,
    identities: Object.fromEntries(Object.entries(state.identities).map(([name, identity]) => [name, { id: identity.id }])) as RemoteManagerAdminAuthorizationRequest["identities"],
    caller,
  };
}

/** Validate the untrusted host result before the boolean can gate a manager operation. */
export function remoteManagerAdminAuthorized(
  result: RemoteManagerAdminAuthorizationResult,
  request: RemoteManagerAdminAuthorizationRequest,
  expectedOwner: string,
): boolean {
  const fields = ["v", "kind", "space", "owner", "actor", "instanceId", "managerLifecycleUid", "requestId", "registrationProof", "serveEpoch", "identities", "caller", "authorized"];
  if (result === null || typeof result !== "object" || Array.isArray(result) || Object.keys(result).sort().join(",") !== fields.sort().join(","))
    throw new Error("manager admin authorization returned a non-closed result");
  if (result.v !== 1 || result.kind !== "manager-admin-authorization" || result.space !== request.space ||
      result.owner !== expectedOwner || result.actor !== request.actor || result.instanceId !== request.instanceId ||
      result.managerLifecycleUid !== request.managerLifecycleUid || result.requestId !== request.requestId ||
      result.registrationProof !== request.registrationProof || result.serveEpoch !== request.serveEpoch ||
      JSON.stringify(result.identities) !== JSON.stringify(request.identities) || JSON.stringify(result.caller) !== JSON.stringify(request.caller) ||
      typeof result.authorized !== "boolean")
    throw new Error("manager admin authorization returned different lifecycle, identity, caller, owner, or boolean coordinates");
  return result.authorized;
}

function stateFile(root: string, space: string): string {
  return join(root, ".cotal", `remote-manager.${Buffer.from(space, "utf8").toString("hex")}.json`);
}

function parseIdentity(v: unknown, what: string): Identity {
  const o = v as Partial<Identity>;
  if (o === null || typeof o !== "object" || typeof o.id !== "string" || typeof o.seed !== "string")
    throw new Error(`${what} is malformed`);
  const identity = { id: o.id, seed: o.seed };
  // A synthetic JWT subject check is unnecessary here; credsFromJwt validates the seed when the
  // host-signed generation is materialized, before any connect.
  return identity;
}

/** Load or create one participant-owned manager lifecycle identity. Private seeds never leave it. */
export function loadOrCreateRemoteManagerIdentity(root: string, space: string): RemoteManagerIdentityState {
  const path = stateFile(root, space);
  if (existsSync(path)) {
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, "utf8")); }
    catch (e) { throw new Error(`${path}: remote manager authority state does not parse (${(e as Error).message}); refusing to rotate over it`); }
    const o = raw as Partial<RemoteManagerIdentityState>;
    if (o.v !== 1 || o.space !== space || typeof o.instanceId !== "string" || typeof o.lifecycleUid !== "string" || !o.identities)
      throw new Error(`${path}: remote manager authority state is malformed; refusing to mint a fresh instance over it`);
    const state: RemoteManagerIdentityState = {
      v: 1, space, instanceId: o.instanceId, lifecycleUid: o.lifecycleUid,
      identities: {
        supervisor: parseIdentity(o.identities.supervisor, "supervisor identity"),
        executor: parseIdentity(o.identities.executor, "executor identity"),
        serve: parseIdentity(o.identities.serve, "serve identity"),
        goalWriter: parseIdentity(o.identities.goalWriter, "goal-writer identity"),
        sessionLedger: parseIdentity(o.identities.sessionLedger, "session-ledger identity"),
      },
    };
    return state;
  }
  const state: RemoteManagerIdentityState = {
    v: 1,
    space,
    instanceId: mintLifecycleUid(),
    lifecycleUid: mintLifecycleUid(),
    identities: {
      supervisor: newIdentity(),
      executor: newIdentity(),
      serve: newIdentity(),
      goalWriter: newIdentity(),
      sessionLedger: newIdentity(),
    },
  };
  writeSecretFileAtomic(path, JSON.stringify(state, null, 2));
  return state;
}

export function remoteManagerAuthorityRequest(
  state: RemoteManagerIdentityState,
  actor: string,
  operation: RemoteManagerAuthorityRequest["operation"],
  registrationProof?: string,
  contractArtifacts?: unknown[],
  session?: RemoteManagerAuthorityRequest["session"],
  retirement?: RemoteManagerAuthorityRequest["retirement"],
): RemoteManagerAuthorityRequest {
  const requestId = `${operation}${mintLifecycleUid()}`;
  return {
    v: 1,
    kind: "manager-service-authority",
    operation,
    space: state.space,
    actor,
    instanceId: state.instanceId,
    managerLifecycleUid: state.lifecycleUid,
    requestId,
    ...(registrationProof ? { registrationProof } : {}),
    ...(contractArtifacts ? { contractArtifacts } : {}),
    ...(session ? { session } : {}),
    ...(retirement ? { retirement } : {}),
    identities: {
      supervisor: { id: state.identities.supervisor.id },
      executor: { id: state.identities.executor.id },
      serve: { id: state.identities.serve.id },
      goalWriter: { id: state.identities.goalWriter.id },
      sessionLedger: { id: state.identities.sessionLedger.id },
    },
  };
}

export function remoteManagerMaintenanceRequest(
  state: RemoteManagerIdentityState,
  actor: string,
  operation: RemoteManagerMaintenanceRequest["operation"],
  targetInstanceId: string,
  principal?: string,
): RemoteManagerMaintenanceRequest {
  return {
    v: 1,
    kind: "manager-service-maintenance",
    operation,
    space: state.space,
    actor,
    instanceId: state.instanceId,
    managerLifecycleUid: state.lifecycleUid,
    requestId: `maintain${mintLifecycleUid()}`,
    identities: Object.fromEntries(Object.entries(state.identities).map(([name, identity]) => [name, { id: identity.id }])) as RemoteManagerMaintenanceRequest["identities"],
    targetInstanceId,
    ...(principal ? { principal } : {}),
  };
}

/** Bind a host maintenance result to every request coordinate and validate the returned evidence. */
export function remoteManagerMaintenanceResult(
  result: RemoteManagerMaintenanceResult,
  request: RemoteManagerMaintenanceRequest,
  expectedOwner: string,
): RemoteManagerMaintenanceResult {
  const expectedKeys = [
    "v", "kind", "operation", "space", "owner", "actor", "instanceId", "managerLifecycleUid",
    "requestId", "identities", "targetInstanceId", ...(request.principal ? ["principal"] : []),
    request.operation === "evict-family-principal" ? "eviction" : "reconciliation",
  ];
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      Object.keys(result).sort().join(",") !== expectedKeys.sort().join(",") ||
      result.v !== 1 || result.kind !== "manager-service-maintenance" || result.owner !== expectedOwner ||
      result.operation !== request.operation || result.space !== request.space || result.actor !== request.actor ||
      result.instanceId !== request.instanceId || result.managerLifecycleUid !== request.managerLifecycleUid ||
      result.requestId !== request.requestId || result.targetInstanceId !== request.targetInstanceId ||
      JSON.stringify(result.identities) !== JSON.stringify(request.identities) || result.principal !== request.principal)
    throw new Error("manager maintenance returned different lifecycle, target, principal, or owner coordinates");
  if (request.operation === "evict-family-principal") {
    const e = result.eviction;
    if (!e || typeof e !== "object" || Array.isArray(e) ||
        Object.keys(e).some((key) => !["principal", "kicked", "remaining", "verifiedGone", "scanComplete", "note"].includes(key)) ||
        e.principal !== request.principal || !Number.isSafeInteger(e.kicked) || e.kicked < 0 ||
        !Number.isSafeInteger(e.remaining) || e.remaining < 0 || typeof e.verifiedGone !== "boolean" || typeof e.scanComplete !== "boolean")
      throw new Error("manager maintenance returned garbled or foreign eviction evidence");
    if (e.verifiedGone && (!e.scanComplete || e.remaining !== 0))
      throw new Error("manager maintenance returned contradictory eviction evidence");
  } else {
    const r = result.reconciliation;
    const reportKeys = [
      "endpoint", "instanceId", "holderPrincipal", "opId", "freezeToken", "before", "after", "liveness",
      "familyRows", "revoked", "evicted", "holders", "holdersVerifiedBeforeAttempt",
      "holdersVerifiedThisAttempt", "holdersRemaining", "repairCursorCleanup", "reopenedAtGeneration",
    ];
    if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).sort().join(",") !== reportKeys.sort().join(",") ||
        r.endpoint !== "manager" || r.instanceId !== request.targetInstanceId ||
        !Number.isSafeInteger(r.freezeToken) || !Number.isSafeInteger(r.familyRows) || !Number.isSafeInteger(r.reopenedAtGeneration) ||
        ![r.holderPrincipal, r.opId].every((value) => typeof value === "string" && value.length > 0) ||
        ![r.revoked, r.evicted, r.holders, r.holdersVerifiedBeforeAttempt, r.holdersVerifiedThisAttempt, r.holdersRemaining]
          .every((value) => Array.isArray(value) && value.every((item) => typeof item === "string")) ||
        (r.repairCursorCleanup !== "deleted" && r.repairCursorCleanup !== "retained") ||
        !r.liveness || r.liveness.state !== "gone" || typeof r.liveness.detail !== "string")
      throw new Error("manager maintenance returned no closed matching reconciliation report");
  }
  return result;
}

export function remoteRetainedAgentValidationRequest(
  state: RemoteManagerIdentityState,
  actor: string,
  registrationProof: string,
  serveEpoch: number,
  target: { owner: string; actor: string; lifecycleUid: string },
  actorToken: string,
  sentinelCreds: string,
): RemoteRetainedAgentValidationRequest {
  return {
    v: 1,
    kind: "manager-retained-agent-validation",
    space: state.space,
    actor,
    instanceId: state.instanceId,
    managerLifecycleUid: state.lifecycleUid,
    requestId: `validate${mintLifecycleUid()}`,
    registrationProof,
    serveEpoch,
    identities: {
      supervisor: { id: state.identities.supervisor.id },
      executor: { id: state.identities.executor.id },
      serve: { id: state.identities.serve.id },
      goalWriter: { id: state.identities.goalWriter.id },
      sessionLedger: { id: state.identities.sessionLedger.id },
    },
    target,
    actorToken,
    sentinelCreds,
  };
}

/** Activation returns the only proof valid for later retained validation. The caller-computable
 * activation proof is deliberately not accepted as a fallback. */
export function currentRegistrationProof(material: RemoteManagerAuthorityMaterial): string {
  const proof = material.nextRegistrationProof;
  if (typeof proof !== "string" || !/^sha256:[0-9a-f]{64}$/.test(proof))
    throw new Error("manager-service activation returned no host-authenticated current registration proof");
  if (proof === material.registrationProof)
    throw new Error("manager-service activation substituted the caller-computable activation proof for the host-authenticated current registration proof");
  return proof;
}

/** Bind a host result back to every request coordinate before Manager consumes its authority row. */
export function retainedAgentAuthority(
  result: RemoteRetainedAgentValidationResult,
  request: RemoteRetainedAgentValidationRequest,
): RetainedAgentAuthority {
  if (result === null || typeof result !== "object" || Array.isArray(result) ||
      Object.keys(result).sort().join(",") !== [
        "actor", "authority", "instanceId", "kind", "managerLifecycleUid", "owner",
        "registrationProof", "requestId", "serveEpoch", "space", "target", "v",
      ].sort().join(","))
    throw new Error("manager retained-agent validation returned a non-closed result");
  if (result.v !== 1 || result.kind !== "manager-retained-agent-validation" ||
      result.space !== request.space || result.actor !== request.actor || result.instanceId !== request.instanceId ||
      result.managerLifecycleUid !== request.managerLifecycleUid || result.requestId !== request.requestId ||
      result.registrationProof !== request.registrationProof || result.serveEpoch !== request.serveEpoch ||
      JSON.stringify(result.target) !== JSON.stringify(request.target) || result.owner !== request.target.owner)
    throw new Error("manager retained-agent validation returned different lifecycle or target coordinates");
  const authority = result.authority;
  if (!authority || typeof authority !== "object" || Array.isArray(authority) ||
      Object.keys(authority).some((key) => !["owner", "actor", "lifecycleUid", "scope", "allowSubscribe", "allowPublish", "role", "parent"].includes(key)) ||
      authority.owner !== request.target.owner || authority.actor !== request.target.actor ||
      authority.lifecycleUid !== request.target.lifecycleUid || !Array.isArray(authority.scope) ||
      !authority.scope.every((value) => typeof value === "string") ||
      !Array.isArray(authority.allowSubscribe) || !authority.allowSubscribe.every((value) => typeof value === "string") ||
      !Array.isArray(authority.allowPublish) || !authority.allowPublish.every((value) => typeof value === "string") ||
      (authority.role !== undefined && typeof authority.role !== "string") ||
      (authority.parent !== undefined && typeof authority.parent !== "string"))
    throw new Error("manager retained-agent validation returned an invalid or replacement authority");
  return authority;
}

/** Bind a host-owned goal-index scan back to its request and validate every returned row before the
 * manager acts on it. The HTTP result is untrusted input even though the host authenticated it. */
export function remoteManagerGoalIndexEntries(
  result: RemoteManagerGoalIndexScanResult,
  request: RemoteManagerGoalIndexScanRequest,
  expectedOwner: string,
): import("@cotal-ai/core").GoalIndexEntry[] {
  const envelopeKeys = ["v", "kind", "space", "owner", "actor", "instanceId", "managerLifecycleUid", "requestId", "registrationProof", "serveEpoch", "entries"];
  if (result === null || typeof result !== "object" || Array.isArray(result) || Object.keys(result).sort().join(",") !== envelopeKeys.sort().join(","))
    throw new Error("manager goal-index scan returned a non-closed result");
  if (result.v !== 1 || result.kind !== "manager-goal-index-scan" || result.space !== request.space ||
      result.owner !== expectedOwner || result.actor !== request.actor || result.instanceId !== request.instanceId ||
      result.managerLifecycleUid !== request.managerLifecycleUid || result.requestId !== request.requestId ||
      result.registrationProof !== request.registrationProof || result.serveEpoch !== request.serveEpoch || !Array.isArray(result.entries))
    throw new Error("manager goal-index scan returned different lifecycle coordinates");
  return result.entries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        Object.keys(entry).some((key) => !["v", "endpoint", "owner", "actor", "uid", "goalId", "iid", "allocated", "note"].includes(key)) ||
        entry.v !== 1 || entry.endpoint !== "manager" || entry.owner !== expectedOwner ||
        ![entry.actor, entry.uid, entry.goalId, entry.iid].every((value) => typeof value === "string" && value.length > 0) ||
        (entry.note !== undefined && (typeof entry.note !== "string" || entry.note.length === 0 || entry.note.length > 65_536)))
      throw new Error(`manager goal-index scan returned invalid entry ${index}`);
    if (entry.allocated !== undefined && (!entry.allocated || typeof entry.allocated !== "object" || Array.isArray(entry.allocated) ||
        Object.keys(entry.allocated).some((key) => !["name", "actor", "uid", "readinessDeadlineMs"].includes(key)) ||
        ![entry.allocated.name, entry.allocated.actor, entry.allocated.uid].every((value) => typeof value === "string" && value.length > 0) ||
        (entry.allocated.readinessDeadlineMs !== undefined && (!Number.isSafeInteger(entry.allocated.readinessDeadlineMs) || entry.allocated.readinessDeadlineMs <= 0))))
      throw new Error(`manager goal-index scan returned invalid allocation in entry ${index}`);
    return entry;
  });
}

/** Combine a host-signed JWT with the participant's private seed, after exact identity checks. */
export function materialCredential(
  material: RemoteManagerAuthorityMaterial,
  name: keyof RemoteManagerAuthorityMaterial["credentials"],
  identity: Identity,
): string {
  const credential = material.credentials[name];
  if (!credential) throw new Error(`manager-service ${material.operation} returned no ${name} credential`);
  let claims: { sub?: unknown; exp?: unknown };
  try { claims = JSON.parse(Buffer.from(credential.jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown; exp?: unknown }; }
  catch { throw new Error(`manager-service ${name} credential is not a JWT`); }
  if (claims.sub !== identity.id) throw new Error(`manager-service ${name} JWT is for ${String(claims.sub)}, not the requested identity ${identity.id}`);
  const envelopeExpiry = Math.min(...Object.values(material.credentials).map((item) => item!.exp * 1000));
  // `expiresAt` is the envelope's earliest member expiry, not a ceiling on every member. Prepare
  // deliberately returns a short registration executor beside a longer-lived supervisor, so
  // requiring each credential to expire no later than the minimum makes the legitimate supervisor
  // impossible to materialize. Recompute the envelope minimum and then bind this JWT to its own
  // advertised expiry. A forged later envelope or a JWT/entry disagreement still fails closed.
  // There is no clock here on purpose: a credential past its `exp` is refused by the broker when
  // the manager connects with it, which is where expiry is enforced.
  if (claims.exp !== credential.exp || !Number.isFinite(envelopeExpiry) || material.expiresAt !== envelopeExpiry || credential.exp * 1000 < material.expiresAt)
    throw new Error(`manager-service ${name} expiry does not match the material envelope`);
  return credsFromJwt(credential.jwt, identity);
}

export function expectedRemoteManagerActors(state: RemoteManagerIdentityState) {
  return remoteManagerActors(state.instanceId);
}

/** Build one host-owned managed-agent enrollment request (#1972). The request carries the DIGEST of
 *  the standing actor token, never the token: the participant has already written the plaintext at
 *  0600, and the host's copy is a hash it can only compare against. */
export function remoteManagedAgentEnrollmentRequest(
  state: RemoteManagerIdentityState,
  actor: string,
  registrationProof: string,
  serveEpoch: number,
  target: RemoteManagedAgentEnrollmentRequest["target"],
): RemoteManagedAgentEnrollmentRequest {
  return {
    v: 1,
    kind: "manager-managed-agent-enrollment",
    space: state.space,
    actor,
    instanceId: state.instanceId,
    managerLifecycleUid: state.lifecycleUid,
    requestId: `enroll${mintLifecycleUid()}`,
    registrationProof,
    serveEpoch,
    target,
    identities: Object.fromEntries(Object.entries(state.identities).map(([name, identity]) => [name, { id: identity.id }])) as RemoteManagedAgentEnrollmentRequest["identities"],
  };
}

/** Bind a host enrollment result back to every request coordinate and validate the returned
 *  material before the manager launches a child against it. An HTTP body is untrusted input even
 *  though the host authenticated the request that produced it. */
export function remoteManagedAgentEnrollmentMaterial(
  result: RemoteManagedAgentEnrollmentResult,
  request: RemoteManagedAgentEnrollmentRequest,
): RemoteManagedAgentEnrollmentResult["material"] {
  const envelopeKeys = [
    "v", "kind", "space", "owner", "actor", "instanceId", "managerLifecycleUid",
    "requestId", "registrationProof", "serveEpoch", "material",
  ];
  if (result === null || typeof result !== "object" || Array.isArray(result) ||
      Object.keys(result).sort().join(",") !== envelopeKeys.sort().join(","))
    throw new Error("managed agent enrollment returned a non-closed result");
  if (result.v !== 1 || result.kind !== "manager-managed-agent-enrollment" || result.space !== request.space ||
      result.actor !== request.actor || result.instanceId !== request.instanceId ||
      result.managerLifecycleUid !== request.managerLifecycleUid || result.requestId !== request.requestId ||
      result.registrationProof !== request.registrationProof || result.serveEpoch !== request.serveEpoch ||
      typeof result.owner !== "string" || result.owner.length === 0)
    throw new Error("managed agent enrollment returned different lifecycle, request, or owner coordinates");
  const m = result.material;
  const materialKeys = ["owner", "actor", "lifecycleUid", "sentinelCreds", "subscribe", "allowSubscribe", "allowPublish", "agentBearerExchangeUrl"];
  if (!m || typeof m !== "object" || Array.isArray(m) || Object.keys(m).sort().join(",") !== materialKeys.sort().join(","))
    throw new Error("managed agent enrollment returned non-closed material");
  // The envelope owner and the material owner are the SAME authority. A result that disagreed with
  // itself would let one field name the audited owner and the other the owner actually granted.
  if (m.owner !== result.owner)
    throw new Error("managed agent enrollment material names a different owner than its envelope");
  if (m.actor !== request.target.actor)
    throw new Error(`managed agent enrollment returned actor "${m.actor}", not the requested "${request.target.actor}"`);
  if (typeof m.lifecycleUid !== "string" || !/^[a-z0-9]{26,32}$/.test(m.lifecycleUid))
    throw new Error("managed agent enrollment returned no valid host-selected lifecycle uid");
  if (typeof m.sentinelCreds !== "string" || m.sentinelCreds.length === 0)
    throw new Error("managed agent enrollment returned no sentinel credentials");
  for (const key of ["subscribe", "allowSubscribe", "allowPublish"] as const)
    if (!Array.isArray(m[key]) || !m[key].every((value) => typeof value === "string" && value.length > 0))
      throw new Error(`managed agent enrollment returned an invalid ${key} list`);
  // The bearer endpoint the CHILD will present its standing token to. A plaintext or non-URL pin
  // would put that token on the wire in the clear, so it is refused here rather than at first
  // exchange, and a loopback literal is the only HTTP exception (the same rule agent-bearer keeps).
  let url: URL;
  try { url = new URL(m.agentBearerExchangeUrl); }
  catch { throw new Error(`managed agent enrollment returned no usable agent bearer exchange URL (got ${JSON.stringify(m.agentBearerExchangeUrl)})`); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")))
    throw new Error(`managed agent enrollment returned a non-HTTPS agent bearer exchange URL (${url.protocol}//) - the actor token must never cross plaintext off this machine`);
  return m;
}

/** Build one host-owned prepare-retirement request (#1972 phase P0/P1). The opId is DERIVED from the
 *  target lifecycle, so a retry converges on the host's existing operation instead of opening a
 *  second barrier over one head. */
export function remoteManagedAgentPrepareRetirementRequest(
  state: RemoteManagerIdentityState,
  actor: string,
  registrationProof: string,
  serveEpoch: number,
  target: { owner: string; actor: string; lifecycleUid: string },
  opId: string,
): RemoteManagedAgentPrepareRetirementRequest {
  if (opId !== managedRetirementOpId(target.lifecycleUid))
    throw new Error(`managed agent prepare-retirement opId "${opId}" is not the derived terminal operation for lifecycle ${target.lifecycleUid}`);
  return {
    v: 1,
    kind: "manager-managed-agent-prepare-retirement",
    space: state.space,
    actor,
    instanceId: state.instanceId,
    managerLifecycleUid: state.lifecycleUid,
    requestId: `prepare${mintLifecycleUid()}`,
    registrationProof,
    serveEpoch,
    target,
    opId,
    identities: Object.fromEntries(Object.entries(state.identities).map(([name, identity]) => [name, { id: identity.id }])) as RemoteManagedAgentPrepareRetirementRequest["identities"],
  };
}

/** Bind a host prepare-retirement result to its request. Only an exact, closed `prepared: true`
 *  answer permits the terminal auth barrier to start; anything else keeps the alias held. */
export function remoteManagedAgentRetirementPrepared(
  result: RemoteManagedAgentPrepareRetirementResult,
  request: RemoteManagedAgentPrepareRetirementRequest,
): void {
  const keys = [
    "v", "kind", "space", "owner", "actor", "instanceId", "managerLifecycleUid",
    "requestId", "target", "opId", "prepared",
  ];
  if (result === null || typeof result !== "object" || Array.isArray(result) ||
      Object.keys(result).sort().join(",") !== keys.sort().join(","))
    throw new Error("managed agent prepare-retirement returned a non-closed result");
  if (result.v !== 1 || result.kind !== "manager-managed-agent-prepare-retirement" || result.space !== request.space ||
      result.actor !== request.actor || result.instanceId !== request.instanceId ||
      result.managerLifecycleUid !== request.managerLifecycleUid || result.requestId !== request.requestId ||
      result.owner !== request.target.owner || result.opId !== request.opId ||
      JSON.stringify(result.target) !== JSON.stringify(request.target))
    throw new Error("managed agent prepare-retirement returned different lifecycle, target, or operation coordinates");
  if (result.prepared !== true)
    throw new Error("managed agent prepare-retirement did not confirm the release; the terminal barrier must not start");
}
