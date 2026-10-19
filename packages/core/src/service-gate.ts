import { isContractDigest } from "./canonical.js";
import { EpEnvelopeError } from "./endpoint-error.js";
import { parseEndpointCapabilities } from "./endpoint-capability-policy.js";
import type { EpCapability } from "./endpoint-grants.js";
import { assertLifecycleToken } from "./endpoint-subjects.js";

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
  registration?: { requestId: string; requestDigest: string; registrationProof: string };
}

function bad(): never { throw new EpEnvelopeError("internal", "invalid native service gate authority"); }
function digest(raw: unknown): boolean { return typeof raw === "string" && isContractDigest(raw); }
function expiry(raw: unknown): boolean { return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0; }

/** Stored-row syntax only. Native root custody and owner consent are checked by the host. */
export function parseServiceGateAuthority(raw: unknown): ServiceGateAuthority {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad();
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) bad();
  const o = raw as Record<string, unknown>;
  const required = ["v", "assignmentDigest", "lifecycleUid", "state", "rootCredentialId", "rootExpiresAt", "approvalDigest", "approvalExpiresAt", "callerCeiling", "activationIssued"];
  if (required.some((k) => !Object.hasOwn(o, k)) || Reflect.ownKeys(o).some((k) => typeof k !== "string" || ![...required, "registration"].includes(k))) bad();
  if (o.v !== 1 || !digest(o.assignmentDigest) || typeof o.lifecycleUid !== "string" || typeof o.activationIssued !== "boolean") bad();
  assertLifecycleToken(o.lifecycleUid as string, "service lifecycleUid");
  if (o.state !== "pending-root" && o.state !== "approved" && o.state !== "revoked") bad();
  const ceiling = parseEndpointCapabilities(o.callerCeiling);
  if (o.rootCredentialId === null) {
    if (o.rootExpiresAt !== null || o.approvalDigest !== null || o.approvalExpiresAt !== null || ceiling.length || o.activationIssued || o.registration !== undefined || o.state === "approved") bad();
  } else {
    if (typeof o.rootCredentialId !== "string" || !expiry(o.rootExpiresAt) || !digest(o.approvalDigest) || (o.approvalExpiresAt !== null && !expiry(o.approvalExpiresAt)) || o.state === "pending-root") bad();
    assertLifecycleToken(o.rootCredentialId as string, "service root credentialId");
  }
  if (o.registration !== undefined) {
    if (!o.registration || typeof o.registration !== "object" || Array.isArray(o.registration)) bad();
    const r = o.registration as Record<string, unknown>;
    if (Reflect.ownKeys(r).length !== 3 || typeof r.requestId !== "string" || !/^[a-f0-9]{32}$/.test(r.requestId) || !digest(r.requestDigest) || !digest(r.registrationProof)) bad();
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
