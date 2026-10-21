import {
  EpEnvelopeError, assertCommandToken, assertDerivedOwnerToken, assertLifecycleToken, assertBoundedOwner,
  endpointToken, isAccountNkey, isContractDigest, isEpAuthzMode, parseEndpointCapabilities,
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
  /** The approving operation and its immutable assignment coordinate, or null while proposed. */
  decision: { operationId: string; assignmentDigest: string } | null;
}

/** A terminal proposal: the compact retained tombstone. It carries no commands or cluster digests. */
export interface ServiceProposalTombstoneView {
  proposalId: string;
  proposalDigest: string;
  owner: string;
  endpoint: string;
  instanceId: string;
  register: { requestId: string; requestDigest: string; operationId: string };
  state: "approved" | "refused" | "expired";
  operationId: string | null;
  approvalDigest: string | null;
  reason: ServiceProposalCloseReason | null;
  at: number;
}
export type ServiceProposalCloseReason = "owner" | "operator" | "revoked" | "expired" | "selector-bound" | "restore" | "custody-refused";

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
  "admission-closed", "selector-pending", "selector-bound", "name-owned", "approval-in-progress",
] as const);
export type ServiceHostReason = (typeof SERVICE_HOST_REASONS)[number];

/** Why a bound operation ended without its effect. A closed proposal's reason is carried through. */
export const SERVICE_OPERATION_REFUSALS = Object.freeze([
  "conflict", "expired", "revoked", "superseded", "custody-refused", "admission-closed",
  "resource-exhausted", "selector-pending", "selector-bound", "name-owned", "restore", "owner", "operator",
] as const);
export type ServiceOperationRefusal = (typeof SERVICE_OPERATION_REFUSALS)[number];
/** Whether the endpoint gate shows committed deny-new, from a leader read; unknown only when that read failed. */
export type ServiceDenyNew = "landed" | "not-landed" | "unknown";
/** A bookkeeping write whose outcome was not observed. Replays retry it; only a read clears it. */
export type ServiceHostDebt = { kind: "capacity-release" | "proposal-close"; proposalId: string };
/** `applied` when this invocation observed the effect land; `recorded` when it returns a stored result. */
export type ServiceHostOutcome = "applied" | "recorded";

/** The immutable subject an operation was admitted for; owner-scoped reads authorize against it. */
export interface ServiceOperationProjection { subjectOwner: string; endpoint: string; instanceId: string; proposalId: string | null }
export type ServiceOperationKind = "register" | "decide" | "revoke";

export interface ServiceOperationView {
  operationId: string;
  requestDigest: string;
  operation: ServiceOperationKind;
  target: ({ kind: "service"; assignmentDigest: string | null } & ServiceSelector) | { kind: "caller"; grantee: ServicePrincipal } |
    { kind: "restore"; restoreId: string } | { kind: "name"; endpoint: string };
  projection: ServiceOperationProjection;
  progress:
    | { state: "pending"; phase: string; notBefore?: number }
    | { state: "held"; reason: string; phase: string }
    | { state: "complete"; resultDigest: string }
    | { state: "refused"; reason: ServiceOperationRefusal }
    | { state: "superseded"; boundOperationId: string };
  debt: ServiceHostDebt[];
}

/** A compacted operation: its binding, subject and outcome. The plan is gone and nothing revives it. */
export interface ServiceOperationTerminalView {
  operationId: string;
  requestDigest: string;
  operation: ServiceOperationKind;
  projection: ServiceOperationProjection;
  outcome:
    | { state: "complete"; resultDigest: string }
    | { state: "refused"; reason: ServiceOperationRefusal }
    | { state: "superseded"; boundOperationId: string };
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
/** The immutable facts an approval fixed. `approvedGateRevision` is the endpoint-gate revision
 *  this approval's own CAS wrote, or null when that write was not observed; a later revision
 *  never stands in for it. Current instance state is a separate read. */
export interface ServiceApprovalResult {
  proposalId: string;
  proposalDigest: string;
  operationId: string;
  assignment: { endpoint: string; instanceId: string; assignmentDigest: string; lifecycleUid: string };
  approvalDigest: string;
  approvalExpiresAt: number | null;
  callerCeiling: EpCapability[];
  nameAuthorityRevision: number;
  rootCredentialId: string;
  rootExpiresAt: number;
  approvedGateRevision: number | null;
}
/** The decision's own completion. A bound decide that ended without its effect is the separate
 *  `refused` arm, which always carries `operationId` and `reason`. */
export type DecideResult = { state: "approved"; outcome: ServiceHostOutcome; approval: ServiceApprovalResult; debt?: ServiceHostDebt[] } |
  { state: "refused"; outcome: ServiceHostOutcome; proposal: ServiceProposalTombstoneView; revision: number; debt?: ServiceHostDebt[] };
export type NameBindResult = { state: "bound"; binding: ServiceNameView };
export type RevokeResult = { state: "retired"; assignmentDigest: string; operationId: string };
export type QuarantineRestoredResult = { state: "quarantined"; restoreId: string; revision: number;
  proposals: number; instances: number; callerGrants: number; inventoryDigest: string };
interface ServiceHostOutputs {
  "proposal-read": ReadResult<ServiceProposalView | ServiceProposalTombstoneView>;
  "proposal-list": PageResult<ServiceProposalView>;
  "instance-read": ReadResult<ServiceInstanceView>;
  "instance-list": PageResult<ServiceInstanceView>;
  "operation-read": ReadResult<ServiceOperationView | ServiceOperationTerminalView>;
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
/** Non-completion arms. `denied` means this invocation wrote nothing and no operation is bound to
 *  the request (or the request conflicts with one). Every other arm names its bound operation, and
 *  none of them means the request was not executed. */
export type ServiceHostPending = { state: "pending"; operationId: string; phase: string; notBefore?: number;
  assignmentDigest?: string; denyNew?: ServiceDenyNew; root?: "none" | "revoked" | "retained-stamped"; debt?: ServiceHostDebt[] };
export type ServiceHostHeld = { state: "held"; operationId: string; reason: string; phase: string;
  assignmentDigest?: string; denyNew?: ServiceDenyNew; debt?: ServiceHostDebt[] };
export type ServiceHostRefused = { state: "refused"; operationId: string; reason: ServiceOperationRefusal;
  boundOperationId?: string; debt?: ServiceHostDebt[] };
export type ServiceHostDenied = { state: "denied"; reason: ServiceHostReason; boundOperationId?: string };
export type ServiceHostResult = { [K in ServiceHostOperation]: {
  v: 1; kind: "service-endpoint-host"; operation: K; requestId: string; space: string; accountPublicKey: string;
} & (ServiceHostOutputs[K] | ServiceHostPending | ServiceHostHeld | ServiceHostRefused | ServiceHostDenied) }[ServiceHostOperation];

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

// ---- closed result and view parsers ---------------------------------------------------------------
// Each returns a structured copy only when every field is known and well formed; an encoder's
// output round-trips through the matching parser.

type Rec = Record<string, unknown>;
function badResult(detail: string): never { throw new EpEnvelopeError("bad-request", `service host result: ${detail}`); }
/** A plain object with exactly `required` plus any of `optional`. */
function closed(raw: unknown, required: readonly string[], optional: readonly string[] = []): Rec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) badResult("expected an object");
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) badResult("expected a plain object");
  const o = raw as Rec;
  if (required.some((k) => !Object.hasOwn(o, k)) || Reflect.ownKeys(o).some((k) => typeof k !== "string" || (!required.includes(k) && !optional.includes(k))))
    badResult("missing or unsupported fields");
  return o;
}
const hex = (raw: unknown, n: number, what: string) => { if (typeof raw !== "string" || !new RegExp(`^[0-9a-f]{${n}}$`).test(raw)) badResult(`${what} must be ${n} lowercase hex characters`); };
const dig = (raw: unknown, what: string) => { if (typeof raw !== "string" || !isContractDigest(raw)) badResult(`${what} must be a canonical digest`); };
const nat = (raw: unknown, what: string) => { if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) badResult(`${what} must be an unsigned safe integer`); };
const text = (raw: unknown, what: string, max = 256) => { if (typeof raw !== "string" || !raw || raw.length > max || /[\u0000-\u001f]/.test(raw)) badResult(`${what} must be bounded text`); };
const oneOf = (raw: unknown, values: readonly string[], what: string) => { if (typeof raw !== "string" || !values.includes(raw)) badResult(`unknown ${what}`); };
const nullable = (raw: unknown, check: (v: unknown) => void) => { if (raw !== null) check(raw); };
function grammar(check: () => void, what: string): void { try { check(); } catch { badResult(`invalid ${what}`); } }
const ownerTok = (raw: unknown) => { if (typeof raw !== "string") badResult("invalid owner"); grammar(() => assertDerivedOwnerToken(raw as string), "owner"); };
const endpointName = (raw: unknown) => { if (typeof raw !== "string") badResult("invalid endpoint"); grammar(() => endpointToken(raw as string), "endpoint"); };
const lifecycleTok = (raw: unknown, what: string) => { if (typeof raw !== "string") badResult(`invalid ${what}`); grammar(() => assertLifecycleToken(raw as string, what), what); };
const capabilities = (raw: unknown) => grammar(() => parseEndpointCapabilities(raw), "capability list");
const DENY_NEW = ["landed", "not-landed", "unknown"] as const;
const OUTCOMES = ["applied", "recorded"] as const;
const CLOSE_REASONS = ["owner", "operator", "revoked", "expired", "selector-bound", "restore", "custody-refused"] as const;

function debtList(raw: unknown): void {
  if (!Array.isArray(raw) || raw.length > 2) badResult("invalid debt");
  for (const d of raw) { const o = closed(d, ["kind", "proposalId"]); oneOf(o.kind, ["capacity-release", "proposal-close"], "debt kind"); hex(o.proposalId, 64, "proposalId"); }
}
function projection(raw: unknown): void {
  const o = closed(raw, ["subjectOwner", "endpoint", "instanceId", "proposalId"]);
  ownerTok(o.subjectOwner); endpointName(o.endpoint); lifecycleTok(o.instanceId, "instanceId"); nullable(o.proposalId, (v) => hex(v, 64, "proposalId"));
}
function finalOutcome(raw: unknown): void {
  const o = raw as Rec;
  if (o?.state === "complete") { closed(raw, ["state", "resultDigest"]); dig(o.resultDigest, "resultDigest"); }
  else if (o?.state === "refused") { closed(raw, ["state", "reason"]); oneOf(o.reason, SERVICE_OPERATION_REFUSALS, "refusal"); }
  else if (o?.state === "superseded") { closed(raw, ["state", "boundOperationId"]); hex(o.boundOperationId, 32, "boundOperationId"); }
  else badResult("unknown outcome");
}
function nameView(raw: unknown): void {
  const o = closed(raw, ["endpoint", "owner", "claimReference", "requestId", "requestDigest", "revision"]);
  endpointName(o.endpoint); ownerTok(o.owner); text(o.claimReference, "claimReference", 512); hex(o.requestId, 32, "requestId"); dig(o.requestDigest, "requestDigest"); nat(o.revision, "revision");
}
function command(raw: unknown): void {
  const o = closed(raw, ["name", "clusterDigest", "class", "targeted", "modes", "capability", "inputDigest", "outputDigest", "traits"]);
  if (typeof o.name !== "string") badResult("invalid command name"); grammar(() => assertCommandToken(o.name as string), "command name");
  dig(o.clusterDigest, "clusterDigest"); oneOf(o.class, ["ephemeral", "journal"], "command class");
  if (typeof o.targeted !== "boolean" || !Array.isArray(o.modes) || !o.modes.every((m) => typeof m === "string" && isEpAuthzMode(m))
    || new Set(o.modes).size !== o.modes.length || (o.modes.length === 0) === o.targeted) badResult("invalid command authorization modes");
  text(o.capability, "capability"); dig(o.inputDigest, "inputDigest"); dig(o.outputDigest, "outputDigest");
  if (!Array.isArray(o.traits) || o.traits.length > 32) badResult("invalid traits"); for (const t of o.traits) text(t, "trait");
}
/** Commands of one proposal: well formed, at most 128, unique and sorted by name. */
export function parseServiceProposalCommands(raw: unknown): Array<EpCommandAuthority & { name: string }> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 128) badResult("a proposal carries 1 to 128 commands");
  raw.forEach(command);
  const names = raw.map((c) => (c as Rec).name as string);
  if (names.some((n, i) => i > 0 && !(names[i - 1] < n))) badResult("commands must be unique and sorted by name");
  return structuredClone(raw) as Array<EpCommandAuthority & { name: string }>;
}
/** Cluster digests of one proposal: canonical, at most 32, unique, in submitted order. */
export function parseServiceProposalClusters(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) badResult("a proposal carries 1 to 32 cluster digests");
  raw.forEach((d) => dig(d, "clusterDigest"));
  if (new Set(raw).size !== raw.length) badResult("cluster digests must be unique");
  return [...raw] as string[];
}

export function parseServiceProposalView(raw: unknown): ServiceProposalView {
  const o = closed(raw, ["proposalId", "proposalDigest", "owner", "endpoint", "instanceId", "state", "createdAt", "expiresAt", "clusterDigests", "commands", "nameBinding", "decision"]);
  hex(o.proposalId, 64, "proposalId"); dig(o.proposalDigest, "proposalDigest"); ownerTok(o.owner); endpointName(o.endpoint); lifecycleTok(o.instanceId, "instanceId");
  oneOf(o.state, ["proposed", "approving"], "live proposal state"); nat(o.createdAt, "createdAt"); nat(o.expiresAt, "expiresAt");
  parseServiceProposalClusters(o.clusterDigests); parseServiceProposalCommands(o.commands); nullable(o.nameBinding, nameView);
  nullable(o.decision, (v) => { const d = closed(v, ["operationId", "assignmentDigest"]); hex(d.operationId, 32, "operationId"); dig(d.assignmentDigest, "assignmentDigest"); });
  if ((o.state === "approving") !== (o.decision !== null)) badResult("an approving proposal names its decision, and only then");
  return structuredClone(o) as unknown as ServiceProposalView;
}

export function parseServiceProposalTombstoneView(raw: unknown): ServiceProposalTombstoneView {
  const o = closed(raw, ["proposalId", "proposalDigest", "owner", "endpoint", "instanceId", "register", "state", "operationId", "approvalDigest", "reason", "at"]);
  hex(o.proposalId, 64, "proposalId"); dig(o.proposalDigest, "proposalDigest"); ownerTok(o.owner); endpointName(o.endpoint); lifecycleTok(o.instanceId, "instanceId");
  const r = closed(o.register, ["requestId", "requestDigest", "operationId"]); hex(r.requestId, 32, "requestId"); dig(r.requestDigest, "requestDigest"); hex(r.operationId, 32, "operationId");
  oneOf(o.state, ["approved", "refused", "expired"], "terminal proposal state"); nullable(o.operationId, (v) => hex(v, 32, "operationId"));
  nullable(o.approvalDigest, (v) => dig(v, "approvalDigest")); nullable(o.reason, (v) => oneOf(v, CLOSE_REASONS, "close reason")); nat(o.at, "at");
  if ((o.state === "approved") !== (o.approvalDigest !== null) || (o.state === "approved" && (o.operationId === null || o.reason !== null))
    || (o.state !== "approved" && o.reason === null)) badResult("terminal proposal fields do not match its state");
  return structuredClone(o) as unknown as ServiceProposalTombstoneView;
}

function operationTarget(raw: unknown): void {
  const o = raw as Rec;
  if (o?.kind !== "service") badResult("unsupported operation target");
  closed(raw, ["kind", "endpoint", "instanceId", "assignmentDigest"]); endpointName(o.endpoint); lifecycleTok(o.instanceId, "instanceId");
  nullable(o.assignmentDigest, (v) => dig(v, "assignmentDigest"));
}
export function parseServiceOperationView(raw: unknown): ServiceOperationView {
  const o = closed(raw, ["operationId", "requestDigest", "operation", "target", "projection", "progress", "debt"]);
  hex(o.operationId, 32, "operationId"); dig(o.requestDigest, "requestDigest"); oneOf(o.operation, ["register", "decide", "revoke"], "operation");
  operationTarget(o.target); projection(o.projection); debtList(o.debt);
  const p = o.progress as Rec;
  if (p?.state === "pending") { closed(p, ["state", "phase"], ["notBefore"]); text(p.phase, "phase", 64); if (Object.hasOwn(p, "notBefore")) nat(p.notBefore, "notBefore"); }
  else if (p?.state === "held") { closed(p, ["state", "reason", "phase"]); text(p.reason, "reason", 64); text(p.phase, "phase", 64); }
  else finalOutcome(p);
  return structuredClone(o) as unknown as ServiceOperationView;
}
export function parseServiceOperationTerminalView(raw: unknown): ServiceOperationTerminalView {
  const o = closed(raw, ["operationId", "requestDigest", "operation", "projection", "outcome"]);
  hex(o.operationId, 32, "operationId"); dig(o.requestDigest, "requestDigest"); oneOf(o.operation, ["register", "decide", "revoke"], "operation");
  projection(o.projection); finalOutcome(o.outcome);
  return structuredClone(o) as unknown as ServiceOperationTerminalView;
}

export function parseServiceApprovalResult(raw: unknown): ServiceApprovalResult {
  const o = closed(raw, ["proposalId", "proposalDigest", "operationId", "assignment", "approvalDigest", "approvalExpiresAt", "callerCeiling",
    "nameAuthorityRevision", "rootCredentialId", "rootExpiresAt", "approvedGateRevision"]);
  hex(o.proposalId, 64, "proposalId"); dig(o.proposalDigest, "proposalDigest"); hex(o.operationId, 32, "operationId");
  const a = closed(o.assignment, ["endpoint", "instanceId", "assignmentDigest", "lifecycleUid"]);
  endpointName(a.endpoint); lifecycleTok(a.instanceId, "instanceId"); dig(a.assignmentDigest, "assignmentDigest"); lifecycleTok(a.lifecycleUid, "lifecycleUid");
  dig(o.approvalDigest, "approvalDigest"); nullable(o.approvalExpiresAt, (v) => nat(v, "approvalExpiresAt")); capabilities(o.callerCeiling);
  nat(o.nameAuthorityRevision, "nameAuthorityRevision"); lifecycleTok(o.rootCredentialId, "rootCredentialId"); nat(o.rootExpiresAt, "rootExpiresAt");
  nullable(o.approvedGateRevision, (v) => nat(v, "approvedGateRevision"));
  return structuredClone(o) as unknown as ServiceApprovalResult;
}

const SUPPORTED_RESULTS = new Set(["decide", "revoke", "operation-read", "proposal-read"]);
/** Closed parser for the results of the operations this slice serves (decide, revoke,
 *  operation-read, proposal-read) and for the shared arms of every operation. */
export function parseServiceHostResult(raw: unknown): ServiceHostResult {
  const env = ["v", "kind", "operation", "requestId", "space", "accountPublicKey", "state"];
  const o = raw as Rec, state = o?.state;
  let keys: Rec;
  if (state === "denied") { keys = closed(raw, [...env, "reason"], ["boundOperationId"]); oneOf(o.reason, SERVICE_HOST_REASONS, "reason"); if (Object.hasOwn(o, "boundOperationId")) hex(o.boundOperationId, 32, "boundOperationId"); }
  else if (state === "pending") {
    keys = closed(raw, [...env, "operationId", "phase"], ["notBefore", "assignmentDigest", "denyNew", "root", "debt"]);
    hex(o.operationId, 32, "operationId"); text(o.phase, "phase", 64); if (Object.hasOwn(o, "notBefore")) nat(o.notBefore, "notBefore");
    if (Object.hasOwn(o, "assignmentDigest")) dig(o.assignmentDigest, "assignmentDigest"); if (Object.hasOwn(o, "denyNew")) oneOf(o.denyNew, DENY_NEW, "denyNew");
    if (Object.hasOwn(o, "root")) oneOf(o.root, ["none", "revoked", "retained-stamped"], "root"); if (Object.hasOwn(o, "debt")) debtList(o.debt);
  } else if (state === "held") {
    keys = closed(raw, [...env, "operationId", "reason", "phase"], ["assignmentDigest", "denyNew", "debt"]);
    hex(o.operationId, 32, "operationId"); text(o.reason, "reason", 64); text(o.phase, "phase", 64);
    if (Object.hasOwn(o, "assignmentDigest")) dig(o.assignmentDigest, "assignmentDigest"); if (Object.hasOwn(o, "denyNew")) oneOf(o.denyNew, DENY_NEW, "denyNew"); if (Object.hasOwn(o, "debt")) debtList(o.debt);
  } else if (state === "refused" && Object.hasOwn(o, "operationId")) {
    keys = closed(raw, [...env, "operationId", "reason"], ["boundOperationId", "debt"]);
    hex(o.operationId, 32, "operationId"); oneOf(o.reason, SERVICE_OPERATION_REFUSALS, "refusal");
    if (Object.hasOwn(o, "boundOperationId")) hex(o.boundOperationId, 32, "boundOperationId"); if (Object.hasOwn(o, "debt")) debtList(o.debt);
  } else {
    if (!SUPPORTED_RESULTS.has(o?.operation as string)) badResult("unsupported operation result");
    if (o.operation === "decide" && state === "approved") { keys = closed(raw, [...env, "outcome", "approval"], ["debt"]); oneOf(o.outcome, OUTCOMES, "outcome"); parseServiceApprovalResult(o.approval); if (Object.hasOwn(o, "debt")) debtList(o.debt); }
    else if (o.operation === "decide" && state === "refused") { keys = closed(raw, [...env, "outcome", "proposal", "revision"], ["debt"]); oneOf(o.outcome, OUTCOMES, "outcome"); parseServiceProposalTombstoneView(o.proposal); nat(o.revision, "revision"); if (Object.hasOwn(o, "debt")) debtList(o.debt); }
    else if (o.operation === "revoke" && state === "retired") { keys = closed(raw, [...env, "assignmentDigest", "operationId"]); dig(o.assignmentDigest, "assignmentDigest"); hex(o.operationId, 32, "operationId"); }
    else if ((o.operation === "operation-read" || o.operation === "proposal-read") && state === "absent") keys = closed(raw, env);
    else if ((o.operation === "operation-read" || o.operation === "proposal-read") && state === "present") {
      keys = closed(raw, [...env, "record"]); const r = closed(o.record, ["value", "revision"]); nat(r.revision, "revision");
      const v = r.value as Rec;
      if (o.operation === "operation-read") (v && Object.hasOwn(v, "outcome") ? parseServiceOperationTerminalView : parseServiceOperationView)(v);
      else (v && Object.hasOwn(v, "register") ? parseServiceProposalTombstoneView : parseServiceProposalView)(v);
    } else badResult("unknown result state");
  }
  if (keys.v !== 1 || keys.kind !== "service-endpoint-host") badResult("unknown version or kind");
  hex(keys.requestId, 32, "requestId"); text(keys.space, "space"); if (typeof keys.accountPublicKey !== "string" || !isAccountNkey(keys.accountPublicKey)) badResult("invalid account public key");
  if (!["proposal-read", "proposal-list", "instance-read", "instance-list", "operation-read", "name-read", "decide", "name-bind", "revoke",
    "caller-policy-read", "caller-policy-list", "caller-grant", "caller-revoke", "quarantine-restored", "admission-open"].includes(keys.operation as string)) badResult("unknown operation");
  return structuredClone(raw) as ServiceHostResult;
}
