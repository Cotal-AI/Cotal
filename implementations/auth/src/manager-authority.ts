import {
  EpEnvelopeError,
  REMOTE_MANAGER_IDENTITY_NAMES,
  assertDerivedOwnerToken,
  assertPrincipalOwnerToken,
  assertLifecycleToken,
  assertValidOwnerToken,
  managedRetirementOpId,
  parseRemoteManagerEnvelope,
  remoteManagerActors,
  type RemoteManagerAuthorityMaterial,
  type RemoteManagerAuthorityRequest,
  type RemoteRunAdmissionRequest,
  type RemoteRunAttemptRequest,
  type RemoteRunRevokeRequest,
  type RemoteRunRevokeResult,
  type RunRevocation,
  type RunAdmissionView,
  type RunStatusValue,
  type RunDriverGrantArgs,
  type RunOperatorGrantArgs,
  type RemoteRunAdmissionResult,
  type RunAdmission,
  type HostedRunAttempt,
  type IssuedStore,
  type IssuedSourceRef,
  type EpCommandAuthority,
  type EndpointRequest,
  EP_RAIL_V1,
  EP_UNBOUND_CALLER_AUTHORITY,
  admissionKey,
  admissionSnapshot,
  createRunAdmission,
  revokeRunAdmission,
  isAccountNkey,
  isDerivedOwner,
  isIssuedCaller,
  isUserNkey,
  issuedPermitsSubject,
  parseEpSubject,
  parseEndpointRequest,
  checkRequestSubjectAgreement,
} from "@cotal-ai/core";
import { CheckpointNotAmendable, CheckpointNotOpen, openCheckpointToken, settledPauseToken, type JournalEntry } from "@cotal-ai/lang";
import type { KV } from "@nats-io/kv";
import { timingSafeEqual } from "node:crypto";
import { remoteManagerCurrentRegistrationProof } from "./retained-manager-validation.js";
import { requireManagerAuthorityHolder, type ManagerAuthorityHolder } from "./platform-control.js";
import type { ObserveManagerGate } from "./managed-agent-enrollment.js";

/** The run attempt the host observes for itself. A null answer is a run with no record or status. */
export type ObserveManagerRun = (runId: string) => Promise<HostedRunAttempt | null>;

/** Host-only renewal authorization. The embedding host supplies a fresh gate and active run
 * observation from its authoritative stores, never coordinates asserted by the participant. */
export async function authorizeRemoteManagerRenewal(args: {
  request: RemoteManagerAuthorityRequest;
  owner: string;
  space: string;
  accountPublicKey: string;
  proofSecret: string | Uint8Array;
  observeManagerGate: ObserveManagerGate;
  observeRun: ObserveManagerRun;
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

/** Host-only typed request after the IdP proof and ledger row (a human holder) or the platform
 * control assignment (a platform holder) have been authenticated. */
export type IssueRemoteManagerAuthorityArgs = ManagerAuthorityHolder & {
  request: RemoteManagerAuthorityRequest;
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
};

function requestError(what: string): never {
  throw new EpEnvelopeError("bad-request", `manager-service authority request ${what}`);
}

/** Closed request parser: unknown fields and profile-like extensions are refused, never ignored.
 * `allowPlatform` admits a platform `p_…` retirement target owner, for the platform control holder
 * only (SPEC 13.1); the retirement check still requires the target owner to equal the holder's. */
export function parseRemoteManagerAuthorityRequest(raw: unknown, opts: { allowPlatform?: boolean } = {}): RemoteManagerAuthorityRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) requestError("must be an object");
  const o = raw as Record<string, unknown>;
  const allowed = new Set(["v", "kind", "operation", "space", "actor", "instanceId", "managerLifecycleUid", "requestId", "registrationProof", "session", "retirement", "contractArtifacts", "identities", "accountPublicKey", "processEpoch", "run", "transferReader"]);
  for (const key of Object.keys(o)) if (!allowed.has(key)) requestError(`carries unknown field ${JSON.stringify(key)} (the protocol is closed)`);
  if (o.operation !== "prepare" && o.operation !== "activate" && o.operation !== "renew" && o.operation !== "session" && o.operation !== "retire" && o.operation !== "renewStandingBundle" && o.operation !== "renewRunDriver" && o.operation !== "transferReader")
    requestError('operation must be "prepare", "activate", "renew", "session", "retire", "renewStandingBundle", "renewRunDriver", or "transferReader"');
  const envelope = parseRemoteManagerEnvelope(o, "manager-service-authority", "manager-service authority", o.operation !== "prepare");
  if (o.operation === "activate" && (!Array.isArray(o.contractArtifacts) || o.contractArtifacts.length === 0 || o.contractArtifacts.length > 64))
    requestError("activate requires 1-64 canonical manager contractArtifacts");
  if (o.operation !== "activate" && o.contractArtifacts !== undefined)
    requestError(`${o.operation} must not carry contractArtifacts`);
  const renewal = o.operation === "renewStandingBundle" || o.operation === "renewRunDriver";
  if (renewal) {
    if (!isAccountNkey(o.accountPublicKey))
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
        !isUserNkey(r.driverId) || !isUserNkey(r.mediatorId) || r.driverId === r.mediatorId ||
        !r.holder.endsWith(`.${r.takeoverId}`))
      requestError("renewRunDriver requires valid runId, holder, takeoverId, epoch, fencingToken, and distinct driverId/mediatorId");
    run = r as unknown as NonNullable<RemoteManagerAuthorityRequest["run"]>;
  } else if (o.run !== undefined) requestError(`${o.operation} must not carry run`);
  if (o.operation === "session") {
    const s = o.session as Record<string, unknown> | undefined;
    if (!s || !isUserNkey(s.id) || s.endpoint !== "manager" ||
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
    if (!isUserNkey(r.id) ||
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
        owner: opts.allowPlatform ? assertPrincipalOwnerToken(target.owner, { allowPlatform: true }) : assertDerivedOwnerToken(target.owner),
        actor: assertValidOwnerToken(target.actor),
        lifecycleUid: target.lifecycleUid,
      },
      opId: r.opId,
      serveEpoch: r.serveEpoch,
    };
  } else if (o.retirement !== undefined) requestError(`${o.operation} must not carry retirement`);
  if (o.operation === "transferReader") {
    const t = o.transferReader as Record<string, unknown> | undefined;
    if (!t || Object.keys(t).join(",") !== "id" || !isUserNkey(t.id))
      requestError("transferReader requires transferReader exactly { id } with a user nkey");
  } else if (o.transferReader !== undefined) requestError(`${o.operation} must not carry transferReader`);
  return {
    v: 1,
    kind: "manager-service-authority",
    operation: o.operation,
    ...envelope,
    ...(renewal ? { accountPublicKey: o.accountPublicKey as string, processEpoch: o.processEpoch as number } : {}),
    ...(run ? { run } : {}),
    ...(o.session && typeof o.session === "object" ? { session: o.session as RemoteManagerAuthorityRequest["session"] } : {}),
    ...(retirement ? { retirement } : {}),
    ...(o.operation === "transferReader" ? { transferReader: { id: (o.transferReader as { id: string }).id } } : {}),
    ...(Array.isArray(o.contractArtifacts) ? { contractArtifacts: o.contractArtifacts } : {}),
  };
}

/** Issue one lifecycle phase after the IdP proof and interactive row were fresh-read. */
export async function issueRemoteManagerAuthority(args: IssueRemoteManagerAuthorityArgs): Promise<RemoteManagerAuthorityMaterial> {
  const r = parseRemoteManagerAuthorityRequest(args.request, { allowPlatform: args.holder === "platform" });
  requireManagerAuthorityHolder(args, r.instanceId, 'manager-service authority needs scope "supervise"; spawn/admin do not imply it');
  const actors = remoteManagerActors(r.instanceId);
  const ids = Object.values(r.identities).map((identity) => identity.id);
  if (r.retirement) ids.push(r.retirement.id);
  if (r.transferReader) ids.push(r.transferReader.id);
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
    ? REMOTE_MANAGER_IDENTITY_NAMES
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
        : r.operation === "transferReader"
          ? ["transferReader"]
        : REMOTE_MANAGER_IDENTITY_NAMES;
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

type ManagerGate = NonNullable<Awaited<ReturnType<ObserveManagerGate>>>;

function admissionError(what: string): never {
  throw new EpEnvelopeError("bad-request", `manager run admission request ${what}`);
}

/** Closed parser for {@link RemoteRunAdmissionRequest}: unknown fields refuse, never ignored. */
export function parseRemoteRunAdmissionRequest(raw: unknown): RemoteRunAdmissionRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) admissionError("must be an object");
  const o = raw as Record<string, unknown>;
  const allowed = ["v", "kind", "space", "actor", "instanceId", "managerLifecycleUid", "requestId", "registrationProof", "accountPublicKey", "processEpoch", "identities", "run"];
  for (const k of Object.keys(o)) if (!allowed.includes(k)) admissionError(`has unknown field ${k}`);
  const envelope = parseRemoteManagerEnvelope(o, "manager-run-admission", "manager run admission");
  if (!isAccountNkey(o.accountPublicKey)) admissionError("requires an account public key");
  if (!Number.isSafeInteger(o.processEpoch) || (o.processEpoch as number) < 0) admissionError("requires a non-negative processEpoch");
  const run = o.run as Record<string, unknown> | null;
  if (run === null || typeof run !== "object" || Object.keys(run).sort().join(",") !== "runId,subject" ||
      typeof run.runId !== "string" || !/^run-[0-9a-f]{32}$/.test(run.runId) || typeof run.subject !== "string")
    admissionError("requires exactly run.runId (host-minted) and run.subject");
  return {
    v: 1, kind: "manager-run-admission", ...envelope, accountPublicKey: o.accountPublicKey, processEpoch: o.processEpoch as number,
    run: { runId: run.runId as string, subject: run.subject as string },
  };
}

/** Authenticate the requesting registered manager: assigned space/account, open gate owned by this
 *  owner's serve actor, current process epoch, and the current-registration proof. */
async function authenticateRegisteredManager(
  r: Pick<RemoteRunAdmissionRequest, "space" | "actor" | "instanceId" | "managerLifecycleUid" | "identities" | "registrationProof" | "accountPublicKey" | "processEpoch">,
  args: { owner: string; space: string; accountPublicKey: string; proofSecret: string | Uint8Array; observeManagerGate: ObserveManagerGate },
  what: string,
): Promise<ManagerGate> {
  if (r.space !== args.space || r.accountPublicKey !== args.accountPublicKey)
    throw new EpEnvelopeError("permission-denied", `manager-service ${what} is bound to the host-assigned space and account`);
  const gate = await args.observeManagerGate(r.instanceId);
  if (!gate || gate.state !== "open")
    throw new EpEnvelopeError("failed-precondition", `manager-service ${what} has no open registration gate`);
  if (gate.principal !== `${args.owner}.${remoteManagerActors(r.instanceId).serve}`)
    throw new EpEnvelopeError("permission-denied", `manager-service ${what} gate belongs to another owner`);
  if (gate.processEpoch !== r.processEpoch)
    throw new EpEnvelopeError("conflict", `manager-service ${what} processEpoch is stale`);
  const expected = remoteManagerCurrentRegistrationProof(args.proofSecret, args.owner, r, gate);
  if (!timingSafeEqual(Buffer.from(r.registrationProof!), Buffer.from(expected)))
    throw new EpEnvelopeError("permission-denied", `manager-service ${what} proof does not match the current registration`);
  return gate;
}

/**
 * Host-side first-run admission for a registered signerless manager. The manager is trusted only to
 * forward the `ep.v1` request subject it served, and only once for a request this host observed its
 * caller publish. Everything else is derived here: the caller and generation come from the
 * subject, the evidence and live sources from the issued store, the ceiling from that evidence.
 * Every refusal happens before the create; an observed forward whose run is already admitted for
 * the same caller and instance returns the admission already written.
 */
export async function admitRemoteRun(args: {
  request: unknown;
  owner: string;
  space: string;
  accountPublicKey: string;
  proofSecret: string | Uint8Array;
  endpoint: string;
  observeManagerGate: ObserveManagerGate;
  issued: IssuedStore;
  sourceIsLive: (source: IssuedSourceRef) => Promise<boolean>;
  /** Consumes the one observation of a served request subject. */
  takeObserved: (subject: string) => Promise<ObservedRunRequest | undefined>;
  admissions: KV;
  now?: () => number;
}): Promise<RemoteRunAdmissionResult> {
  const r = parseRemoteRunAdmissionRequest(args.request);
  await authenticateRegisteredManager(r, args, "run admission");
  const parsed = parseEpSubject(r.run.subject);
  if (!r.run.subject.startsWith(`cotal.${r.space}.`) || parsed === null || parsed.plane !== "request" || parsed.rail !== EP_RAIL_V1 ||
      parsed.endpoint !== args.endpoint || parsed.command !== "run-start" || parsed.target !== null ||
      (parsed.route === "inst" && parsed.instanceId !== r.instanceId) || !isIssuedCaller(parsed.caller))
    throw new EpEnvelopeError("permission-denied", "manager run admission needs the served v1 run-start subject of this space, endpoint and instance with an issued caller");
  // The subject's caller is the broker's word only if the broker carried it: a manager can name any
  // live issuance in a subject it never received.
  if ((await args.takeObserved(r.run.subject)) === undefined)
    throw new EpEnvelopeError("permission-denied", "the issuing host did not observe this run-start request, or already admitted a forward of it (SPEC 14.8)");
  const caller = parsed.caller;
  if (isDerivedOwner(caller.owner) && caller.owner !== args.owner)
    throw new EpEnvelopeError("permission-denied", "a user's run is admitted only on the participant manager that user registered");
  const ref = { space: r.space, owner: caller.owner, actor: caller.actor, uid: caller.uid, generation: caller.generation };
  const resolved = await args.issued.resolve(ref, args.sourceIsLive);
  const e = resolved.evidence.ref;
  if (e.space !== ref.space || e.owner !== ref.owner || e.actor !== ref.actor || e.uid !== ref.uid || e.generation !== ref.generation)
    throw new EpEnvelopeError("permission-denied", "manager run admission evidence names another issued reference");
  if (!issuedPermitsSubject(resolved.evidence.permissions.publish, r.run.subject))
    throw new EpEnvelopeError("permission-denied", "the caller's issued ceiling does not permit this run-start subject");
  const admission: RunAdmission = {
    version: 1, space: r.space, endpoint: args.endpoint, runId: r.run.runId, instanceId: r.instanceId,
    caller, ceiling: resolved.evidence.permissions,
    provenance: { kind: "issued", ref, resolvedRevision: resolved.revision },
    admittedAt: (args.now ?? Date.now)(),
  };
  try {
    const revision = await createRunAdmission(args.admissions, admission);
    return { v: 1, kind: "manager-run-admission", requestId: r.requestId, runId: r.run.runId, revision, admission: admissionSnapshot(admission) };
  } catch (err) {
    if (!(err instanceof EpEnvelopeError) || err.code !== "conflict") throw err;
    const entry = await args.admissions.get(admissionKey(args.endpoint, r.run.runId));
    if (entry === null) throw err;
    const written = admissionSnapshot(JSON.parse(new TextDecoder().decode(entry.value)));
    const p = written.provenance;
    if (written.instanceId !== r.instanceId || p.kind !== "issued" || p.ref.owner !== ref.owner || p.ref.actor !== ref.actor ||
        p.ref.uid !== ref.uid || p.ref.generation !== ref.generation)
      throw new EpEnvelopeError("conflict", `run ${r.run.runId} is already admitted for another caller or instance`);
    return { v: 1, kind: "manager-run-admission", requestId: r.requestId, runId: r.run.runId, revision: entry.revision, admission: written };
  }
}

const ID_TOKEN = /^[A-Za-z0-9_-]{1,64}$/;

/** Closed parser for the issuing-host revoke. It carries no asserted owner or attribution. */
export function parseRemoteRunRevokeRequest(raw: unknown): RemoteRunRevokeRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) admissionError("must be an object");
  const o = raw as Record<string, unknown>;
  if (o.kind !== "manager-run-revoke") admissionError("must be v1 manager-run-revoke");
  const allowed = ["v", "kind", "space", "actor", "instanceId", "managerLifecycleUid", "requestId", "registrationProof", "accountPublicKey", "processEpoch", "identities", "revoke"];
  for (const key of Object.keys(o)) if (!allowed.includes(key)) admissionError(`has unknown field ${key}`);
  const { revoke, ...rest } = o;
  const base = parseRemoteRunAdmissionRequest({ ...rest, kind: "manager-run-admission", run: { runId: `run-${"0".repeat(32)}`, subject: "" } });
  if (revoke === null || typeof revoke !== "object" || Array.isArray(revoke)) admissionError("requires revoke");
  const r = revoke as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "reason,runId" || typeof r.runId !== "string" || !/^run-[0-9a-f]{32}$/.test(r.runId) ||
      typeof r.reason !== "string" || r.reason.length === 0) admissionError("requires exactly revoke.runId and a non-empty revoke.reason");
  const { run: _run, ...registered } = base;
  return { ...registered, kind: "manager-run-revoke", revoke: { runId: r.runId, reason: r.reason } };
}

/** The door has authenticated the holder and read its current scope. The run's owner comes only
 * from the recorded admission. A platform assignment is not an admin grant. */
export async function revokeRemoteRun(args: ManagerAuthorityHolder & {
  request: unknown;
  space: string;
  endpoint: string;
  accountPublicKey: string;
  proofSecret: string | Uint8Array;
  observeManagerGate: ObserveManagerGate;
  readAdmission: (runId: string) => Promise<RunAdmissionView>;
  readRevocation: (runId: string) => Promise<RunRevocation | undefined>;
  admissions: KV;
  now?: () => number;
}): Promise<RemoteRunRevokeResult> {
  const r = parseRemoteRunRevokeRequest(args.request);
  const view = await args.readAdmission(r.revoke.runId);
  if (view.admission.instanceId !== r.instanceId)
    throw new EpEnvelopeError("permission-denied", `run ${r.revoke.runId} was admitted on another manager instance; revoke refused`);
  if (args.holder === "platform" || (view.admission.caller.owner !== args.owner && !args.scope.includes("admin")))
    throw new EpEnvelopeError("permission-denied", `run ${r.revoke.runId}: revoke requires its admitted owner or a platform admin`);
  // An admin may act for another owner, but the proof is still that registered manager's proof.
  const gate = await args.observeManagerGate(r.instanceId);
  const suffix = `.${remoteManagerActors(r.instanceId).serve}`;
  if (!gate || !gate.principal.endsWith(suffix))
    throw new EpEnvelopeError("failed-precondition", "manager run revoke has no current registered manager principal");
  const managerOwner = gate.principal.slice(0, -suffix.length);
  await authenticateRegisteredManager(r, { ...args, owner: managerOwner }, "run revoke");
  await revokeRunAdmission(args.admissions, args.endpoint, {
    version: 1, runId: r.revoke.runId, by: `${args.owner}.${r.actor}`, reason: r.revoke.reason, revokedAt: (args.now ?? Date.now)(),
  });
  const revocation = await args.readRevocation(r.revoke.runId);
  if (revocation === undefined) throw new EpEnvelopeError("internal", `run ${r.revoke.runId}: revoke wrote no readable marker`);
  return { v: 1, kind: "manager-run-revoke", requestId: r.requestId, runId: r.revoke.runId, revocation };
}

/** Closed parser for {@link RemoteRunAttemptRequest}. */
export function parseRemoteRunAttemptRequest(raw: unknown): RemoteRunAttemptRequest {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) admissionError("must be an object");
  const o = raw as Record<string, unknown>;
  if (o.kind !== "manager-run-attempt") admissionError("must be v1 manager-run-attempt");
  const { attempt, operator, ...rest } = o;
  if ((attempt === undefined) === (operator === undefined)) admissionError("carries exactly one of attempt or operator");
  const base = parseRemoteRunAdmissionRequest({ ...rest, kind: "manager-run-admission", run: { runId: `run-${"0".repeat(32)}`, subject: "" } });
  const { run: _run, kind: _kind, ...registered } = base;
  const plain = (v: unknown, keys: string[], optional: string[] = []) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) admissionError("attempt/operator must be an object");
    const k = Object.keys(v as object);
    if (k.some((x) => !keys.includes(x) && !optional.includes(x)) || keys.some((x) => !k.includes(x))) admissionError(`attempt/operator must carry exactly ${keys.join(", ")}`);
    return v as Record<string, unknown>;
  };
  const runIdOk = (v: unknown) => typeof v === "string" && /^run-[0-9a-f]{32}$/.test(v);
  const servedOk = (v: unknown) => v === undefined || (typeof v === "string" && v.length > 0 && v.length <= 1024);
  if (attempt !== undefined) {
    const a = plain(attempt, ["runId", "takeoverId", "epoch", "fencingToken", "driverId", "mediatorId"], ["served"]);
    if (!runIdOk(a.runId) || typeof a.takeoverId !== "string" || !ID_TOKEN.test(a.takeoverId) ||
        !Number.isSafeInteger(a.epoch) || (a.epoch as number) < 1 || !Number.isSafeInteger(a.fencingToken) || (a.fencingToken as number) < 1 ||
        !isUserNkey(a.driverId) || !isUserNkey(a.mediatorId) || a.driverId === a.mediatorId)
      admissionError("attempt requires a run id, takeover id, positive epoch/fencingToken and distinct driver/mediator nkeys");
    if (!servedOk(a.served)) admissionError("attempt served must be a request subject");
    return { ...registered, kind: "manager-run-attempt", attempt: { runId: a.runId as string, takeoverId: a.takeoverId, epoch: a.epoch as number, fencingToken: a.fencingToken as number, driverId: a.driverId, mediatorId: a.mediatorId, ...(a.served !== undefined ? { served: a.served as string } : {}) } };
  }
  const op = plain(operator, ["id", "takeoverId"], ["runId", "answers", "served"]);
  if (!isUserNkey(op.id) || typeof op.takeoverId !== "string" || !ID_TOKEN.test(op.takeoverId) ||
      (op.runId !== undefined && !runIdOk(op.runId)))
    admissionError("operator requires an nkey id, a takeover id and an optional run id");
  let answers: { runId: string; stepKey: string; amend?: true } | undefined;
  if (op.answers !== undefined) {
    const t = plain(op.answers, ["runId", "stepKey"], ["amend"]);
    if (!runIdOk(t.runId) || typeof t.stepKey !== "string" || t.stepKey.length === 0 || t.stepKey.length > 1024 || op.runId !== undefined ||
        (t.amend !== undefined && t.amend !== true))
      admissionError("operator answers carries the run id and step key of one pause, an optional amend: true and no outer run id");
    answers = { runId: t.runId as string, stepKey: t.stepKey, ...(t.amend === true ? { amend: true as const } : {}) };
  }
  if (!servedOk(op.served) || (op.served !== undefined && answers === undefined))
    admissionError("operator served is the run-answer subject, and only an answering operator carries one");
  return { ...registered, kind: "manager-run-attempt", operator: { id: op.id, takeoverId: op.takeoverId, ...(op.runId !== undefined ? { runId: op.runId as string } : {}), ...(answers ? { answers } : {}), ...(op.served !== undefined ? { served: op.served as string } : {}) } };
}

/** What a served resume or answer asks the host to issue for: a resume names its run, an answer
 *  the endpoint it answers on, the run and step whose pause it answers, and whether it amends
 *  (SPEC 14.8). */
export type RunRequestOperation =
  | { command: "run-resume"; runId: string }
  | { command: "run-answer"; endpoint: string; runId: string; stepKey: string; amend: boolean };

/** A served run-start, resume or answer as its caller published it: the operation, and the class,
 *  pinned contract and `bind` of its envelope. A manager registered with another class or contract,
 *  or serving at another incarnation than the bound one, refuses it unrun (SPEC 13.2, 13.7). */
export interface ObservedRunRequest {
  operation: RunRequestOperation | { command: "run-start" };
  envelope: Pick<EndpointRequest, "class" | "op" | "bind">;
}

/** The run-start, resume or answer request its caller published on `subject`, or undefined for a
 *  request no manager serves. */
export function observedRunRequest(subject: string, data: Uint8Array): ObservedRunRequest | undefined {
  const parsed = parseEpSubject(subject);
  if (parsed === null || parsed.plane !== "request") return undefined;
  let env: EndpointRequest;
  try {
    env = parseEndpointRequest(JSON.parse(new TextDecoder().decode(data)));
    checkRequestSubjectAgreement(env, parsed);
  } catch {
    return undefined;
  }
  const envelope = { class: env.class, op: env.op, bind: env.bind };
  if (parsed.command === "run-start") return { operation: { command: "run-start" }, envelope };
  const args = env.args;
  if (args === null || args === undefined || typeof args.runId !== "string") return undefined;
  if (parsed.command === "run-resume") return { operation: { command: "run-resume", runId: args.runId }, envelope };
  if (parsed.command !== "run-answer") return undefined;
  const endpoint = args.endpoint ?? parsed.endpoint;
  if (typeof endpoint !== "string" || typeof args.stepKey !== "string" || (args.amend !== undefined && typeof args.amend !== "boolean")) return undefined;
  return { operation: { command: "run-answer", endpoint, runId: args.runId, stepKey: args.stepKey, amend: args.amend === true }, envelope };
}

/** The served caller of a resume or an answer, checked against the run's owner (SPEC 14.8). The
 *  subject is re-parsed as {@link admitRemoteRun} parses a run-start, except that the `self` target
 *  a `run-answer` rides is accepted, and must be a request this host observed and has not yet
 *  accepted a forward of, asking for `operation`, bound to no other manager incarnation than
 *  `instanceId` at `processEpoch`, and declaring the class and pinning the contract the manager
 *  registered at `registrationRevision` declares for it. A derived user owner must be
 *  `runOwner`; a v1 caller's issuance must resolve live and permit the subject; a legacy caller is
 *  accepted only for `run-answer` from a live managed row of that owner, the seat relay path. */
async function authorizeServedRunCaller(args: {
  served: string;
  operation: RunRequestOperation;
  /** The admission's owner for a resume; the manager's registered owner for an answer. */
  runOwner: string;
  space: string;
  endpoint: string;
  instanceId: string;
  /** The registered manager's process epoch, the epoch it serves at. */
  processEpoch: number;
  registrationRevision: number;
  issued: IssuedStore;
  sourceIsLive: (source: IssuedSourceRef) => Promise<boolean>;
  isLiveManagedActor: (owner: string, actor: string, lifecycleUid: string) => boolean;
  takeObserved: (subject: string) => Promise<ObservedRunRequest | undefined>;
  registeredCommand: RegisteredRunCommand;
}): Promise<void> {
  const command = args.operation.command;
  const parsed = parseEpSubject(args.served);
  if (!args.served.startsWith(`cotal.${args.space}.`) || parsed === null || parsed.plane !== "request" ||
      parsed.endpoint !== args.endpoint || parsed.command !== command || (parsed.target !== null && parsed.target.mode !== "self") ||
      (parsed.route === "inst" && parsed.instanceId !== args.instanceId))
    throw new EpEnvelopeError("permission-denied", `a served ${command} must name this space, endpoint and instance, untargeted or self-targeted`);
  // The subject's caller is the broker's word only if the broker carried it: a manager can name any
  // live issuance in a subject it never received.
  const observation = await args.takeObserved(args.served);
  if (observation === undefined)
    throw new EpEnvelopeError("permission-denied", `the issuing host did not observe this ${command} request, or already accepted a forward of it (SPEC 14.8)`);
  // The forward's coordinates are the manager's word; the observed request's are the caller's.
  const forwarded = args.operation, observed = observation.operation;
  if (observed.command === "run-resume"
    ? forwarded.command !== "run-resume" || forwarded.runId !== observed.runId
    : observed.command !== "run-answer" || forwarded.command !== "run-answer" || forwarded.endpoint !== observed.endpoint || forwarded.runId !== observed.runId ||
      forwarded.stepKey !== observed.stepKey || forwarded.amend !== observed.amend)
    throw new EpEnvelopeError("permission-denied", `the forwarded ${command} names another run, step, endpoint or amendment than the request the issuing host observed (SPEC 14.8)`);
  // The manager serving at another incarnation than the bound one refuses the request unrun, so a
  // forward of it must not turn into authority for the incarnation registered now.
  const { bind, class: declaredClass, op } = observation.envelope;
  if (bind !== undefined && (bind.instanceId !== args.instanceId || bind.epoch !== args.processEpoch))
    throw new EpEnvelopeError("permission-denied", `the observed ${command} request is bound to another manager instance or epoch than the registered one, which refuses it unrun (SPEC 13.2, 14.8)`);
  // It also refuses unrun a request whose class or pinned contract is not the one it registered.
  const registered = await args.registeredCommand(args.instanceId, args.registrationRevision, command);
  if (declaredClass !== registered.class || op.inputDigest !== registered.inputDigest || op.outputDigest !== registered.outputDigest)
    throw new EpEnvelopeError("permission-denied", `the observed ${command} request declares another class or pins another contract than the registered manager serves, which refuses it unrun (SPEC 13.7, 14.8)`);
  const caller = parsed.caller;
  if (isDerivedOwner(caller.owner) && caller.owner !== args.runOwner)
    throw new EpEnvelopeError("permission-denied", "a user resumes only a run admitted for that user and answers only on the participant manager that user registered");
  if (parsed.rail === EP_RAIL_V1 && isIssuedCaller(caller)) {
    const ref = { space: args.space, owner: caller.owner, actor: caller.actor, uid: caller.uid, generation: caller.generation };
    const resolved = await args.issued.resolve(ref, args.sourceIsLive);
    if (!issuedPermitsSubject(resolved.evidence.permissions.publish, args.served))
      throw new EpEnvelopeError("permission-denied", `the caller's issued ceiling does not permit this ${command} subject`);
    return;
  }
  if (command === "run-answer" && caller.owner === args.runOwner && args.isLiveManagedActor(caller.owner, caller.actor, caller.uid)) return;
  throw new EpEnvelopeError("permission-denied", `${command} on a participant manager rides the versioned rail with an issued caller; only a live managed seat of the run's owner answers on the legacy rail (SPEC 14.8)`,
    [{ kind: EP_UNBOUND_CALLER_AUTHORITY, owner: caller.owner, actor: caller.actor, uid: caller.uid }]);
}

/** The registered manager's declaration of a served command at a registration revision: the class
 *  and contract its serving endpoint admits. */
export type RegisteredRunCommand = (
  instanceId: string,
  registrationRevision: number,
  command: RunRequestOperation["command"],
) => Promise<Pick<EpCommandAuthority, "class" | "inputDigest" | "outputDigest">>;

/** What the host then signs, and nothing else: one fixed profile per caller-held nkey. */
export type RemoteRunAttemptGrant =
  | { kind: "attempt"; driver: { id: string; profile: "run-driver"; runDriver: RunDriverGrantArgs }; mediator: { id: string; profile: "run-mediator"; runMediator: RunDriverGrantArgs } }
  | { kind: "operator"; operator: { id: string; profile: "run-operator"; runOperator: RunOperatorGrantArgs } };

/**
 * Host-only authorization for {@link RemoteRunAttemptRequest}. Every coordinate the returned grant
 * pins is derived from host stores: the admission must exist unrevoked on this instance, the
 * attempt must be exactly the next epoch/fencing token the run record implies (1/1 for a first
 * attempt with no record, as stock `start` launches), and an answer pins the pause the named run's
 * journal records at the named step, which must be waiting. Refuses before the host signs anything.
 */
export async function authorizeRemoteRunAttempt(args: {
  request: unknown;
  owner: string;
  space: string;
  accountPublicKey: string;
  proofSecret: string | Uint8Array;
  endpoint: string;
  observeManagerGate: ObserveManagerGate;
  readAdmission: (runId: string) => Promise<RunAdmissionView>;
  readRunStatus: (runId: string) => Promise<RunStatusValue | undefined>;
  /** The named run's journal step entries, in append order: what an answer's pause is read off. */
  readJournal: (runId: string) => Promise<readonly JournalEntry[]>;
  checkpointWaiting: (token: string) => Promise<boolean>;
  /** Whether the pause settled `resumed` naming an accepted answer: what an amendment amends. */
  checkpointSettled: (token: string) => Promise<boolean>;
  /** The issued store, the source and ledger checks, the observed requests and the registered
   *  declarations a request carrying `served` is checked with. `takeObserved` consumes the one
   *  observation of a subject and returns what its request asked for. */
  issued?: IssuedStore;
  sourceIsLive?: (source: IssuedSourceRef) => Promise<boolean>;
  isLiveManagedActor?: (owner: string, actor: string, lifecycleUid: string) => boolean;
  takeObserved?: (subject: string) => Promise<ObservedRunRequest | undefined>;
  registeredCommand?: RegisteredRunCommand;
}): Promise<RemoteRunAttemptGrant> {
  const r = parseRemoteRunAttemptRequest(args.request);
  const gate = await authenticateRegisteredManager(r, args, "run attempt");
  const admitted = async (runId: string) => {
    const view = await args.readAdmission(runId);
    if (view.revoked !== undefined)
      throw new EpEnvelopeError("permission-denied", `run ${runId} was revoked; a revoked run is issued nothing (SPEC 14.8)`);
    if (view.admission.instanceId !== r.instanceId || view.admission.endpoint !== args.endpoint || view.admission.space !== r.space)
      throw new EpEnvelopeError("permission-denied", `run ${runId} was admitted on another manager instance or endpoint`);
    return view.admission;
  };
  const served = (subject: string, operation: RunRequestOperation, runOwner: string) => {
    if (args.issued === undefined || args.sourceIsLive === undefined || args.isLiveManagedActor === undefined || args.takeObserved === undefined ||
        args.registeredCommand === undefined)
      throw new EpEnvelopeError("internal", "a served run request needs the issued store, the actor ledger, the observed requests and the registered declarations on the issuing host");
    return authorizeServedRunCaller({
      served: subject, operation, runOwner, space: r.space, endpoint: args.endpoint, instanceId: r.instanceId, processEpoch: r.processEpoch,
      registrationRevision: gate.registrationRevision,
      issued: args.issued, sourceIsLive: args.sourceIsLive, isLiveManagedActor: args.isLiveManagedActor, takeObserved: args.takeObserved,
      registeredCommand: args.registeredCommand,
    });
  };
  if (r.attempt) {
    const a = r.attempt;
    const admission = await admitted(a.runId);
    if (a.served !== undefined) await served(a.served, { command: "run-resume", runId: a.runId }, admission.caller.owner);
    const status = await args.readRunStatus(a.runId);
    if (status?.state === "completed" || status?.state === "failed")
      throw new EpEnvelopeError("failed-precondition", `run ${a.runId} is ${status.state}; a terminal run gets no new attempt`);
    if (a.epoch !== (status?.epoch ?? 0) + 1 || a.fencingToken !== (status?.fencingToken ?? 0) + 1)
      throw new EpEnvelopeError("conflict", `run ${a.runId} attempt must be the next recorded epoch/fencing token`);
    const pin: RunDriverGrantArgs = { endpoint: args.endpoint, runId: a.runId, owner: admission.caller.owner, takeoverId: a.takeoverId, instanceId: r.instanceId, epoch: a.epoch };
    // The host never sees the program, and the only instance a signerless manager places a spawn on
    // is its own, so the mediator is pinned there; that row reaches no manager the class row does not.
    return { kind: "attempt", driver: { id: a.driverId, profile: "run-driver", runDriver: pin }, mediator: { id: a.mediatorId, profile: "run-mediator", runMediator: { ...pin, placement: { instanceId: r.instanceId } } } };
  }
  const op = r.operator!;
  if (op.runId !== undefined) await admitted(op.runId);
  let token: string | undefined;
  if (op.answers !== undefined) {
    const { runId, stepKey } = op.answers, amend = op.answers.amend === true;
    await admitted(runId);
    // The token is read off the run's own journal, never taken from the manager: every manager
    // instance's pauses share one token namespace, so a named token could be another run's.
    token = pauseToken(await args.readJournal(runId), runId, stepKey, amend);
    // The pause is checked first, then the caller. An answer needs a waiting pause; an amendment
    // needs the pause whose answer was accepted, and nothing else.
    if (amend ? !(await args.checkpointSettled(token)) : !(await args.checkpointWaiting(token)))
      throw new EpEnvelopeError("failed-precondition", amend
        ? "run operator amends only a checkpoint whose answer was accepted"
        : "run operator answers only a checkpoint that is still waiting");
    // Every answer and amendment names the caller it serves; the host never answers for the manager.
    if (op.served === undefined)
      throw new EpEnvelopeError("permission-denied", "an answering run operator carries the served run-answer subject of the caller it answers for (SPEC 14.8)");
    await served(op.served, { command: "run-answer", endpoint: args.endpoint, runId, stepKey, amend }, args.owner);
  }
  const runOperator: RunOperatorGrantArgs = { endpoint: args.endpoint, takeoverId: op.takeoverId, ...(op.runId !== undefined ? { runId: op.runId } : {}), ...(token !== undefined ? { answers: { token } } : {}) };
  return { kind: "operator", operator: { id: op.id, profile: "run-operator", runOperator } };
}

/** The token of the pause at `stepKey`: the open one for an answer, the settled one for an amendment. */
function pauseToken(entries: readonly JournalEntry[], runId: string, stepKey: string, amend: boolean): string {
  try {
    if (!amend) return openCheckpointToken(entries, runId, stepKey);
    const token = settledPauseToken(entries, runId, stepKey);
    if (token === undefined) throw new CheckpointNotAmendable(runId, stepKey, "unanswered");
    return token;
  } catch (e) {
    if (e instanceof CheckpointNotOpen || e instanceof CheckpointNotAmendable) throw new EpEnvelopeError("failed-precondition", e.message);
    throw e;
  }
}
