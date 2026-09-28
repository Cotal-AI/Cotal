import {
  EpEnvelopeError,
  assertDerivedOwnerToken,
  assertLifecycleToken,
  assertValidOwnerToken,
  managedRetirementOpId,
  remoteManagerActors,
  type RemoteManagerAuthorityMaterial,
  type RemoteManagerAuthorityRequest,
} from "@cotal-ai/core";
import { timingSafeEqual } from "node:crypto";
import { remoteManagerCurrentRegistrationProof } from "./retained-manager-validation.js";

/** Host-only renewal authorization. The embedding host supplies a fresh gate and active run
 * observation from its authoritative stores, never coordinates asserted by the participant. */
export async function authorizeRemoteManagerRenewal(args: {
  request: RemoteManagerAuthorityRequest;
  owner: string;
  space: string;
  accountPublicKey: string;
  proofSecret: string | Uint8Array;
  observeManagerGate: (instanceId: string) => Promise<{
    state: "open" | "frozen" | "retired"; principal: string; processEpoch: number; registrationRevision: number;
  } | null>;
  observeRun: (runId: string) => Promise<{
    state: string; holder: string; takeoverId: string; epoch: number; fencingToken: number; instanceId: string;
  } | null>;
}): Promise<void> {
  const r = parseRemoteManagerAuthorityRequest(args.request);
  if (r.operation !== "renewStandingBundle" && r.operation !== "renewRunDriver")
    requestError("requires a renewal operation");
  if (r.space !== args.space || r.accountPublicKey !== args.accountPublicKey)
    throw new EpEnvelopeError("permission-denied", "manager-service renewal is bound to the host-assigned space and account");
  const gate = await args.observeManagerGate(r.instanceId);
  if (!gate || gate.state !== "open")
    throw new EpEnvelopeError("failed-precondition", "manager-service renewal has no open registration gate");
  if (gate.principal !== `${args.owner}.${remoteManagerActors(r.instanceId).serve}`)
    throw new EpEnvelopeError("permission-denied", "manager-service renewal gate belongs to another owner");
  if (gate.processEpoch !== r.processEpoch)
    throw new EpEnvelopeError("conflict", "manager-service renewal processEpoch is stale");
  const expected = remoteManagerCurrentRegistrationProof(args.proofSecret, args.owner, r, gate);
  if (!timingSafeEqual(Buffer.from(r.registrationProof!), Buffer.from(expected)))
    throw new EpEnvelopeError("permission-denied", "manager-service renewal proof does not match the current registration");
  if (r.operation === "renewRunDriver") {
    const run = await args.observeRun(r.run!.runId);
    if (!run || run.state !== "running" || run.instanceId !== r.instanceId || run.holder !== r.run!.holder ||
        run.takeoverId !== r.run!.takeoverId || run.epoch !== r.run!.epoch || run.fencingToken !== r.run!.fencingToken)
      throw new EpEnvelopeError("conflict", "manager-service run renewal does not hold the activated run and takeover fence");
  }
}

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
  /** The host must fresh-read the assigned account, manager gate and, for a run, activated
   * journal attempt before signing. No callback means the renewal operation is unavailable. */
  authorizeRenewal?: (args: { owner: string; request: RemoteManagerAuthorityRequest }) => Promise<void>;
  now?: () => number;
}

function requestError(what: string): never {
  throw new EpEnvelopeError("bad-request", `manager-service authority request ${what}`);
}

/** Closed request parser: unknown fields and profile-like extensions are refused, never ignored. */
export function parseRemoteManagerAuthorityRequest(raw: unknown): RemoteManagerAuthorityRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) requestError("must be an object");
  const o = raw as Record<string, unknown>;
  const allowed = new Set(["v", "kind", "operation", "space", "actor", "instanceId", "managerLifecycleUid", "requestId", "registrationProof", "session", "retirement", "contractArtifacts", "identities", "accountPublicKey", "processEpoch", "run"]);
  for (const key of Object.keys(o)) if (!allowed.has(key)) requestError(`carries unknown field ${JSON.stringify(key)} (the protocol is closed)`);
  if (o.v !== 1 || o.kind !== "manager-service-authority") requestError('must carry { v: 1, kind: "manager-service-authority" }');
  if (o.operation !== "prepare" && o.operation !== "activate" && o.operation !== "renew" && o.operation !== "session" && o.operation !== "retire" && o.operation !== "renewStandingBundle" && o.operation !== "renewRunDriver")
    requestError('operation must be "prepare", "activate", "renew", "session", "retire", "renewStandingBundle", or "renewRunDriver"');
  for (const key of ["space", "actor", "instanceId", "managerLifecycleUid", "requestId"] as const)
    if (typeof o[key] !== "string" || o[key].length === 0) requestError(`requires non-empty ${key}`);
  assertLifecycleToken(o.instanceId as string, "manager authority instanceId");
  assertLifecycleToken(o.managerLifecycleUid as string, "manager authority lifecycleUid");
  if (!/^[A-Za-z0-9_-]{22,64}$/.test(o.requestId as string)) requestError("requestId must be a 22-64 character idempotency token");
  if (o.operation === "prepare" && (o.registrationProof !== undefined || o.contractArtifacts !== undefined))
    requestError("prepare must not carry registrationProof or contractArtifacts");
  if (o.operation !== "prepare" && (typeof o.registrationProof !== "string" || !/^sha256:[0-9a-f]{64}$/.test(o.registrationProof)))
    requestError(`${o.operation} requires a sha256 registrationProof`);
  if (o.operation === "activate" && (!Array.isArray(o.contractArtifacts) || o.contractArtifacts.length === 0 || o.contractArtifacts.length > 64))
    requestError("activate requires 1-64 canonical manager contractArtifacts");
  if (o.operation !== "activate" && o.contractArtifacts !== undefined)
    requestError(`${o.operation} must not carry contractArtifacts`);
  const renewal = o.operation === "renewStandingBundle" || o.operation === "renewRunDriver";
  if (renewal) {
    if (typeof o.accountPublicKey !== "string" || !/^A[A-Z2-7]{55}$/.test(o.accountPublicKey))
      requestError(`${o.operation} requires an accountPublicKey`);
    if (typeof o.processEpoch !== "number" || !Number.isSafeInteger(o.processEpoch) || o.processEpoch < 0)
      requestError(`${o.operation} requires a non-negative processEpoch`);
  } else if (o.accountPublicKey !== undefined || o.processEpoch !== undefined)
    requestError(`${o.operation} must not carry accountPublicKey or processEpoch`);
  let run: RemoteManagerAuthorityRequest["run"];
  if (o.operation === "renewRunDriver") {
    const r = o.run as Record<string, unknown> | undefined;
    if (!r || Object.keys(r).sort().join(",") !== "driverId,epoch,fencingToken,holder,mediatorId,runId,takeoverId")
      requestError("renewRunDriver requires exactly runId, holder, takeoverId, epoch, fencingToken, driverId, mediatorId");
    if (typeof r.runId !== "string" || !/^run-[0-9a-f]{32}$/.test(r.runId) ||
        typeof r.holder !== "string" || !/^[A-Za-z0-9_.-]{1,256}$/.test(r.holder) ||
        typeof r.takeoverId !== "string" || !/^[0-9a-f]{16}$/.test(r.takeoverId) ||
        typeof r.epoch !== "number" || !Number.isSafeInteger(r.epoch) || r.epoch < 1 ||
        typeof r.fencingToken !== "number" || !Number.isSafeInteger(r.fencingToken) || r.fencingToken < 1 ||
        typeof r.driverId !== "string" || !/^U[A-Z2-7]{55}$/.test(r.driverId) ||
        typeof r.mediatorId !== "string" || !/^U[A-Z2-7]{55}$/.test(r.mediatorId) || r.driverId === r.mediatorId ||
        !r.holder.endsWith(`.${r.takeoverId}`))
      requestError("renewRunDriver requires valid runId, holder, takeoverId, epoch, fencingToken, and distinct driverId/mediatorId");
    run = r as unknown as NonNullable<RemoteManagerAuthorityRequest["run"]>;
  } else if (o.run !== undefined) requestError(`${o.operation} must not carry run`);
  if (o.operation === "session") {
    const s = o.session as Record<string, unknown> | undefined;
    if (!s || typeof s.id !== "string" || !/^U[A-Z2-7]{55}$/.test(s.id) || s.endpoint !== "manager" ||
        typeof s.sessionId !== "string" || s.sessionId.length === 0 || typeof s.epoch !== "number" || !Number.isSafeInteger(s.epoch) || s.epoch < 0 ||
        typeof s.exp !== "number" || !Number.isSafeInteger(s.exp) || s.exp <= 0)
      requestError("session requires { id, endpoint:\"manager\", sessionId, epoch, exp }");
  } else if (o.session !== undefined) requestError(`${o.operation} must not carry session`);
  let retirement: RemoteManagerAuthorityRequest["retirement"];
  if (o.operation === "retire") {
    const r = o.retirement as Record<string, unknown> | undefined;
    if (!r || Object.keys(r).sort().join(",") !== "id,opId,serveEpoch,target")
      requestError("retire requires retirement exactly { id, target, opId, serveEpoch }");
    const target = r.target as Record<string, unknown> | undefined;
    if (typeof r.id !== "string" || !/^U[A-Z2-7]{55}$/.test(r.id) ||
        !target || Object.keys(target).sort().join(",") !== "actor,lifecycleUid,owner" ||
        typeof target.owner !== "string" || typeof target.actor !== "string" || typeof target.lifecycleUid !== "string" ||
        typeof r.opId !== "string" || typeof r.serveEpoch !== "number" || !Number.isSafeInteger(r.serveEpoch) || r.serveEpoch < 0)
      requestError("retire requires a requester user nkey, exact target, lifecycle opId, and non-negative safe serveEpoch");
    assertLifecycleToken(target.lifecycleUid, "manager authority retirement target lifecycleUid");
    assertLifecycleToken(r.opId, "manager authority retirement opId");
    if (r.opId !== managedRetirementOpId(target.lifecycleUid))
      requestError(`retire opId must be the managed lifecycle's derived terminal operation id for ${target.lifecycleUid}`);
    retirement = {
      id: r.id,
      target: {
        owner: assertDerivedOwnerToken(target.owner),
        actor: assertValidOwnerToken(target.actor),
        lifecycleUid: target.lifecycleUid,
      },
      opId: r.opId,
      serveEpoch: r.serveEpoch,
    };
  } else if (o.retirement !== undefined) requestError(`${o.operation} must not carry retirement`);
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
    ...(renewal ? { accountPublicKey: o.accountPublicKey as string, processEpoch: o.processEpoch as number } : {}),
    ...(run ? { run } : {}),
    ...(o.session && typeof o.session === "object" ? { session: o.session as RemoteManagerAuthorityRequest["session"] } : {}),
    ...(retirement ? { retirement } : {}),
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
  if (r.retirement) ids.push(r.retirement.id);
  if (r.run) ids.push(r.run.driverId, r.run.mediatorId);
  if (new Set(ids).size !== ids.length)
    throw new EpEnvelopeError("bad-request", "manager-service identities must be distinct; one nkey cannot collapse separate authority lifetimes");
  if (r.operation === "renewStandingBundle" || r.operation === "renewRunDriver") {
    if (!args.authorizeRenewal)
      throw new EpEnvelopeError("unavailable", `manager-service ${r.operation} needs a host-owned current-account and duty-fence authorization`);
    await args.authorizeRenewal({ owner: args.owner, request: r });
  }
  const issued = await args.issue({ owner: args.owner, actors, request: r });
  const credentials = issued.credentials;
  const required = r.operation === "renewStandingBundle"
    ? ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"]
    : r.operation === "renewRunDriver"
      ? ["runDriver", "runMediator"]
      : r.operation === "prepare"
    ? ["supervisor", "executor"]
    : r.operation === "activate"
      ? ["serve", "goalWriter", "sessionLedger"]
      : r.operation === "renew"
        ? ["supervisor", "executor"]
      : r.operation === "session"
        ? ["sessionServing"]
        : r.operation === "retire"
          ? ["retirementRequester"]
        : ["supervisor", "executor", "serve", "goalWriter", "sessionLedger"];
  for (const name of required)
    if (!(name in credentials))
      throw new EpEnvelopeError("internal", `manager-service ${r.operation} did not issue required credential ${name}`);
  if ((r.operation === "renewStandingBundle" || r.operation === "renewRunDriver") &&
      Object.keys(credentials).sort().join(",") !== [...required].sort().join(","))
    throw new EpEnvelopeError("internal", `manager-service ${r.operation} returned credentials outside its closed profile set`);
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
    ...(r.accountPublicKey ? { accountPublicKey: r.accountPublicKey, processEpoch: r.processEpoch } : {}),
    ...(r.run ? { run: r.run } : {}),
    ...(r.retirement ? { retirement: r.retirement } : {}),
    issuedAt,
    expiresAt: Math.min(...exps),
    actors,
    identities: r.identities,
    ...(issued.nextRegistrationProof ? { nextRegistrationProof: issued.nextRegistrationProof } : {}),
    credentials,
  };
}
