import { isContractDigest } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-error.js";
import { parseEndpointCapabilities } from "./endpoint-capability-policy.js";
import type { EpCapability } from "./endpoint-grants.js";
import { assertLifecycleToken } from "./endpoint-subjects.js";

export interface ServiceRegistrationIdentity {
  operationId: string;
  requestId: string;
  requestDigest: string;
}
export interface ServiceRegistrationStamp extends ServiceRegistrationIdentity {
  processEpoch: number;
  registrationRevision: number;
  nameAuthorityRevision: number;
  registrationProof: string;
}

/** Native service approval coordinates on the endpoint's own release-fence key. Expiries are Unix seconds. */
export interface ServiceGateAuthority {
  v: 1;
  assignmentDigest: string;
  lifecycleUid: string;
  state: "pending-root" | "approved" | "revoked";
  rootCredentialId: string | null;
  rootExpiresAt: number | null;
  approvalDigest: string | null;
  approvalExpiresAt: number | null;
  callerCeiling: EpCapability[];
  activationIssued: boolean;
  registration?: ServiceRegistrationStamp;
  pendingRegistration?: ServiceRegistrationIdentity;
}

function bad(): never { throw new EpEnvelopeError("internal", "invalid native service gate authority"); }
function digest(raw: unknown): boolean { return typeof raw === "string" && isContractDigest(raw); }
function expiry(raw: unknown): boolean { return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0; }

/** The identity persisted under the registration freeze, before any spec write. */
export function parseServiceRegistrationIdentity(raw: unknown): ServiceRegistrationIdentity {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad();
  const r = raw as Record<string, unknown>;
  if (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null) bad();
  if (Reflect.ownKeys(r).some((k) => typeof k !== "string" || !["operationId", "requestId", "requestDigest"].includes(k))) bad();
  if (Reflect.ownKeys(r).length !== 3 || typeof r.operationId !== "string" || typeof r.requestId !== "string"
    || !/^[a-f0-9]{32}$/.test(r.requestId) || !digest(r.requestDigest)) bad();
  assertLifecycleToken(r.operationId as string, "service registration operationId");
  return r as unknown as ServiceRegistrationIdentity;
}

/** Stored-row syntax only. Native root custody and owner consent are checked by the host. */
export function parseServiceGateAuthority(raw: unknown): ServiceGateAuthority {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad();
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) bad();
  const o = raw as Record<string, unknown>;
  const required = ["v", "assignmentDigest", "lifecycleUid", "state", "rootCredentialId", "rootExpiresAt", "approvalDigest", "approvalExpiresAt", "callerCeiling", "activationIssued"];
  if (required.some((k) => !Object.hasOwn(o, k)) || Reflect.ownKeys(o).some((k) => typeof k !== "string" || ![...required, "registration", "pendingRegistration"].includes(k))) bad();
  if (o.v !== 1 || !digest(o.assignmentDigest) || typeof o.lifecycleUid !== "string" || typeof o.activationIssued !== "boolean") bad();
  assertLifecycleToken(o.lifecycleUid as string, "service lifecycleUid");
  if (o.state !== "pending-root" && o.state !== "approved" && o.state !== "revoked") bad();
  const ceiling = parseEndpointCapabilities(o.callerCeiling);
  if (o.rootCredentialId === null) {
    if (o.rootExpiresAt !== null || o.approvalDigest !== null || o.approvalExpiresAt !== null || ceiling.length || o.activationIssued || o.registration !== undefined || o.pendingRegistration !== undefined || o.state === "approved") bad();
  } else {
    if (typeof o.rootCredentialId !== "string" || !expiry(o.rootExpiresAt) || !digest(o.approvalDigest) || (o.approvalExpiresAt !== null && !expiry(o.approvalExpiresAt)) || o.state === "pending-root") bad();
    assertLifecycleToken(o.rootCredentialId as string, "service root credentialId");
  }
  if (o.registration !== undefined) {
    if (!o.registration || typeof o.registration !== "object" || Array.isArray(o.registration)) bad();
    const r = o.registration as Record<string, unknown>;
    if (Reflect.ownKeys(r).length !== 7 || Reflect.ownKeys(r).some((k) => typeof k !== "string"
      || !["operationId", "requestId", "requestDigest", "registrationProof", "processEpoch", "registrationRevision", "nameAuthorityRevision"].includes(k))
      || !digest(r.registrationProof)) bad();
    parseServiceRegistrationIdentity({ operationId: r.operationId, requestId: r.requestId, requestDigest: r.requestDigest });
    if (typeof r.processEpoch !== "number" || !Number.isSafeInteger(r.processEpoch) || r.processEpoch < 0
      || !expiry(r.registrationRevision) || !expiry(r.nameAuthorityRevision)) bad();
  }
  if (o.pendingRegistration !== undefined) {
    parseServiceRegistrationIdentity(o.pendingRegistration);
    if (o.activationIssued) bad();
  }
  if (o.activationIssued && o.registration === undefined) bad();
  return o as unknown as ServiceGateAuthority;
}

/** An expired or revoked approval never becomes usable merely because a registration reopens its gate. */
export function serviceGateApprovalLive(authority: ServiceGateAuthority, nowSeconds: number): boolean {
  return Number.isSafeInteger(nowSeconds) && nowSeconds >= 0 && authority.state === "approved"
    && authority.rootExpiresAt !== null && authority.rootExpiresAt > nowSeconds
    && (authority.approvalExpiresAt === null || authority.approvalExpiresAt > nowSeconds);
}
