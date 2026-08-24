import {
  EpEnvelopeError,
  assertLifecycleToken,
  remoteManagerActors,
  type RemoteManagerAuthorityMaterial,
  type RemoteManagerAuthorityRequest,
} from "@cotal-ai/core";

/** Host-only typed request after the IdP proof and ledger row have been authenticated. */
export interface IssueRemoteManagerAuthorityArgs {
  request: RemoteManagerAuthorityRequest;
  owner: string;
  scope: string[];
  /** The host-side phase executor. It validates the live instance/gate state and signs only the
   * phase's fixed profile set for the caller-generated nkeys. */
  issue: (args: {
    owner: string;
    actors: ReturnType<typeof remoteManagerActors>;
    request: RemoteManagerAuthorityRequest;
  }) => Promise<{ credentials: RemoteManagerAuthorityMaterial["credentials"]; nextRegistrationProof?: string }>;
  now?: () => number;
}

function requestError(what: string): never {
  throw new EpEnvelopeError("bad-request", `manager-service authority request ${what}`);
}

/** Closed request parser: unknown fields and profile-like extensions are refused, never ignored. */
export function parseRemoteManagerAuthorityRequest(raw: unknown): RemoteManagerAuthorityRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) requestError("must be an object");
  const o = raw as Record<string, unknown>;
  const allowed = new Set(["v", "kind", "operation", "space", "actor", "instanceId", "managerLifecycleUid", "requestId", "registrationProof", "session", "contractArtifacts", "identities"]);
  for (const key of Object.keys(o)) if (!allowed.has(key)) requestError(`carries unknown field ${JSON.stringify(key)} (the protocol is closed)`);
  if (o.v !== 1 || o.kind !== "manager-service-authority") requestError('must carry { v: 1, kind: "manager-service-authority" }');
  if (o.operation !== "prepare" && o.operation !== "activate" && o.operation !== "renew" && o.operation !== "session")
    requestError('operation must be "prepare", "activate", "renew", or "session"');
  for (const key of ["space", "actor", "instanceId", "managerLifecycleUid", "requestId"] as const)
    if (typeof o[key] !== "string" || o[key].length === 0) requestError(`requires non-empty ${key}`);
  assertLifecycleToken(o.instanceId as string, "manager authority instanceId");
  assertLifecycleToken(o.managerLifecycleUid as string, "manager authority lifecycleUid");
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(o.requestId as string)) requestError("requestId must be a 22-64 character idempotency token");
  if (o.operation === "prepare" && (o.registrationProof !== undefined || o.contractArtifacts !== undefined))
    requestError("prepare must not carry registrationProof or contractArtifacts");
  if ((o.operation === "activate" || o.operation === "renew" || o.operation === "session") && (typeof o.registrationProof !== "string" || !/^sha256:[0-9a-f]{64}$/.test(o.registrationProof)))
    requestError(`${o.operation} requires a sha256 registrationProof`);
  if (o.operation === "activate" && (!Array.isArray(o.contractArtifacts) || o.contractArtifacts.length === 0 || o.contractArtifacts.length > 64))
    requestError("activate requires 1-64 canonical manager contractArtifacts");
  if ((o.operation === "renew" || o.operation === "session") && o.contractArtifacts !== undefined)
    requestError(`${o.operation} must not carry contractArtifacts`);
  if (o.operation === "session") {
    const s = o.session as Record<string, unknown> | undefined;
    if (!s || typeof s.id !== "string" || !/^U[A-Z2-7]{55}$/.test(s.id) || s.endpoint !== "manager" ||
        typeof s.sessionId !== "string" || s.sessionId.length === 0 || typeof s.epoch !== "number" || !Number.isSafeInteger(s.epoch) || s.epoch < 0 ||
        typeof s.exp !== "number" || !Number.isSafeInteger(s.exp) || s.exp <= 0)
      requestError("session requires { id, endpoint:\"manager\", sessionId, epoch, exp }");
  } else if (o.session !== undefined) requestError(`${o.operation} must not carry session`);
  const ids = o.identities;
  if (ids === null || typeof ids !== "object" || Array.isArray(ids)) requestError("requires identities");
  const names = ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"] as const;
  const idObj = ids as Record<string, unknown>;
  if (Object.keys(idObj).sort().join(",") !== [...names].sort().join(",")) requestError(`identities must contain exactly ${names.join(", ")}`);
  const identities = {} as RemoteManagerAuthorityRequest["identities"];
  for (const name of names) {
    const item = idObj[name];
    if (item === null || typeof item !== "object" || Array.isArray(item) || Object.keys(item as object).join(",") !== "id")
      requestError(`identities.${name} must be exactly { id }`);
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || !/^U[A-Z2-7]{55}$/.test(id)) requestError(`identities.${name}.id must be a user nkey`);
    identities[name] = { id };
  }
  return {
    v: 1,
    kind: "manager-service-authority",
    operation: o.operation,
    space: o.space as string,
    actor: o.actor as string,
    instanceId: o.instanceId as string,
    managerLifecycleUid: o.managerLifecycleUid as string,
    requestId: o.requestId as string,
    ...(typeof o.registrationProof === "string" ? { registrationProof: o.registrationProof } : {}),
    ...(o.session && typeof o.session === "object" ? { session: o.session as RemoteManagerAuthorityRequest["session"] } : {}),
    ...(Array.isArray(o.contractArtifacts) ? { contractArtifacts: o.contractArtifacts } : {}),
    identities,
  };
}

/** Issue one lifecycle phase after the IdP proof and interactive row were fresh-read. */
export async function issueRemoteManagerAuthority(args: IssueRemoteManagerAuthorityArgs): Promise<RemoteManagerAuthorityMaterial> {
  const r = parseRemoteManagerAuthorityRequest(args.request);
  if (!args.scope.includes("supervise"))
    throw new EpEnvelopeError("permission-denied", 'manager-service authority needs scope "supervise"; spawn/admin do not imply it');
  const actors = remoteManagerActors(r.instanceId);
  const ids = Object.values(r.identities).map((identity) => identity.id);
  if (new Set(ids).size !== ids.length)
    throw new EpEnvelopeError("bad-request", "manager-service identities must be distinct; one nkey cannot collapse separate authority lifetimes");
  const issued = await args.issue({ owner: args.owner, actors, request: r });
  const credentials = issued.credentials;
  const required = r.operation === "prepare"
    ? ["supervisor", "executor"]
    : r.operation === "activate"
      ? ["serve", "goalWriter", "sessionLedger"]
      : r.operation === "session"
        ? ["sessionServing"]
        : ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"];
  for (const name of required)
    if (!(name in credentials))
      throw new EpEnvelopeError("internal", `manager-service ${r.operation} did not issue required credential ${name}`);
  const issuedAt = (args.now ?? Date.now)();
  const exps = Object.values(credentials).map((credential) => credential!.exp * 1000);
  return {
    v: 1,
    kind: "manager-service-authority",
    operation: r.operation,
    space: r.space,
    owner: args.owner,
    actor: r.actor,
    instanceId: r.instanceId,
    lifecycleUid: r.managerLifecycleUid,
    requestId: r.requestId,
    ...(r.registrationProof ? { registrationProof: r.registrationProof } : {}),
    issuedAt,
    expiresAt: Math.min(...exps),
    actors,
    identities: r.identities,
    ...(issued.nextRegistrationProof ? { nextRegistrationProof: issued.nextRegistrationProof } : {}),
    credentials,
  };
}
