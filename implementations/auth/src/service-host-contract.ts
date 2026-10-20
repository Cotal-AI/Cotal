import {
  EpEnvelopeError, assertDerivedOwnerToken, assertLifecycleToken, assertBoundedOwner,
  endpointToken, isContractDigest, parseEndpointCapabilities,
  type EpCapability, type EpCommandAuthority, type ServicePrincipal, type ServiceRegistrationWitness,
} from "@cotal-ai/core";

export interface ServiceEndpointOptions {
  /** An optional nonsecret approval page under publicFace.url's HTTPS origin. */
  approvalUrl?: string;
  /** Restore ids are fresh per restore. Normal startup never opens a persisted hold. */
  startup?: { kind: "normal" } | { kind: "restore"; restoreId: string };
  /** An explicit operator policy for NEW approvals; never inferred from an actor's admin scope. */
  allowOperatorTargets?: boolean;
}

export type ServiceHostGranter = { kind: "owner"; owner: string } | { kind: "operator"; auditId: string };
export type ServiceSelector = { endpoint: string; instanceId: string };
export type ServiceGrantRef = { granteeUid: string; grantId: string };
export type ServiceParentRef = { principal: ServicePrincipal; grants: ServiceGrantRef[] };
export type ServiceGrantSource =
  | { kind: "service-owner"; owner: string; approvalDigest: string; nameAuthorityRevision: number }
  | { kind: "delegated"; principal: ServicePrincipal; grants: ServiceGrantRef[] };
export type ServiceGrantState =
  | { state: "active" }
  | { state: "revoking"; operationId: string; phase: "cutoff-required" }
  | { state: "revoking"; operationId: string; markerKey: string; markerRevision: number; notBefore: number }
  | { state: "revoked"; operationId: string; verifiedAt: number };
export interface ServiceCallerGrant {
  grantId: string;
  endpoint: string;
  instanceId: string;
  serviceApprovalDigest: string;
  capabilities: EpCapability[];
  source: ServiceGrantSource;
  parentRefs: ServiceParentRef[];
  status: ServiceGrantState;
}

export interface ServiceNameView {
  endpoint: string;
  owner: string;
  claimReference: string;
  requestId: string;
  requestDigest: string;
  revision: number;
}

/** Native views contain no access/renewal proofs, account signer or host capability. Times are Unix seconds. */
export interface ServiceProposalView {
  proposalId: string;
  proposalDigest: string;
  owner: string;
  endpoint: string;
  instanceId: string;
  state: "proposed" | "approving" | "approved" | "refused" | "expired";
  createdAt: number;
  expiresAt: number;
  clusterDigests: string[];
  commands: Array<EpCommandAuthority & { name: string }>;
  nameBinding: ServiceNameView | null;
}

export interface ServiceInstanceView {
  assignmentDigest: string;
  principal: ServicePrincipal;
  endpoint: string;
  instanceId: string;
  state: "pending-root" | "approved-unregistered" | "registering" | "registered" | "ready" | "revoking" | "retired";
  rootCredentialId: string | null;
  rootExpiresAt: number | null;
  approvalDigest: string | null;
  approvalExpiresAt: number | null;
  activationIssued: boolean;
  witness: ServiceRegistrationWitness | null;
  nameBinding: ServiceNameView | null;
}

export const SERVICE_HOST_REASONS = Object.freeze([
  "bad-request", "unauthenticated", "permission-denied", "conflict", "not-found", "expired",
  "resource-exhausted", "unsupported", "unavailable", "admission-held", "name-bound",
  "name-claim-required", "registration-active", "stale-witness",
] as const);
export type ServiceHostReason = (typeof SERVICE_HOST_REASONS)[number];

export interface ServiceOperationView {
  operationId: string;
  requestDigest: string;
  target: ({ kind: "service" } & ServiceSelector) | { kind: "caller"; grantee: ServicePrincipal } |
    { kind: "restore"; restoreId: string } | { kind: "name"; endpoint: string };
  progress:
    | { state: "pending"; phase: string; notBefore?: number }
    | { state: "complete"; resultDigest: string }
    | { state: "refused"; reason: ServiceHostReason };
}

export interface ServiceCallerPolicyView {
  grantee: ServicePrincipal;
  /** Null is a full policy read. A filtered view must never replace the complete native row. */
  service: ServiceSelector | null;
  grants: ServiceCallerGrant[];
}

interface ServicePageInput { owner: string | null; cursor: string | null; limit: number }
export interface ServiceHostInputs {
  "proposal-read": { proposalId: string };
  "proposal-list": ServicePageInput;
  "instance-read": ServiceSelector;
  "instance-list": ServicePageInput;
  "operation-read": { operationId: string };
  "name-read": { endpoint: string };
  "decide": { proposalId: string; expectedProposalRevision: number; expectedNameRevision: number;
    decision: "approve" | "refuse"; callerCeiling: EpCapability[] };
  "name-bind": { endpoint: string; owner: string; expectedRevision: number; claimReference: string };
  "revoke": ServiceSelector & { expectedAssignmentDigest: string;
    cause: "owner-request" | "membership-removal" | "operator-request" | "restore-quarantine" | "approval-expired" };
  "caller-policy-read": { grantee: ServicePrincipal; service: ServiceSelector | null };
  "caller-policy-list": ServicePageInput & { service: ServiceSelector | null };
  "caller-grant": { grantee: ServicePrincipal; service: ServiceSelector & { approvalDigest: string };
    capabilities: EpCapability[]; expectedPolicyRevision: number };
  "caller-revoke": { grantee: ServicePrincipal; grantId: string; expectedPolicyRevision: number };
  "quarantine-restored": { restoreId: string };
  "admission-open": { restoreId: string; expectedQuarantineRevision: number };
}

export type ServiceHostOperation = keyof ServiceHostInputs;
export type ServiceHostRequest = { [K in ServiceHostOperation]: {
  v: 1; kind: "service-endpoint-host"; requestId: string; operation: K;
  input: ServiceHostInputs[K]; granter: ServiceHostGranter;
} }[ServiceHostOperation];

type Versioned<T> = { value: T; revision: number };
type ReadResult<T> = { state: "present"; record: Versioned<T> } | { state: "absent" };
type PageResult<T> = { state: "page"; records: Versioned<T>[]; nextCursor: string | null };
export type DecideResult = { state: "approved"; instance: ServiceInstanceView; revision: number } |
  { state: "refused"; proposal: ServiceProposalView; revision: number };
export type NameBindResult = { state: "bound"; binding: ServiceNameView };
export type RevokeResult = { state: "retired"; assignmentDigest: string; operationId: string };
export type QuarantineRestoredResult = { state: "quarantined"; restoreId: string; revision: number;
  proposals: number; instances: number; callerGrants: number; inventoryDigest: string };
interface ServiceHostOutputs {
  "proposal-read": ReadResult<ServiceProposalView>;
  "proposal-list": PageResult<ServiceProposalView>;
  "instance-read": ReadResult<ServiceInstanceView>;
  "instance-list": PageResult<ServiceInstanceView>;
  "operation-read": ReadResult<ServiceOperationView>;
  "name-read": ReadResult<ServiceNameView>;
  "decide": DecideResult;
  "name-bind": NameBindResult;
  "revoke": RevokeResult;
  "caller-policy-read": ReadResult<ServiceCallerPolicyView>;
  "caller-policy-list": PageResult<ServiceCallerPolicyView>;
  "caller-grant": { state: "granted"; grant: ServiceCallerGrant; revision: number };
  "caller-revoke": { state: "revoked"; grantId: string; operationId: string; revision: number };
  "quarantine-restored": QuarantineRestoredResult;
  "admission-open": { state: "open"; restoreId: string; revision: number };
}
export type ServiceHostResult = { [K in ServiceHostOperation]: {
  v: 1; kind: "service-endpoint-host"; operation: K; requestId: string; space: string; accountPublicKey: string;
} & (ServiceHostOutputs[K] | { state: "pending"; operationId: string; phase: string; notBefore?: number } |
  { state: "denied"; reason: ServiceHostReason }) }[ServiceHostOperation];

export type ServiceEndpointHost = (request: ServiceHostRequest) => Promise<ServiceHostResult>;

function bad(detail: string): never { throw new EpEnvelopeError("bad-request", `service host request: ${detail}`); }
function object(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad("expected an object");
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) bad("expected a plain object");
  const o = raw as Record<string, unknown>;
  if (fields.some((k) => !Object.hasOwn(o, k)) || Reflect.ownKeys(o).some((k) => typeof k !== "string" || !fields.includes(k))) bad("missing or unsupported fields");
  return o;
}
function id(raw: unknown, what: string): void { if (typeof raw !== "string" || !/^[0-9a-f]{32}$/.test(raw)) bad(`${what} must be 32 lowercase hex characters`); }
function bounded(raw: unknown, what: string, max = 128): void { if (typeof raw !== "string" || !raw || raw.length > max || /[\u0000-\u001f]/.test(raw)) bad(`${what} must be bounded text`); }
function uint(raw: unknown, what: string): void { if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) bad(`${what} must be an unsigned safe integer`); }
function digest(raw: unknown): void { if (typeof raw !== "string" || !isContractDigest(raw)) bad("expected a canonical digest"); }
function proposalId(raw: unknown): void { if (typeof raw !== "string" || !/^[0-9a-f]{64}$/.test(raw)) bad("proposalId must be a sha256 hex token"); }
function principal(raw: unknown): void {
  const o = object(raw, ["owner", "actor", "lifecycleUid"]);
  if (typeof o.owner !== "string" || typeof o.actor !== "string" || typeof o.lifecycleUid !== "string") bad("invalid principal");
  assertDerivedOwnerToken(o.owner as string); assertBoundedOwner(o.actor as string, "actor"); assertLifecycleToken(o.lifecycleUid as string, "lifecycleUid");
}
function selector(raw: unknown, approval = false): void {
  const o = object(raw, approval ? ["endpoint", "instanceId", "approvalDigest"] : ["endpoint", "instanceId"]);
  if (typeof o.endpoint !== "string" || typeof o.instanceId !== "string") bad("invalid service selector");
  endpointToken(o.endpoint as string); assertLifecycleToken(o.instanceId as string, "instanceId");
  if (approval) digest(o.approvalDigest);
}
function page(o: Record<string, unknown>): void {
  if (o.owner !== null) { if (typeof o.owner !== "string") bad("invalid owner filter"); assertDerivedOwnerToken(o.owner as string); }
  if (o.cursor !== null) bounded(o.cursor, "cursor", 1024);
  uint(o.limit, "limit"); if ((o.limit as number) < 1 || (o.limit as number) > 50) bad("limit must be between 1 and 50");
}

/** Structural admission only. The host still authenticates its capability and resolves current authority. */
export function parseServiceHostRequest(raw: unknown): ServiceHostRequest {
  const o = object(raw, ["v", "kind", "requestId", "operation", "input", "granter"]);
  if (o.v !== 1 || o.kind !== "service-endpoint-host") bad("unknown version or kind");
  id(o.requestId, "requestId");
  const g = o.granter as Record<string, unknown> | null;
  if (g?.kind === "owner") { object(g, ["kind", "owner"]); if (typeof g.owner !== "string") bad("invalid owner"); assertDerivedOwnerToken(g.owner as string); }
  else if (g?.kind === "operator") { object(g, ["kind", "auditId"]); bounded(g.auditId, "auditId"); }
  else bad("invalid host granter");
  let input: Record<string, unknown>;
  switch (o.operation) {
    case "proposal-read": input = object(o.input, ["proposalId"]); proposalId(input.proposalId); break;
    case "proposal-list": case "instance-list": input = object(o.input, ["owner", "cursor", "limit"]); page(input); break;
    case "instance-read": selector(o.input); break;
    case "operation-read": input = object(o.input, ["operationId"]); id(input.operationId, "operationId"); break;
    case "name-read": input = object(o.input, ["endpoint"]); if (typeof input.endpoint !== "string") bad("invalid endpoint"); endpointToken(input.endpoint as string); break;
    case "decide":
      input = object(o.input, ["proposalId", "expectedProposalRevision", "expectedNameRevision", "decision", "callerCeiling"]);
      proposalId(input.proposalId); uint(input.expectedProposalRevision, "expectedProposalRevision"); uint(input.expectedNameRevision, "expectedNameRevision");
      if (input.decision !== "approve" && input.decision !== "refuse") bad("unknown decision");
      if (input.decision === "approve" && g!.kind !== "owner") bad("operator assertion cannot replace owner consent");
      if (input.decision === "refuse" && (!Array.isArray(input.callerCeiling) || input.callerCeiling.length !== 0)) bad("refusal carries an empty caller ceiling");
      parseEndpointCapabilities(input.callerCeiling); break;
    case "name-bind":
      input = object(o.input, ["endpoint", "owner", "expectedRevision", "claimReference"]);
      if (typeof input.endpoint !== "string" || typeof input.owner !== "string") bad("invalid name binding");
      endpointToken(input.endpoint as string); assertDerivedOwnerToken(input.owner as string); uint(input.expectedRevision, "expectedRevision"); bounded(input.claimReference, "claimReference", 512);
      if (g!.kind !== "operator") bad("name binding requires an operator decision"); break;
    case "revoke":
      input = object(o.input, ["endpoint", "instanceId", "expectedAssignmentDigest", "cause"]);
      selector({ endpoint: input.endpoint, instanceId: input.instanceId }); digest(input.expectedAssignmentDigest);
      if (!["owner-request", "membership-removal", "operator-request", "restore-quarantine", "approval-expired"].includes(input.cause as string)) bad("unknown revoke cause"); break;
    case "caller-policy-read": input = object(o.input, ["grantee", "service"]); principal(input.grantee); if (input.service !== null) selector(input.service); break;
    case "caller-policy-list": input = object(o.input, ["owner", "cursor", "limit", "service"]); page(input); if (input.service !== null) selector(input.service); break;
    case "caller-grant":
      input = object(o.input, ["grantee", "service", "capabilities", "expectedPolicyRevision"]);
      principal(input.grantee); selector(input.service, true); parseEndpointCapabilities(input.capabilities); uint(input.expectedPolicyRevision, "expectedPolicyRevision");
      if (g!.kind !== "owner") bad("caller grant requires an owner decision"); break;
    case "caller-revoke":
      input = object(o.input, ["grantee", "grantId", "expectedPolicyRevision"]); principal(input.grantee); id(input.grantId, "grantId"); uint(input.expectedPolicyRevision, "expectedPolicyRevision"); break;
    case "quarantine-restored": input = object(o.input, ["restoreId"]); id(input.restoreId, "restoreId"); if (g!.kind !== "operator") bad("restore requires an operator"); break;
    case "admission-open": input = object(o.input, ["restoreId", "expectedQuarantineRevision"]); id(input.restoreId, "restoreId"); uint(input.expectedQuarantineRevision, "expectedQuarantineRevision"); if (g!.kind !== "operator") bad("admission requires an operator"); break;
    default: bad("unsupported operation");
  }
  return structuredClone(o) as unknown as ServiceHostRequest;
}
