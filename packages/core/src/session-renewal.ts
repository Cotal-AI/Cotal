import { fromPublic, fromSeed } from "@nats-io/nkeys";
import { canonicalJson } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-envelope.js";
import { credsFromJwt, type Identity } from "./identity.js";
import { mintRenewableSessionAgentJwt, STANDING_RENEWABLE_TTL_SEC, type CredentialKind, type SpaceAuth } from "./provision.js";
import { parseResourceKey, resourceKeyId, type ResourceKey } from "./session-lifecycle-records.js";
import { assertLifecycleToken, assertValidOwnerToken, patternInAllow } from "./subjects.js";

/** Exact operator copy required by #783 §6 until every released session uses independent renewal. */
export const MESH_RELEASE_RENEWAL_OPERATOR_COPY =
  "Native-only release is available on certified providers. Mesh-preserving release is blocked for manager-renewed credential families.";

export const SESSION_RENEWAL_REQUEST_MAX_AGE_MS = 60_000;
export const INDEPENDENT_SESSION_CREDENTIAL_FAMILY = "session-agent" as const;
export const INDEPENDENT_SESSION_RENEWAL_OWNER = "auth-service" as const;

export interface SessionRenewalAuthority {
  readonly allowSubscribe: readonly string[];
  readonly allowPublish: readonly string[];
  readonly capabilities: readonly string[];
  readonly role?: string;
}

/**
 * Server-side owner authorization for exactly one native session's mesh identity.
 *
 * This is a trusted auth-service record, not a bearer that grants generic mint access. The holder
 * receives only its opaque `capabilityId`. The account signing key never crosses the service seam.
 */
export interface SessionRenewalCapability {
  readonly v: 1;
  readonly kind: "session-renewal-capability";
  readonly capabilityId: string;
  readonly credentialFamily: typeof INDEPENDENT_SESSION_CREDENTIAL_FAMILY;
  readonly renewalOwner: typeof INDEPENDENT_SESSION_RENEWAL_OWNER;
  readonly space: string;
  readonly resourceKey: ResourceKey;
  readonly owner: string;
  readonly actor: string;
  readonly lifecycleUid: string;
  readonly publicId: string;
  readonly ceiling: SessionRenewalAuthority;
  readonly credentialTtlSeconds: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface SessionRenewalRequest {
  readonly v: 1;
  readonly kind: "session-renewal";
  readonly capabilityId: string;
  readonly space: string;
  readonly resourceKey: ResourceKey;
  readonly owner: string;
  readonly actor: string;
  readonly lifecycleUid: string;
  readonly publicId: string;
  readonly requestId: string;
  readonly requestedAt: number;
  readonly proof: string;
}

export interface SessionRenewalMaterial {
  readonly v: 1;
  readonly kind: "session-renewal-material";
  readonly capabilityId: string;
  readonly credentialFamily: typeof INDEPENDENT_SESSION_CREDENTIAL_FAMILY;
  readonly renewalOwner: typeof INDEPENDENT_SESSION_RENEWAL_OWNER;
  readonly publicId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly jwt: string;
}

export type SessionCredentialReleaseClassification =
  | { readonly status: "independently-renewable"; readonly family: CredentialKind; readonly renewalOwner: string }
  | { readonly status: "release-blocker"; readonly family: CredentialKind; readonly renewalOwner: string; readonly reason: string }
  | { readonly status: "not-session-identity"; readonly family: CredentialKind; readonly renewalOwner: string; readonly reason: string };

const PROFILE_ID = /^[U][A-Z2-7]{55}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{22,64}$/;
const PROOF = /^[A-Za-z0-9_-]{86}$/;
const isRec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const CAP_FIELDS = new Set(["v", "kind", "capabilityId", "credentialFamily", "renewalOwner", "space", "resourceKey", "owner", "actor", "lifecycleUid", "publicId", "ceiling", "credentialTtlSeconds", "issuedAt", "expiresAt"]);
const AUTH_FIELDS = new Set(["allowSubscribe", "allowPublish", "capabilities", "role"]);
const REQ_FIELDS = new Set(["v", "kind", "capabilityId", "space", "resourceKey", "owner", "actor", "lifecycleUid", "publicId", "requestId", "requestedAt", "proof"]);

function refuse(code: "bad-request" | "permission-denied" | "expired" | "failed-precondition" | "internal", message: string): never {
  throw new EpEnvelopeError(code, message);
}
function closed(o: Record<string, unknown>, fields: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(o)) if (!fields.has(key)) refuse("bad-request", `${label} carries unknown field ${JSON.stringify(key)} (the protocol is closed)`);
}
function uint(v: unknown, label: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) return refuse("bad-request", `${label} must be a non-negative safe integer`);
  return v;
}
function text(v: unknown, label: string): string {
  if (typeof v !== "string" || v.length === 0) return refuse("bad-request", `${label} must be a non-empty string`);
  return v;
}
function token(v: unknown, label: string): string {
  const s = text(v, label);
  if (!REQUEST_ID.test(s)) return refuse("bad-request", `${label} must be a 22-64 character idempotency token`);
  return s;
}
function publicId(v: unknown, label: string): string {
  const s = text(v, label);
  if (!PROFILE_ID.test(s)) return refuse("bad-request", `${label} must be a user nkey`);
  return s;
}
function principal(ownerValue: unknown, actorValue: unknown, label: string): { owner: string; actor: string } {
  const owner = assertValidOwnerToken(text(ownerValue, `${label}.owner`));
  const actor = assertValidOwnerToken(text(actorValue, `${label}.actor`));
  return { owner, actor };
}
function strings(v: unknown, label: string): readonly string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string") || new Set(v).size !== v.length)
    return refuse("bad-request", `${label} must be a unique string array`);
  return Object.freeze([...(v as string[])]);
}
function authority(value: unknown, label: string): SessionRenewalAuthority {
  if (!isRec(value)) return refuse("bad-request", `${label} must be an object`);
  closed(value, AUTH_FIELDS, label);
  const capabilities = strings(value.capabilities, `${label}.capabilities`);
  if (capabilities.includes("supervise"))
    refuse("permission-denied", "session renewal authority must never include supervise; renewal is not management authority");
  return Object.freeze({
    allowSubscribe: strings(value.allowSubscribe, `${label}.allowSubscribe`),
    allowPublish: strings(value.allowPublish, `${label}.allowPublish`),
    capabilities,
    ...(value.role === undefined ? {} : { role: text(value.role, `${label}.role`) }),
  });
}

/** Create the trusted record only after the auth service authenticated the resource owner. */
export function issueSessionRenewalCapability(args: {
  authenticatedOwner: string;
  capabilityId: string;
  space: string;
  resourceKey: ResourceKey;
  owner: string;
  actor: string;
  lifecycleUid: string;
  publicId: string;
  ceiling: SessionRenewalAuthority;
  credentialTtlSeconds?: number;
  issuedAt: number;
  expiresAt: number;
}): SessionRenewalCapability {
  const p = principal(args.owner, args.actor, "session renewal target");
  if (args.authenticatedOwner !== p.owner)
    refuse("permission-denied", "session renewal capability owner does not match the authenticated resource owner");
  const issuedAt = uint(args.issuedAt, "session renewal capability issuedAt");
  const expiresAt = uint(args.expiresAt, "session renewal capability expiresAt");
  if (expiresAt <= issuedAt) refuse("bad-request", "session renewal capability expiresAt must be after issuedAt");
  const ttl = args.credentialTtlSeconds ?? STANDING_RENEWABLE_TTL_SEC;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > STANDING_RENEWABLE_TTL_SEC)
    refuse("bad-request", `session renewal credential TTL must be 1-${STANDING_RENEWABLE_TTL_SEC} seconds`);
  const cap: SessionRenewalCapability = {
    v: 1,
    kind: "session-renewal-capability",
    capabilityId: token(args.capabilityId, "session renewal capabilityId"),
    credentialFamily: INDEPENDENT_SESSION_CREDENTIAL_FAMILY,
    renewalOwner: INDEPENDENT_SESSION_RENEWAL_OWNER,
    space: text(args.space, "session renewal space"),
    resourceKey: parseResourceKey(args.resourceKey),
    owner: p.owner,
    actor: p.actor,
    lifecycleUid: assertLifecycleToken(args.lifecycleUid, "session renewal lifecycleUid"),
    publicId: publicId(args.publicId, "session renewal publicId"),
    ceiling: authority(args.ceiling, "session renewal ceiling"),
    credentialTtlSeconds: ttl,
    issuedAt,
    expiresAt,
  };
  return Object.freeze({ ...cap, resourceKey: Object.freeze({ ...cap.resourceKey }) });
}

export function parseSessionRenewalCapability(value: unknown): SessionRenewalCapability {
  if (!isRec(value)) return refuse("bad-request", "session renewal capability must be an object");
  closed(value, CAP_FIELDS, "session renewal capability");
  if (value.v !== 1 || value.kind !== "session-renewal-capability" || value.credentialFamily !== INDEPENDENT_SESSION_CREDENTIAL_FAMILY || value.renewalOwner !== INDEPENDENT_SESSION_RENEWAL_OWNER)
    refuse("bad-request", "session renewal capability version/kind/family/owner does not validate");
  return issueSessionRenewalCapability({
    authenticatedOwner: text(value.owner, "session renewal capability.owner"),
    capabilityId: text(value.capabilityId, "session renewal capability.capabilityId"),
    space: text(value.space, "session renewal capability.space"),
    resourceKey: parseResourceKey(value.resourceKey),
    owner: text(value.owner, "session renewal capability.owner"),
    actor: text(value.actor, "session renewal capability.actor"),
    lifecycleUid: text(value.lifecycleUid, "session renewal capability.lifecycleUid"),
    publicId: text(value.publicId, "session renewal capability.publicId"),
    ceiling: authority(value.ceiling, "session renewal capability.ceiling"),
    credentialTtlSeconds: uint(value.credentialTtlSeconds, "session renewal capability.credentialTtlSeconds"),
    issuedAt: uint(value.issuedAt, "session renewal capability.issuedAt"),
    expiresAt: uint(value.expiresAt, "session renewal capability.expiresAt"),
  });
}

function proofInput(request: Omit<SessionRenewalRequest, "proof">): Uint8Array {
  return new TextEncoder().encode(canonicalJson(request));
}

/** Connector-side proof. The local user nkey signs each request and never leaves the connector. */
export function createSessionRenewalRequest(
  identity: Identity,
  input: Omit<SessionRenewalRequest, "v" | "kind" | "publicId" | "proof">,
): SessionRenewalRequest {
  if (fromSeed(new TextEncoder().encode(identity.seed)).getPublicKey() !== identity.id)
    throw new Error("session renewal identity seed does not match its public id");
  const unsigned: Omit<SessionRenewalRequest, "proof"> = {
    v: 1,
    kind: "session-renewal",
    capabilityId: input.capabilityId,
    space: input.space,
    resourceKey: input.resourceKey,
    owner: input.owner,
    actor: input.actor,
    lifecycleUid: input.lifecycleUid,
    publicId: identity.id,
    requestId: input.requestId,
    requestedAt: input.requestedAt,
  };
  const proof = Buffer.from(fromSeed(new TextEncoder().encode(identity.seed)).sign(proofInput(unsigned))).toString("base64url");
  return Object.freeze({ ...unsigned, resourceKey: Object.freeze({ ...unsigned.resourceKey }), proof });
}

export function parseSessionRenewalRequest(value: unknown): SessionRenewalRequest {
  if (!isRec(value)) return refuse("bad-request", "session renewal request must be an object");
  closed(value, REQ_FIELDS, "session renewal request");
  if (value.v !== 1 || value.kind !== "session-renewal") refuse("bad-request", "session renewal request version/kind does not validate");
  const p = principal(value.owner, value.actor, "session renewal request");
  const request: SessionRenewalRequest = {
    v: 1,
    kind: "session-renewal",
    capabilityId: token(value.capabilityId, "session renewal request.capabilityId"),
    space: text(value.space, "session renewal request.space"),
    resourceKey: parseResourceKey(value.resourceKey),
    owner: p.owner,
    actor: p.actor,
    lifecycleUid: assertLifecycleToken(text(value.lifecycleUid, "session renewal request.lifecycleUid")),
    publicId: publicId(value.publicId, "session renewal request.publicId"),
    requestId: token(value.requestId, "session renewal request.requestId"),
    requestedAt: uint(value.requestedAt, "session renewal request.requestedAt"),
    proof: text(value.proof, "session renewal request.proof"),
  };
  if (!PROOF.test(request.proof)) refuse("bad-request", "session renewal request.proof must be an Ed25519 base64url signature");
  return request;
}

function sameResource(a: ResourceKey, b: ResourceKey): boolean {
  return resourceKeyId(a) === resourceKeyId(b);
}
function withinCeiling(current: readonly string[], ceiling: readonly string[], label: string): void {
  const excess = current.filter((entry) => !patternInAllow([...ceiling], entry));
  if (excess.length)
    refuse("permission-denied", `session renewal current ${label} exceeds the owner-authorized ceiling (${excess.join(", ")}); issue a new owner-authorized capability rather than widening during renewal`);
}

/**
 * Auth-service renewal operation. It fresh-reads the trusted capability and current actor authority,
 * consumes the request id atomically, verifies holder proof, then returns only a host-signed JWT.
 */
export async function renewIndependentSessionCredential(args: {
  request: unknown;
  signingAuth: Pick<SpaceAuth, "space" | "account">;
  resolveCapability: (capabilityId: string) => Promise<unknown> | unknown;
  resolveCurrentAuthority: (target: Pick<SessionRenewalCapability, "space" | "resourceKey" | "owner" | "actor" | "lifecycleUid" | "publicId">) => Promise<SessionRenewalAuthority | undefined> | SessionRenewalAuthority | undefined;
  consumeRequestId: (capabilityId: string, requestId: string) => Promise<boolean> | boolean;
  now?: () => number;
}): Promise<SessionRenewalMaterial> {
  const request = parseSessionRenewalRequest(args.request);
  const now = (args.now ?? Date.now)();
  if (!Number.isSafeInteger(now) || now < 0) refuse("failed-precondition", "session renewal clock is invalid");
  if (request.requestedAt > now || now - request.requestedAt > SESSION_RENEWAL_REQUEST_MAX_AGE_MS)
    refuse("expired", "session renewal request is outside its one-minute proof window");
  const rawCapability = await args.resolveCapability(request.capabilityId);
  if (rawCapability === undefined) refuse("permission-denied", `session renewal capability ${request.capabilityId} is unknown or revoked`);
  const capability = parseSessionRenewalCapability(rawCapability);
  if (now >= capability.expiresAt) refuse("expired", `session renewal capability ${capability.capabilityId} has expired`);
  if (request.space !== capability.space || request.owner !== capability.owner || request.actor !== capability.actor
    || request.lifecycleUid !== capability.lifecycleUid || request.publicId !== capability.publicId
    || !sameResource(request.resourceKey, capability.resourceKey))
    refuse("permission-denied", "session renewal request is not bound to the capability's same space/resource/actor/lifecycle/nkey");
  if (args.signingAuth.space !== capability.space)
    refuse("failed-precondition", `session renewal auth service is for space ${args.signingAuth.space}, not capability space ${capability.space}`);
  const { proof, ...unsigned } = request;
  let verified = false;
  try { verified = fromPublic(request.publicId).verify(proofInput(unsigned), Buffer.from(proof, "base64url")); }
  catch { verified = false; }
  if (!verified) refuse("permission-denied", "session renewal holder proof does not verify for the lifecycle's existing nkey");
  const current = await args.resolveCurrentAuthority(capability);
  if (current === undefined) refuse("permission-denied", "session renewal target has no current auth-service authority; revoked or released authority never renews");
  const currentAuthority = authority(current, "session renewal current authority");
  withinCeiling(currentAuthority.allowSubscribe, capability.ceiling.allowSubscribe, "read ACL");
  withinCeiling(currentAuthority.allowPublish, capability.ceiling.allowPublish, "publish ACL");
  const capabilitySet = new Set(capability.ceiling.capabilities);
  const excessCapabilities = currentAuthority.capabilities.filter((name) => !capabilitySet.has(name));
  if (excessCapabilities.length)
    refuse("permission-denied", `session renewal current capabilities exceed the owner-authorized ceiling (${excessCapabilities.join(", ")})`);
  if (currentAuthority.role !== capability.ceiling.role)
    refuse("permission-denied", "session renewal current role differs from the owner-authorized ceiling; role changes require a new capability");
  if (!await args.consumeRequestId(capability.capabilityId, request.requestId))
    refuse("permission-denied", `session renewal request ${request.requestId} was already consumed; replay never mints twice`);
  const expiresAt = Math.floor(now / 1000) + capability.credentialTtlSeconds;
  const issued = await mintRenewableSessionAgentJwt(args.signingAuth, capability.publicId, {
    principal: { owner: capability.owner, actor: capability.actor },
    lifecycleUid: capability.lifecycleUid,
    allowSubscribe: [...currentAuthority.allowSubscribe],
    allowPublish: [...currentAuthority.allowPublish],
    capabilities: [...currentAuthority.capabilities],
    ...(currentAuthority.role === undefined ? {} : { role: currentAuthority.role }),
    expiresAt,
  });
  return Object.freeze({
    v: 1,
    kind: "session-renewal-material",
    capabilityId: capability.capabilityId,
    credentialFamily: INDEPENDENT_SESSION_CREDENTIAL_FAMILY,
    renewalOwner: INDEPENDENT_SESSION_RENEWAL_OWNER,
    publicId: capability.publicId,
    issuedAt: now,
    expiresAt: issued.exp,
    jwt: issued.jwt,
  });
}

/** Participant-side materialization. The host returns no seed and receives no seed. */
export function materializeRenewedSessionCreds(material: SessionRenewalMaterial, identity: Identity): string {
  if (material.credentialFamily !== INDEPENDENT_SESSION_CREDENTIAL_FAMILY || material.renewalOwner !== INDEPENDENT_SESSION_RENEWAL_OWNER)
    throw new Error("session renewal material names an unsupported credential family or renewal owner");
  if (material.publicId !== identity.id) throw new Error("session renewal material is for a different local nkey");
  return credsFromJwt(material.jwt, identity);
}

const MANAGER_INFRA = new Set<CredentialKind>([
  "supervisor", "delivery", "membership-rw", "endpoint-serve", "goal-writer", "session-ledger", "run-driver", "run-mediator", "remote-manager",
]);
const NON_SESSION = new Set<CredentialKind>([
  "provisioner", "deprovisioner", "retirement-requester", "lifecycle-executor", "endpoint-serve-executor", "operator", "purger", "backup", "restore", "probe",
  "channel-writer", "control-caller-privileged", "control-caller-admin", "session-caller", "session-serving", "run-operator", "endpoint-evictor", "membership-observer", "connection-evictor",
]);

/** Exhaustive release-facing classification. A blocked answer always names family and owner. */
export function classifySessionCredentialForRelease(family: CredentialKind): SessionCredentialReleaseClassification {
  if (family === INDEPENDENT_SESSION_CREDENTIAL_FAMILY)
    return { status: "independently-renewable", family, renewalOwner: INDEPENDENT_SESSION_RENEWAL_OWNER };
  if (MANAGER_INFRA.has(family))
    return { status: "not-session-identity", family, renewalOwner: family === "remote-manager" ? "auth-service" : "manager", reason: "manager/service infrastructure does not survive a target binding's management release" };
  if (NON_SESSION.has(family))
    return { status: "not-session-identity", family, renewalOwner: family === "membership-observer" || family === "connection-evictor" ? "system-account rotation" : "new operation/session", reason: "one-shot or system infrastructure credential is not the released session's mesh identity" };
  const renewalOwner = family === "observer" || family === "admin" ? "operator" : "none (legacy mixed/static)";
  return { status: "release-blocker", family, renewalOwner, reason: "credential family cannot renew through the owner-authorized auth-service session capability" };
}

export function blockedMeshReleaseResponse(family: CredentialKind): {
  readonly ok: false;
  readonly code: "credential-renewal-blocked";
  readonly credentialFamily: CredentialKind;
  readonly renewalOwner: string;
  readonly message: string;
  readonly options: readonly ["wait-for-independent-renewal", "separately-authorize-mesh-leave"];
} {
  const classification = classifySessionCredentialForRelease(family);
  if (classification.status !== "release-blocker")
    throw new Error(`blockedMeshReleaseResponse: credential family ${family} is ${classification.status}, not a release blocker`);
  return Object.freeze({
    ok: false,
    code: "credential-renewal-blocked",
    credentialFamily: family,
    renewalOwner: classification.renewalOwner,
    message: `${MESH_RELEASE_RENEWAL_OPERATOR_COPY} Credential family "${family}" cannot renew independently (renewal owner: ${classification.renewalOwner}). Wait for independent renewal, or separately authorize a mesh-leave operation before release. Mesh leave is never automatic.`,
    options: Object.freeze(["wait-for-independent-renewal", "separately-authorize-mesh-leave"] as const),
  });
}
