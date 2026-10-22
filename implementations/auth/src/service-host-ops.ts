/** Package-internal service host operations: register admission, decide (approve or refuse),
 * revoke, create-only name binding, caller grants and caller revocation up to deny-new and its
 * cutoff marker, the operation, proposal and caller-policy reads and one owner's assignment state,
 * over closed per-key records in the auth bucket. The index does not export it; only the
 * owner-proved public authority door calls register. It grants no serving, registration, issuance
 * from caller policy, terminal caller revocation, restore, terminal retirement or KICK.
 *
 * Every write is one zero-history create or one exact-revision CAS on one key, issued through the
 * shared custody writer (service-write.ts) under the same plane-claim hold check and fatal latch as
 * native custody, and only inside the invocation's write scope: the keys discovery located before
 * its effect connection opened. That connection's credential publishes only those keys and expires
 * at the invocation's original deadline. A step that needs a key outside it holds before anything is issued. No record carries a TTL and none is ever deleted or purged. There are no
 * multi-key batches: every window between two writes is either fenced on its key or settled from
 * what a later invocation reads. The invocation limit and the original deadline are limits, never
 * waits, fences or proof that an earlier write cannot still land. */
import { createHash } from "node:crypto";
import type { NatsConnection } from "@nats-io/transport-node";
import {
  EpEnvelopeError, GOVERN_HEAD, RECORD_KINDS, assertBoundedOwner, assertDerivedOwnerToken, assertLifecycleToken, canonicalJson, contractArtifactCanonicalBytes,
  contractDigest, contractStoreContext, endpointCapabilitiesWithin, endpointRegistrationBarrier, endpointToken, epgateKey, isContractDigest, mintLifecycleUid,
  parseEndpointCapabilities, parseNativeUidCustody, parseServiceSpec, parseServiceStatus, publishContractArtifact, recordAtomicKey,
  recordSpecKey, recordStatusKey, registerServiceInstance, serviceEndpointActor, serviceGateApprovalLive, serviceWitnessDigest,
  verifyClusterManifest, verifyClusterRoot, writeServiceStatus,
  type ContractStoreContext, type EpCapability, type EpCommandAuthority, type ServiceAuthorityStatus, type ServiceRegistrationSnapshot,
  type ServicePrincipal, type ServiceRegistrationWitness, type ServiceSpec, type ServiceUidCustodyV1,
} from "@cotal-ai/core";
import { SERVICE_HOST_INVOCATION_MS, openAuthorityClient, serviceHostEffectGrants, serviceHostEffectLabel, type ServiceHostEffectReads } from "./authority-client.js";
import { findActorUnified, findInteractiveActor } from "./ledger.js";
import { openLifecycleRegistry, registryMaxPayload, registryStores, type LifecycleRegistry } from "./lifecycle-registry.js";
import { activatedServiceGateRow, approvedServiceGateRow, assertApprovableServiceGate, type ServiceAssignmentBinding, type ServiceGateRows } from "./native-service-gate.js";
import { nativeServiceNameAuthority, readNativeServiceName, serviceNameKey, serviceNameRowBytes } from "./native-service-name.js";
import type { PlaneClaimHold } from "./plane-claim.js";
import {
  SERVICE_CALLER_PAYLOAD_KEY, parseServiceCallerPayloadRecord, serviceCallerPayloadCheck, serviceCallerWriteFits,
  type ServiceCallerPayloadLimits, type ServiceCallerPayloadRecord,
} from "./service-caller-payload.js";
import {
  callerAppendStep, callerBeginStep, callerCutoffStep, immutableGrantView, parseNativeServiceCallerPolicy, parseServiceCallerGrant, servicePolicyKey,
  type NativeServiceCallerPolicy,
} from "./service-caller-policy.js";
import { encodeRoundTrip } from "./service-custody-shapes.js";
import {
  cancelServiceCustody, runServiceBootstrap, sealServiceBootstrapIntent, sealServiceCancelIntent, serviceAssignmentGate,
  serviceCustodyKeys, serviceReservationKeys, type ServiceCancelResult,
} from "./service-custody.js";
import {
  parseServiceHostRequest, parseServiceProposalClusters, parseServiceProposalCommands,
  type ServiceApprovalResult, type ServiceCallerGrant, type ServiceCallerPolicyView, type ServiceDenyNew, type ServiceHostDebt, type ServiceHostGranter,
  type ServiceHostInputs, type ServiceHostOutcome, type ServiceHostReason, type ServiceHostRequest, type ServiceHostResult, type ServiceNameView, type ServiceOperationKind,
  type ServiceOperationProjection, type ServiceOperationRefusal, type ServiceOperationTerminalView, type ServiceOperationView,
  type ServiceProposalCloseReason, type ServiceProposalTombstoneView, type ServiceProposalView, type ServiceSelector,
} from "./service-host-contract.js";
import { readRegistryServiceRoot } from "./service-root-reader.js";
import {
  HOSTS, Held, S1_REQUEST_TIMEOUT_MS, bounded, context, endpoint, held, leader, message, openServiceCustodyHost, readyAfter, readyBefore, scopeCovers, write,
  type Ctx, type EndpointClass, type EndpointRow, type HostInternals, type ServiceCustodyHost, type ServiceWriteScope,
} from "./service-write.js";

/** Original authority limit of one approve, refuse or register, from its admission. */
export const S2A_OPERATION_TTL_MS = 600_000;
/** Per-invocation limit for reads, bookkeeping, settlement and native cancellation, and the
 *  longest window an invocation's effect credential may cover. */
export const S2A_INVOCATION_MS = SERVICE_HOST_INVOCATION_MS;
/** A proposal's canonical lifetime (canon:203). */
export const S2A_PROPOSAL_LIFETIME_MS = 86_400_000;
export const S2A_MAX_PENDING = 256;
export const S2A_MAX_PENDING_PER_OWNER = 32;
export const S2A_MAX_PROPOSAL_BYTES = 256 * 1024;
/** Fresh decisions after a CAS loss before a step holds. */
export const S2A_MAX_REDECIDE = 4;
/** Serving request intents one instance keeps (SPEC 13.1): never pruned or reused in this cut. */
export const S3_MAX_INTENTS_PER_INSTANCE = 64;
/** Index entries one service instance may ever hold: every caller grant written for it, active,
 *  revoking or orphaned by a grant attempt refused after its index write. Nothing is pruned. */
export const S3_MAX_CALLER_GRANTS_PER_INSTANCE = 256;

const ADMISSION_KEY = "svchost.admission";
const CAPACITY_KEY = "svccap.space";
const opKey = (operationId: string) => `svcop.${operationId}`;
const proposalKey = (proposalId: string) => `svcprop.${proposalId}`;
const assignmentKey = (endpoint: string, instanceId: string) => `svcasg.${endpointToken(endpoint)}.${assertLifecycleToken(instanceId, "instanceId")}`;
const intentKey = (operationId: string) => `svcint.${hexN(operationId, 32)}`;
const intentIndexKey = (endpoint: string, instanceId: string) => `svcintx.${endpointToken(endpoint)}.${assertLifecycleToken(instanceId, "instanceId")}`;
const callerIndexKey = (endpoint: string, instanceId: string) => `svcpolx.${endpointToken(endpoint)}.${assertLifecycleToken(instanceId, "instanceId")}`;
const cutoffKey = (operationId: string) => `svccut.${hexN(operationId, 32)}`;
const enc = new TextEncoder();
const seconds = (ms: number) => Math.floor(ms / 1000);

// ---- identities ---------------------------------------------------------------------------------

const hex32 = (tag: string, space: string, value: string) => createHash("sha256").update(`${tag}\0${space}\0${value}`, "utf8").digest("hex").slice(0, 32);
/** One id namespace for every host request in a space; a valid lifecycle token. */
export const serviceHostOperationId = (space: string, requestId: string) => hex32("cotal-service-host-op", space, requestId);
/** The native cancel identity an expiry settlement derives from recorded facts only. */
const expiryOperationId = (space: string, approveOperationId: string) => hex32("cotal-service-host-expiry", space, approveOperationId);
/** A caller grant's id, from its operation: one grant per bound grant request, never reused. */
const callerGrantId = (space: string, operationId: string) => hex32("cotal-service-caller-grant", space, operationId);
const expiryRequestDigest = (operationId: string, assignmentDigest: string) =>
  contractDigest({ v: 1, kind: "service-approval-expiry", operationId, assignmentDigest });
const requestDigestOf = (r: { v: 1; kind: string; requestId: string; operation: string; input: unknown; granter: unknown }) =>
  contractDigest({ v: r.v, kind: r.kind, requestId: r.requestId, operation: r.operation, input: r.input, granter: r.granter });
const proposalIdOf = (proposalDigest: string, registerRequestId: string) =>
  contractDigest({ v: 1, kind: "service-proposal-id", proposalDigest, registerRequestId }).slice("sha256:".length);
const approvalDigestOf = (a: { proposalDigest: string; assignmentDigest: string; callerCeiling: EpCapability[]; approvalExpiresAt: number | null; nameAuthorityRevision: number; operationId: string }) =>
  contractDigest({ v: 1, kind: "service-approval", ...a });

// ---- closed records -----------------------------------------------------------------------------

type Rec = Record<string, unknown>;
class Malformed extends Error {}
function bad(detail: string): never { throw new Malformed(detail); }
function closed(raw: unknown, fields: readonly string[], optional: readonly string[] = []): Rec {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) bad("expected an object");
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) bad("expected a plain object");
  const o = raw as Rec;
  if (fields.some((k) => !Object.hasOwn(o, k)) || Reflect.ownKeys(o).some((k) => typeof k !== "string" || (!fields.includes(k) && !optional.includes(k))))
    bad("missing or unsupported fields");
  return o;
}
const hexN = (raw: unknown, n: number) => { if (typeof raw !== "string" || !new RegExp(`^[0-9a-f]{${n}}$`).test(raw)) bad(`expected ${n} hex characters`); return raw as string; };
const digest = (raw: unknown) => { if (typeof raw !== "string" || !isContractDigest(raw)) bad("expected a canonical digest"); return raw as string; };
const ms = (raw: unknown) => { if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) bad("expected an unsigned safe integer"); return raw as number; };
const word = (raw: unknown, max = 64) => { if (typeof raw !== "string" || !raw || raw.length > max || /[\u0000-\u001f]/.test(raw)) bad("expected bounded text"); return raw as string; };
const pick = <T extends string>(raw: unknown, values: readonly T[]) => { if (typeof raw !== "string" || !values.includes(raw as T)) bad(`expected one of ${values.join(", ")}`); return raw as T; };
const grammar = <T>(f: () => T): T => { try { return f(); } catch (e) { return bad(message(e)); } };
const owner = (raw: unknown) => grammar(() => assertDerivedOwnerToken(raw as string));
const endpointName = (raw: unknown) => { if (typeof raw !== "string") bad("expected an endpoint"); grammar(() => endpointToken(raw as string)); return raw as string; };
const token = (raw: unknown, what: string) => { if (typeof raw !== "string") bad(`expected ${what}`); return grammar(() => assertLifecycleToken(raw as string, what)); };

interface Account { accountPublicKey: string; space: string }
interface Projection extends ServiceOperationProjection {}
type RegisterPlan = { kind: "register"; proposalId: string; proposalDigest: string; createdAtMs: number; expiresAtMs: number };
type ApprovePlan = { kind: "approve"; proposalId: string; proposalDigest: string; proposalRevision: number; nameRevision: number;
  reservation: ServiceUidCustodyV1; callerCeiling: EpCapability[]; approvalExpiresAt: number | null };
type RefusePlan = { kind: "refuse"; proposalId: string; proposalRevision: number };
type RevokeCause = "owner-request" | "membership-removal" | "operator-request" | "restore-quarantine" | "approval-expired";
type RevokePlan = { kind: "revoke"; endpoint: string; instanceId: string; expectedAssignmentDigest: string; cause: RevokeCause };
/** A grant without its status: the immutable fields a witness fixes. */
type GrantBody = Omit<ServiceCallerGrant, "status">;
/** The exact request input the digest covers, the eligibility witness, and the complete grant G5
 *  appends (plus status active). G4 and G5 write only from this plan. */
type CallerGrantPlan = { kind: "caller-grant"; grantee: ServicePrincipal; assignmentDigest: string; approvalDigest: string; nameAuthorityRevision: number;
  expectedPolicyRevision: number; request: ServiceHostInputs["caller-grant"]; grant: GrantBody };
/** The exact request input and the grant's immutable view as K0 found it; every K step compares the current grant with it. */
type CallerRevokePlan = { kind: "caller-revoke"; grantee: ServicePrincipal; grantId: string; expectedPolicyRevision: number;
  request: ServiceHostInputs["caller-revoke"]; grant: GrantBody };
type Plan = RegisterPlan | ApprovePlan | RefusePlan | RevokePlan | CallerGrantPlan | CallerRevokePlan;
type RegisterResult = { proposalId: string; revision: number; expiresAtMs: number };
type RefuseResult = { proposal: ServiceProposalTombstoneView; revision: number };
/** `revision` is the append's own write revision, or on a late adoption the read that found the grant. */
type GrantResult = { grant: ServiceCallerGrant; revision: number };
type OpResult = RegisterResult | ServiceApprovalResult | RefuseResult | GrantResult;
type Final = { state: "complete"; result: OpResult } | { state: "refused"; reason: ServiceOperationRefusal } | { state: "superseded"; boundOperationId: string };
/** `issued` is recorded before a positive grant write and replaced only by its settlement: until a
 *  read settles it, a later invocation treats that write's outcome as unknown and never reissues it. */
type Progress = { state: "admitted" } | { state: "custody"; step: string } | { state: "held"; reason: string; phase: string }
  | { state: "issued"; step: string; key: string; atRevision: number } | Final;
interface OpLive {
  v: 1; kind: "service-host-operation"; operationId: string; requestId: string; requestDigest: string; operation: ServiceOperationKind;
  account: Account; granter: ServiceHostGranter; admittedAtMs: number; notAfterMs: number; admissionEpoch: number;
  projection: Projection; plan: Plan; progress: Progress; debt: ServiceHostDebt[];
}
interface OpTerminal {
  v: 1; kind: "service-host-operation-terminal"; operationId: string; requestId: string; requestDigest: string; operation: ServiceOperationKind;
  account: Account; granter: ServiceHostGranter; admittedAtMs: number; projection: Projection; outcome: Final;
}
type Op = OpLive | OpTerminal;
type Command = EpCommandAuthority & { name: string };
/** A caller-ceiling entry an approval may carry: pinned to the proposal's own instance with
 *  `instanceOnly`, on a declared command, with exactly the target presence and mode that command
 *  admits. `any` and `ledger` need an operator target policy, which stock does not wire. Containment
 *  then compares instance rails directly; no class entry is re-read as an instance one. */
const ceilingEntryAdmitted = (c: EpCapability, p: { endpoint: string; instanceId: string; commands: Command[] }): boolean => {
  if (c.endpoint !== p.endpoint || c.instanceId !== p.instanceId || c.instanceOnly !== true) return false;
  const k = p.commands.find((x) => x.name === c.command);
  if (k === undefined) return false;
  if (!k.targeted) return c.target === undefined;
  return c.target !== undefined && c.target.mode !== "any" && c.target.mode !== "ledger" && k.modes.includes(c.target.mode);
};
interface ProposalLive {
  v: 1; kind: "service-proposal"; proposalId: string; proposalDigest: string; account: Account; owner: string; endpoint: string; instanceId: string;
  register: { requestId: string; requestDigest: string; operationId: string }; createdAtMs: number; expiresAtMs: number;
  clusterDigests: string[]; commands: Command[];
  state: { state: "proposed" } | { state: "approving"; operationId: string; assignmentDigest: string };
}
interface ProposalTerminal {
  v: 1; kind: "service-proposal-terminal"; proposalId: string; proposalDigest: string; owner: string; endpoint: string; instanceId: string;
  register: { requestId: string; requestDigest: string; operationId: string }; state: "approved" | "refused" | "expired";
  operationId: string | null; approvalDigest: string | null; reason: ServiceProposalCloseReason | null; atMs: number;
}
type Proposal = ProposalLive | ProposalTerminal;
interface CapEntry { proposalId: string; owner: string; endpoint: string; instanceId: string; registerRequestId: string; expiresAtMs: number }
interface Capacity { v: 1; kind: "service-proposal-capacity"; pending: CapEntry[] }
type Cancel = { operationId: string; requestDigest: string; cause: RevokeCause };
type Assignment =
  | { v: 1; kind: "service-assignment"; state: "bound"; endpoint: string; instanceId: string; owner: string; proposalId: string; assignmentDigest: string;
      reservation: ServiceUidCustodyV1; creation: { operationId: string }; cancel: Cancel | null }
  | { v: 1; kind: "service-assignment"; state: "fenced"; endpoint: string; instanceId: string; owner: string; proposalId: string; assignmentDigest: string; cancel: Cancel };
interface Admission { v: 1; kind: "service-host-admission"; state: "open" | "quarantined"; epoch: number; restoreId: string | null }

const CAUSES: readonly RevokeCause[] = ["owner-request", "membership-removal", "operator-request", "restore-quarantine", "approval-expired"];
const REFUSALS: readonly ServiceOperationRefusal[] = ["conflict", "expired", "revoked", "superseded", "custody-refused", "admission-closed",
  "resource-exhausted", "selector-pending", "selector-bound", "name-owned", "restore", "owner", "operator"];
const CLOSE_REASONS: readonly ServiceProposalCloseReason[] = ["owner", "operator", "revoked", "expired", "selector-bound", "restore", "custody-refused"];

function account(raw: unknown): Account {
  const o = closed(raw, ["accountPublicKey", "space"]);
  return { accountPublicKey: word(o.accountPublicKey, 64), space: word(o.space, 128) };
}
function granter(raw: unknown): ServiceHostGranter {
  const o = raw as Rec;
  if (o?.kind === "owner") { closed(raw, ["kind", "owner"]); return { kind: "owner", owner: owner(o.owner) }; }
  closed(raw, ["kind", "auditId"]); pick(o.kind, ["operator"]);
  return { kind: "operator", auditId: word(o.auditId, 128) };
}
function projection(raw: unknown): Projection {
  const o = closed(raw, ["subjectOwner", "endpoint", "instanceId", "proposalId"]);
  return { subjectOwner: owner(o.subjectOwner), endpoint: endpointName(o.endpoint), instanceId: token(o.instanceId, "instanceId"),
    proposalId: o.proposalId === null ? null : hexN(o.proposalId, 64) };
}
/** A service reservation that native custody's own parser accepts for its lifecycle UID. */
function reservation(raw: unknown): ServiceUidCustodyV1 {
  const r = structuredClone(raw) as ServiceUidCustodyV1;
  const lifecycleUid = token(r?.native?.lifecycleUid, "lifecycleUid");
  if (grammar(() => parseNativeUidCustody(enc.encode(canonicalJson(r)), lifecycleUid)).kind !== "service") bad("expected a service reservation");
  return r;
}
function debt(raw: unknown): ServiceHostDebt[] {
  if (!Array.isArray(raw) || raw.length > 2) bad("invalid debt");
  return raw.map((d) => { const o = closed(d, ["kind", "proposalId"]); return { kind: pick(o.kind, ["capacity-release", "proposal-close"] as const), proposalId: hexN(o.proposalId, 64) }; });
}
function cancelOf(raw: unknown): Cancel {
  const o = closed(raw, ["operationId", "requestDigest", "cause"]);
  return { operationId: token(o.operationId, "operationId"), requestDigest: digest(o.requestDigest), cause: pick(o.cause, CAUSES) };
}
function principalOf(raw: unknown): ServicePrincipal {
  const o = closed(raw, ["owner", "actor", "lifecycleUid"]);
  if (typeof o.actor !== "string") bad("expected an actor");
  return { owner: owner(o.owner), actor: grammar(() => assertBoundedOwner(o.actor as string, "actor")), lifecycleUid: token(o.lifecycleUid, "lifecycleUid") };
}
/** A grant body: the stored grant syntax with the status left out. */
function grantBody(raw: unknown): GrantBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.hasOwn(raw, "status")) bad("expected a grant body");
  const { status: _status, ...body } = grammar(() => parseServiceCallerGrant({ ...(raw as Rec), status: { state: "active" } }));
  return body;
}
const withStatus = (body: GrantBody, status: ServiceCallerGrant["status"]): ServiceCallerGrant => ({ ...body, status });
function plan(raw: unknown): Plan {
  const o = raw as Rec;
  switch (o?.kind) {
    case "register": closed(raw, ["kind", "proposalId", "proposalDigest", "createdAtMs", "expiresAtMs"]);
      return { kind: "register", proposalId: hexN(o.proposalId, 64), proposalDigest: digest(o.proposalDigest), createdAtMs: ms(o.createdAtMs), expiresAtMs: ms(o.expiresAtMs) };
    case "approve": closed(raw, ["kind", "proposalId", "proposalDigest", "proposalRevision", "nameRevision", "reservation", "callerCeiling", "approvalExpiresAt"]);
      return { kind: "approve", proposalId: hexN(o.proposalId, 64), proposalDigest: digest(o.proposalDigest), proposalRevision: ms(o.proposalRevision),
        nameRevision: ms(o.nameRevision), reservation: reservation(o.reservation), callerCeiling: grammar(() => parseEndpointCapabilities(o.callerCeiling)),
        approvalExpiresAt: o.approvalExpiresAt === null ? null : ms(o.approvalExpiresAt) };
    case "refuse": closed(raw, ["kind", "proposalId", "proposalRevision"]);
      return { kind: "refuse", proposalId: hexN(o.proposalId, 64), proposalRevision: ms(o.proposalRevision) };
    case "revoke": closed(raw, ["kind", "endpoint", "instanceId", "expectedAssignmentDigest", "cause"]);
      return { kind: "revoke", endpoint: endpointName(o.endpoint), instanceId: token(o.instanceId, "instanceId"), expectedAssignmentDigest: digest(o.expectedAssignmentDigest), cause: pick(o.cause, CAUSES) };
    case "caller-grant": {
      closed(raw, ["kind", "grantee", "assignmentDigest", "approvalDigest", "nameAuthorityRevision", "expectedPolicyRevision", "request", "grant"]);
      const p: CallerGrantPlan = { kind: "caller-grant", grantee: principalOf(o.grantee), assignmentDigest: digest(o.assignmentDigest), approvalDigest: digest(o.approvalDigest),
        nameAuthorityRevision: ms(o.nameAuthorityRevision), expectedPolicyRevision: ms(o.expectedPolicyRevision),
        request: structuredClone(o.request) as ServiceHostInputs["caller-grant"], grant: grantBody(o.grant) };
      const src = p.grant.source;
      if (src.kind !== "service-owner" || src.approvalDigest !== p.approvalDigest || src.nameAuthorityRevision !== p.nameAuthorityRevision || p.grant.parentRefs.length !== 0
        || p.grant.endpoint !== p.request?.service?.endpoint || p.grant.instanceId !== p.request?.service?.instanceId || p.approvalDigest !== p.request?.service?.approvalDigest
        || canonicalJson(p.grantee) !== canonicalJson(p.request?.grantee) || p.expectedPolicyRevision !== p.request?.expectedPolicyRevision)
        bad("the caller grant plan does not match its request");
      return p;
    }
    case "caller-revoke": {
      closed(raw, ["kind", "grantee", "grantId", "expectedPolicyRevision", "request", "grant"]);
      const p: CallerRevokePlan = { kind: "caller-revoke", grantee: principalOf(o.grantee), grantId: hexN(o.grantId, 32), expectedPolicyRevision: ms(o.expectedPolicyRevision),
        request: structuredClone(o.request) as ServiceHostInputs["caller-revoke"], grant: grantBody(o.grant) };
      if (p.grant.grantId !== p.grantId || p.grantId !== p.request?.grantId || canonicalJson(p.grantee) !== canonicalJson(p.request?.grantee)
        || p.expectedPolicyRevision !== p.request?.expectedPolicyRevision) bad("the caller revoke plan does not match its request");
      return p;
    }
    default: return bad("unknown plan");
  }
}
function tombstoneView(raw: unknown): ServiceProposalTombstoneView {
  const o = closed(raw, ["proposalId", "proposalDigest", "owner", "endpoint", "instanceId", "register", "state", "operationId", "approvalDigest", "reason", "at"]);
  const r = closed(o.register, ["requestId", "requestDigest", "operationId"]);
  return { proposalId: hexN(o.proposalId, 64), proposalDigest: digest(o.proposalDigest), owner: owner(o.owner), endpoint: endpointName(o.endpoint),
    instanceId: token(o.instanceId, "instanceId"), register: { requestId: hexN(r.requestId, 32), requestDigest: digest(r.requestDigest), operationId: hexN(r.operationId, 32) },
    state: pick(o.state, ["approved", "refused", "expired"] as const), operationId: o.operationId === null ? null : hexN(o.operationId, 32),
    approvalDigest: o.approvalDigest === null ? null : digest(o.approvalDigest), reason: o.reason === null ? null : pick(o.reason, CLOSE_REASONS), at: ms(o.at) };
}
function approvalResult(raw: unknown): ServiceApprovalResult {
  const o = closed(raw, ["proposalId", "proposalDigest", "operationId", "assignment", "approvalDigest", "approvalExpiresAt", "callerCeiling",
    "nameAuthorityRevision", "rootCredentialId", "rootExpiresAt", "approvedGateRevision"]);
  const a = closed(o.assignment, ["endpoint", "instanceId", "assignmentDigest", "lifecycleUid"]);
  return { proposalId: hexN(o.proposalId, 64), proposalDigest: digest(o.proposalDigest), operationId: hexN(o.operationId, 32),
    assignment: { endpoint: endpointName(a.endpoint), instanceId: token(a.instanceId, "instanceId"), assignmentDigest: digest(a.assignmentDigest), lifecycleUid: token(a.lifecycleUid, "lifecycleUid") },
    approvalDigest: digest(o.approvalDigest), approvalExpiresAt: o.approvalExpiresAt === null ? null : ms(o.approvalExpiresAt),
    callerCeiling: grammar(() => parseEndpointCapabilities(o.callerCeiling)), nameAuthorityRevision: ms(o.nameAuthorityRevision),
    rootCredentialId: token(o.rootCredentialId, "rootCredentialId"), rootExpiresAt: ms(o.rootExpiresAt),
    approvedGateRevision: o.approvedGateRevision === null ? null : ms(o.approvedGateRevision) };
}
function result(raw: unknown, operation: ServiceOperationKind, decision: "approve" | "refuse" | null): OpResult {
  if (operation === "grant") { const o = closed(raw, ["grant", "revision"]); return { grant: grammar(() => parseServiceCallerGrant(o.grant)), revision: ms(o.revision) }; }
  if (operation === "register") { const o = closed(raw, ["proposalId", "revision", "expiresAtMs"]); return { proposalId: hexN(o.proposalId, 64), revision: ms(o.revision), expiresAtMs: ms(o.expiresAtMs) }; }
  if (operation === "decide" && decision === "approve") return approvalResult(raw);
  if (operation === "decide" && decision === "refuse") { const o = closed(raw, ["proposal", "revision"]); return { proposal: tombstoneView(o.proposal), revision: ms(o.revision) }; }
  return bad("this operation stores no result");
}
/** A complete outcome is parsed by the shape it stores; a terminal op has no plan, so its result is told apart by its fields. */
function final(raw: unknown, operation: ServiceOperationKind, decision: "approve" | "refuse" | null): Final {
  const o = raw as Rec;
  if (o?.state === "complete") { closed(raw, ["state", "result"]); return { state: "complete", result: result(o.result, operation, decision) }; }
  if (o?.state === "refused") { closed(raw, ["state", "reason"]); return { state: "refused", reason: pick(o.reason, REFUSALS) }; }
  closed(raw, ["state", "boundOperationId"]); pick(o.state, ["superseded"]);
  return { state: "superseded", boundOperationId: hexN(o.boundOperationId, 32) };
}
const terminalDecision = (operation: ServiceOperationKind, outcome: Rec): "approve" | "refuse" | null =>
  operation !== "decide" ? null : (outcome?.result as Rec | undefined) && Object.hasOwn(outcome.result as Rec, "proposal") ? "refuse" : "approve";

export function parseServiceHostOperationRecord(raw: unknown): Op {
  const o = raw as Rec;
  const common = (x: Rec) => ({ operationId: token(x.operationId, "operationId"), requestId: hexN(x.requestId, 32), requestDigest: digest(x.requestDigest),
    operation: pick(x.operation, ["register", "decide", "revoke", "grant"] as const), account: account(x.account), granter: granter(x.granter), admittedAtMs: ms(x.admittedAtMs), projection: projection(x.projection) });
  if (o?.kind === "service-host-operation") {
    closed(raw, ["v", "kind", "operationId", "requestId", "requestDigest", "operation", "account", "granter", "admittedAtMs", "notAfterMs", "admissionEpoch", "projection", "plan", "progress", "debt"]);
    if (o.v !== 1) bad("unknown version");
    const c = common(o), p = plan(o.plan);
    if ((c.operation === "register") !== (p.kind === "register") || (c.operation === "revoke") !== (p.kind === "revoke" || p.kind === "caller-revoke")
      || (c.operation === "grant") !== (p.kind === "caller-grant")) bad("plan does not match its operation");
    // A caller plan carries its request's exact input; the record binds only if that input reproduces the digest.
    if (p.kind === "caller-grant" || p.kind === "caller-revoke") {
      const request = { v: 1 as const, kind: "service-endpoint-host", requestId: c.requestId, operation: p.kind, input: p.request, granter: c.granter };
      grammar(() => parseServiceHostRequest(request));
      if (requestDigestOf(request) !== c.requestDigest) bad("the stored request does not reproduce the request digest");
    }
    const g = o.progress as Rec;
    let progress: Progress;
    if (g?.state === "admitted") { closed(g, ["state"]); progress = { state: "admitted" }; }
    else if (g?.state === "issued") { closed(g, ["state", "step", "key", "atRevision"]); progress = { state: "issued", step: word(g.step), key: word(g.key, 512), atRevision: ms(g.atRevision) }; }
    else if (g?.state === "custody") { closed(g, ["state", "step"]); progress = { state: "custody", step: word(g.step) }; }
    else if (g?.state === "held") { closed(g, ["state", "reason", "phase"]); progress = { state: "held", reason: word(g.reason), phase: word(g.phase) }; }
    else progress = final(g, c.operation, p.kind === "approve" || p.kind === "refuse" ? p.kind : null);
    return { v: 1, kind: "service-host-operation", ...c, notAfterMs: ms(o.notAfterMs), admissionEpoch: ms(o.admissionEpoch), plan: p, progress, debt: debt(o.debt) };
  }
  closed(raw, ["v", "kind", "operationId", "requestId", "requestDigest", "operation", "account", "granter", "admittedAtMs", "projection", "outcome"]);
  if (o.v !== 1 || o.kind !== "service-host-operation-terminal") bad("unknown version or kind");
  const c = common(o);
  return { v: 1, kind: "service-host-operation-terminal", ...c, outcome: final(o.outcome, c.operation, terminalDecision(c.operation, o.outcome as Rec)) };
}

const registerRef = (raw: unknown) => { const r = closed(raw, ["requestId", "requestDigest", "operationId"]); return { requestId: hexN(r.requestId, 32), requestDigest: digest(r.requestDigest), operationId: hexN(r.operationId, 32) }; };
export function parseServiceProposalRecord(raw: unknown): Proposal {
  const o = raw as Rec;
  if (o?.kind === "service-proposal") {
    closed(raw, ["v", "kind", "proposalId", "proposalDigest", "account", "owner", "endpoint", "instanceId", "register", "createdAtMs", "expiresAtMs", "clusterDigests", "commands", "state"]);
    if (o.v !== 1) bad("unknown version");
    const s = o.state as Rec;
    const state = s?.state === "proposed" ? (closed(s, ["state"]), { state: "proposed" as const })
      : (closed(s, ["state", "operationId", "assignmentDigest"]), pick(s.state, ["approving"]), { state: "approving" as const, operationId: hexN(s.operationId, 32), assignmentDigest: digest(s.assignmentDigest) });
    return { v: 1, kind: "service-proposal", proposalId: hexN(o.proposalId, 64), proposalDigest: digest(o.proposalDigest), account: account(o.account),
      owner: owner(o.owner), endpoint: endpointName(o.endpoint), instanceId: token(o.instanceId, "instanceId"), register: registerRef(o.register),
      createdAtMs: ms(o.createdAtMs), expiresAtMs: ms(o.expiresAtMs), clusterDigests: grammar(() => parseServiceProposalClusters(o.clusterDigests)),
      commands: grammar(() => parseServiceProposalCommands(o.commands)), state };
  }
  closed(raw, ["v", "kind", "proposalId", "proposalDigest", "owner", "endpoint", "instanceId", "register", "state", "operationId", "approvalDigest", "reason", "atMs"]);
  if (o.v !== 1 || o.kind !== "service-proposal-terminal") bad("unknown version or kind");
  const t: ProposalTerminal = { v: 1, kind: "service-proposal-terminal", proposalId: hexN(o.proposalId, 64), proposalDigest: digest(o.proposalDigest), owner: owner(o.owner),
    endpoint: endpointName(o.endpoint), instanceId: token(o.instanceId, "instanceId"), register: registerRef(o.register), state: pick(o.state, ["approved", "refused", "expired"] as const),
    operationId: o.operationId === null ? null : hexN(o.operationId, 32), approvalDigest: o.approvalDigest === null ? null : digest(o.approvalDigest),
    reason: o.reason === null ? null : pick(o.reason, CLOSE_REASONS), atMs: ms(o.atMs) };
  if ((t.state === "approved") !== (t.approvalDigest !== null) || (t.state === "approved") === (t.reason !== null)) bad("terminal proposal fields do not match its state");
  return t;
}
export function parseServiceCapacityRecord(raw: unknown): Capacity {
  const o = closed(raw, ["v", "kind", "pending"]);
  if (o.v !== 1 || o.kind !== "service-proposal-capacity" || !Array.isArray(o.pending) || o.pending.length > S2A_MAX_PENDING) bad("invalid capacity row");
  const pending = o.pending.map((e) => { const x = closed(e, ["proposalId", "owner", "endpoint", "instanceId", "registerRequestId", "expiresAtMs"]);
    return { proposalId: hexN(x.proposalId, 64), owner: owner(x.owner), endpoint: endpointName(x.endpoint), instanceId: token(x.instanceId, "instanceId"), registerRequestId: hexN(x.registerRequestId, 32), expiresAtMs: ms(x.expiresAtMs) }; });
  if (pending.some((e, i) => i > 0 && !(pending[i - 1].proposalId < e.proposalId))) bad("capacity entries must be unique and sorted by proposalId");
  const perOwner = new Map<string, number>();
  for (const e of pending) perOwner.set(e.owner, (perOwner.get(e.owner) ?? 0) + 1);
  if ([...perOwner.values()].some((n) => n > S2A_MAX_PENDING_PER_OWNER)) bad("capacity entries exceed the per-owner bound");
  return { v: 1, kind: "service-proposal-capacity", pending };
}
export function parseServiceAssignmentRecord(raw: unknown): Assignment {
  const o = raw as Rec;
  const base = (x: Rec) => ({ v: 1 as const, kind: "service-assignment" as const, endpoint: endpointName(x.endpoint), instanceId: token(x.instanceId, "instanceId"),
    owner: owner(x.owner), proposalId: hexN(x.proposalId, 64), assignmentDigest: digest(x.assignmentDigest) });
  if (o?.v !== 1 || o?.kind !== "service-assignment") bad("unknown version or kind");
  if (o.state === "bound") {
    closed(raw, ["v", "kind", "state", "endpoint", "instanceId", "owner", "proposalId", "assignmentDigest", "reservation", "creation", "cancel"]);
    const r = reservation(o.reservation), c = closed(o.creation, ["operationId"]);
    if (contractDigest(r) !== o.assignmentDigest || r.assignment.endpoint !== o.endpoint || r.assignment.instanceId !== o.instanceId || r.assignment.owner !== o.owner)
      bad("the bound reservation does not match its assignment");
    return { ...base(o), state: "bound", reservation: r, creation: { operationId: token(c.operationId, "operationId") }, cancel: o.cancel === null ? null : cancelOf(o.cancel) };
  }
  closed(raw, ["v", "kind", "state", "endpoint", "instanceId", "owner", "proposalId", "assignmentDigest", "cancel"]); pick(o.state, ["fenced"]);
  return { ...base(o), state: "fenced", cancel: cancelOf(o.cancel) };
}
export type ServiceServeOperation = "register" | "activate" | "renew" | "ready";
const SERVE_OPERATIONS: readonly ServiceServeOperation[] = ["register", "activate", "renew", "ready"];
/** One public serving request, bound before its first effect. It holds no proof, token or reply. */
interface Intent {
  v: 1; kind: "service-request-intent"; operationId: string; operation: ServiceServeOperation; account: Account;
  owner: string; endpoint: string; instanceId: string; requestId: string; requestDigest: string;
  /** The registration the request names: register's expected witness (null for unregistered), or the request witness. */
  registrationRequestId: string | null; witnessDigest: string | null; admittedAtMs: number;
}
interface IntentIndex {
  v: 1; kind: "service-request-intent-index"; owner: string; endpoint: string; instanceId: string;
  intents: { operationId: string; operation: ServiceServeOperation }[];
}
export function parseServiceRequestIntentRecord(raw: unknown): Intent {
  const o = closed(raw, ["v", "kind", "operationId", "operation", "account", "owner", "endpoint", "instanceId", "requestId", "requestDigest",
    "registrationRequestId", "witnessDigest", "admittedAtMs"]);
  if (o.v !== 1 || o.kind !== "service-request-intent") bad("unknown version or kind");
  const operation = pick(o.operation, SERVE_OPERATIONS);
  const registrationRequestId = o.registrationRequestId === null ? null : hexN(o.registrationRequestId, 32);
  const witnessDigest = o.witnessDigest === null ? null : digest(o.witnessDigest);
  if ((registrationRequestId === null) !== (witnessDigest === null) || (operation !== "register" && witnessDigest === null))
    bad("a request intent names its registration exactly when it has a witness");
  return { v: 1, kind: "service-request-intent", operationId: hexN(o.operationId, 32), operation, account: account(o.account),
    owner: owner(o.owner), endpoint: endpointName(o.endpoint), instanceId: token(o.instanceId, "instanceId"), requestId: hexN(o.requestId, 32),
    requestDigest: digest(o.requestDigest), registrationRequestId, witnessDigest, admittedAtMs: ms(o.admittedAtMs) };
}
export function parseServiceRequestIntentIndexRecord(raw: unknown): IntentIndex {
  const o = closed(raw, ["v", "kind", "owner", "endpoint", "instanceId", "intents"]);
  if (o.v !== 1 || o.kind !== "service-request-intent-index") bad("unknown version or kind");
  if (!Array.isArray(o.intents) || o.intents.length === 0 || o.intents.length > S3_MAX_INTENTS_PER_INSTANCE) bad("invalid intent list");
  const intents = o.intents.map((x) => { const e = closed(x, ["operationId", "operation"]); return { operationId: hexN(e.operationId, 32), operation: pick(e.operation, SERVE_OPERATIONS) }; });
  if (intents.some((x, i) => i > 0 && intents[i - 1]!.operationId >= x.operationId)) bad("intents must be sorted and unique");
  return { v: 1, kind: "service-request-intent-index", owner: owner(o.owner), endpoint: endpointName(o.endpoint), instanceId: token(o.instanceId, "instanceId"), intents };
}

export function parseServiceAdmissionRecord(raw: unknown): Admission {
  const o = closed(raw, ["v", "kind", "state", "epoch", "restoreId"]);
  if (o.v !== 1 || o.kind !== "service-host-admission") bad("unknown version or kind");
  const epoch = ms(o.epoch);
  if (epoch < 1) bad("admission epochs start at 1");
  return { v: 1, kind: "service-host-admission", state: pick(o.state, ["open", "quarantined"] as const), epoch, restoreId: o.restoreId === null ? null : hexN(o.restoreId, 32) };
}

/** Every caller grant one service instance ever indexed, sorted by grantee uid then grant id. Only appended. */
interface CallerIndex { v: 1; kind: "service-caller-grant-index"; entries: Array<{ granteeUid: string; grantId: string }> }
export function parseServiceCallerIndexRecord(raw: unknown): CallerIndex {
  const o = closed(raw, ["v", "kind", "entries"]);
  if (o.v !== 1 || o.kind !== "service-caller-grant-index") bad("unknown version or kind");
  if (!Array.isArray(o.entries) || o.entries.length > S3_MAX_CALLER_GRANTS_PER_INSTANCE) bad("invalid caller grant index");
  const entries = o.entries.map((x) => { const e = closed(x, ["granteeUid", "grantId"]); return { granteeUid: token(e.granteeUid, "granteeUid"), grantId: hexN(e.grantId, 32) }; });
  if (entries.some((e, i) => i > 0 && !(byEntry(entries[i - 1]!, e) < 0))) bad("caller grant index entries must be unique and sorted");
  return { v: 1, kind: "service-caller-grant-index", entries };
}
const byEntry = (a: { granteeUid: string; grantId: string }, b: { granteeUid: string; grantId: string }) =>
  a.granteeUid < b.granteeUid ? -1 : a.granteeUid > b.granteeUid ? 1 : a.grantId < b.grantId ? -1 : a.grantId > b.grantId ? 1 : 0;

/** One revoked grant's immutable, op-bound cutoff marker. Its stored-message time fixes the deadline. */
interface CutoffMarker {
  v: 1; kind: "service-cutoff-marker"; accountPublicKey: string; space: string; operationId: string;
  target: { kind: "caller-grant"; grantee: ServicePrincipal; grantId: string; endpoint: string; instanceId: string }; authorityDigest: string;
}
export function parseServiceCutoffMarkerRecord(raw: unknown): CutoffMarker {
  const o = closed(raw, ["v", "kind", "accountPublicKey", "space", "operationId", "target", "authorityDigest"]);
  if (o.v !== 1 || o.kind !== "service-cutoff-marker") bad("unknown version or kind");
  const t = closed(o.target, ["kind", "grantee", "grantId", "endpoint", "instanceId"]); pick(t.kind, ["caller-grant"]);
  const a = account({ accountPublicKey: o.accountPublicKey, space: o.space });
  return { v: 1, kind: "service-cutoff-marker", ...a, operationId: hexN(o.operationId, 32),
    target: { kind: "caller-grant", grantee: principalOf(t.grantee), grantId: hexN(t.grantId, 32), endpoint: endpointName(t.endpoint), instanceId: token(t.instanceId, "instanceId") },
    authorityDigest: digest(o.authorityDigest) };
}

/** ceil(T) in epoch seconds for the server's raw stored-message time, or undefined unless it is
 *  exactly `YYYY-MM-DDTHH:MM:SS[.d{1,9}]Z` naming a real calendar second. The whole second is
 *  formatted back and compared, so a normalized date or a leap second never passes, and any
 *  non-zero fractional digit rounds up. No double or Date carries the fraction. */
export function serviceMarkerCeilSeconds(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(raw);
  if (!m) return undefined;
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  if (!Number.isSafeInteger(at) || at < 0 || new Date(at).toISOString().slice(0, 19) !== raw.slice(0, 19)) return undefined;
  return at / 1000 + (m[7] !== undefined && /[1-9]/.test(m[7]) ? 1 : 0);
}
/** The canonical cutoff deadline after the marker's time: ceil(T) + 60 + 2*5 + 1 seconds. */
export const SERVICE_CUTOFF_MARGIN_S = 71;

// ---- keyed reads and writes ---------------------------------------------------------------------

type Read<T> = { state: "absent" } | { state: "value"; row: T; bytes: Uint8Array; revision: number };

/** Leader-read one S2-A key. A deletion marker or spent tombstone holds under a key-specific
 *  reason and is never recreated; anything its closed parser refuses holds as malformed. */
async function read<T>(ctx: Ctx, key: string, what: string, parse: (v: unknown) => T): Promise<Read<T>> {
  const cur = await leader(ctx, "auth", key);
  if (cur.state === "absent") return cur;
  if (cur.state === "marker") return held(`${what}-tombstone`, ctx.step, `${key} carries a ${cur.op} marker; a spent key is never recreated`);
  if (cur.state === "malformed") return held(`${what}-malformed`, ctx.step, `${key} is not JSON`);
  try { return { state: "value", row: parse(cur.value), bytes: cur.bytes, revision: cur.revision }; }
  catch (e) { return held(`${what}-malformed`, ctx.step, message(e)); }
}
const readOp = (ctx: Ctx, id: string) => read(ctx, opKey(id), "operation", parseServiceHostOperationRecord);
const readProposal = (ctx: Ctx, id: string) => read(ctx, proposalKey(id), "proposal", parseServiceProposalRecord);
const readCapacity = (ctx: Ctx) => read(ctx, CAPACITY_KEY, "capacity", parseServiceCapacityRecord);
const readAssignment = (ctx: Ctx, endpointName: string, instanceId: string) => read(ctx, assignmentKey(endpointName, instanceId), "assignment", parseServiceAssignmentRecord);
const readAdmission = (ctx: Ctx) => read(ctx, ADMISSION_KEY, "admission", parseServiceAdmissionRecord);
const readIntent = (ctx: Ctx, id: string) => read(ctx, intentKey(id), "intent", parseServiceRequestIntentRecord);
const readIntentIndex = (ctx: Ctx, endpointName: string, instanceId: string) => read(ctx, intentIndexKey(endpointName, instanceId), "intent-index", parseServiceRequestIntentIndexRecord);

/** One zero-history create (no prior) or exact-revision CAS of a closed record. */
function put<T>(ctx: Ctx, key: string, row: T, parse: (v: unknown) => T, prior?: { revision: number; bytes: Uint8Array }): Promise<number | "moved"> {
  return write(ctx, "auth", key, encodeRoundTrip(row, parse), prior ? { revision: prior.revision, preimage: prior.bytes } : { create: true });
}
const byProposal = (a: CapEntry, b: CapEntry) => (a.proposalId < b.proposalId ? -1 : a.proposalId > b.proposalId ? 1 : 0);
const putCapacity = (ctx: Ctx, cap: Read<Capacity>, pending: CapEntry[]) =>
  put(ctx, CAPACITY_KEY, { v: 1, kind: "service-proposal-capacity", pending: [...pending].sort(byProposal) } satisfies Capacity, parseServiceCapacityRecord,
    cap.state === "value" ? cap : undefined);
const isEntry = (proposalId: string, registerRequestId: string) => (e: CapEntry) => e.proposalId === proposalId && e.registerRequestId === registerRequestId;
/** Canonical expiry only: an entry past `expiresAtMs` is ineligible. No grace is temporal proof. */
const eligible = (cap: Read<Capacity>, now: number) => (cap.state === "value" ? cap.row.pending.filter((e) => e.expiresAtMs > now) : []);

async function nameOf(ctx: Ctx, endpointName: string): Promise<ServiceNameView | undefined> {
  const r = await bounded(ctx, () => readNativeServiceName(ctx.h.registry, { accountPublicKey: ctx.h.accountPublicKey, space: ctx.h.space }, endpointName));
  if (!r.ok) return held("unavailable", ctx.step, "timedOut" in r ? "the service name read timed out" : message(r.error));
  return r.value;
}

/** Remove one proposal's capacity entry. True only when a read or this CAS observed it gone; an
 *  unobserved release is debt, never success. */
async function release(ctx: Ctx, proposalId: string, registerRequestId: string): Promise<boolean> {
  try {
    for (let i = 0; i < S2A_MAX_REDECIDE; i++) {
      const cap = await readCapacity(ctx);
      if (cap.state === "absent" || !cap.row.pending.some(isEntry(proposalId, registerRequestId))) return true;
      if ((await putCapacity(ctx, cap, cap.row.pending.filter((e) => !isEntry(proposalId, registerRequestId)(e)))) !== "moved") return true;
    }
    return false;
  } catch (e) {
    if (e instanceof Held && e.reason !== "readiness" && e.reason !== "post-write-readiness") return false;
    throw e;
  }
}

const isFinal = (p: Progress): p is Final => p.state === "complete" || p.state === "refused" || p.state === "superseded";
const sameDebt = (a: ServiceHostDebt[], b: ServiceHostDebt[]) => canonicalJson(a) === canonicalJson(b);

/** Re-read and CAS the live operation until `next` is durable or reports nothing to change. A
 *  terminal record is returned as stored. */
async function updateOp(ctx: Ctx, operationId: string, next: (op: OpLive) => OpLive | undefined): Promise<{ op: Op; wrote: boolean }> {
  for (let i = 0; i < S2A_MAX_REDECIDE; i++) {
    const cur = await readOp(ctx, operationId);
    if (cur.state === "absent") return held("reference-unavailable", ctx.step, "the operation binding is not readable");
    if (cur.row.kind !== "service-host-operation") return { op: cur.row, wrote: false };
    const n = next(cur.row);
    if (n === undefined) return { op: cur.row, wrote: false };
    if ((await put(ctx, opKey(operationId), n, parseServiceHostOperationRecord, cur)) !== "moved") return { op: n, wrote: true };
  }
  return held("contention", ctx.step);
}

/** Record an outcome (a stored one wins), keep any debt, then compact once no debt remains.
 *  `wrote` is whether this invocation recorded the outcome. */
async function settle(ctx: Ctx, operationId: string, outcome: Final | undefined, debts: ServiceHostDebt[]): Promise<{ op: Op; wrote: boolean }> {
  const step = await updateOp(ctx, operationId, (cur) => {
    const progress = isFinal(cur.progress) ? cur.progress : outcome;
    if (progress === undefined || (progress === cur.progress && sameDebt(cur.debt, debts))) return undefined;
    return { ...cur, progress, debt: debts };
  });
  const wrote = step.wrote && step.op.kind === "service-host-operation" && outcome !== undefined && step.op.progress === outcome;
  if (step.op.kind !== "service-host-operation" || !isFinal(step.op.progress) || step.op.debt.length) return { op: step.op, wrote };
  for (let i = 0; i < S2A_MAX_REDECIDE; i++) {
    const cur = await readOp(ctx, operationId);
    if (cur.state === "absent") return held("reference-unavailable", ctx.step, "the operation binding is not readable");
    if (cur.row.kind !== "service-host-operation") return { op: cur.row, wrote };
    const live = cur.row;
    if (!isFinal(live.progress) || live.debt.length) return { op: live, wrote };
    const terminal: OpTerminal = { v: 1, kind: "service-host-operation-terminal", operationId: live.operationId, requestId: live.requestId,
      requestDigest: live.requestDigest, operation: live.operation, account: live.account, granter: live.granter, admittedAtMs: live.admittedAtMs,
      projection: live.projection, outcome: live.progress };
    if ((await put(ctx, opKey(operationId), terminal, parseServiceHostOperationRecord, cur)) !== "moved") return { op: terminal, wrote };
  }
  return held("contention", ctx.step);
}
const outcomeOf = (op: Op): Final | undefined => (op.kind === "service-host-operation-terminal" ? op.outcome : isFinal(op.progress) ? op.progress : undefined);
const debtOf = (op: Op) => (op.kind === "service-host-operation" ? op.debt : []);

/** Retry recorded capacity debt; returns the debt that remains. */
async function retryDebt(ctx: Ctx, op: Op, registerRequestIdOf: (proposalId: string) => Promise<string | undefined>): Promise<ServiceHostDebt[]> {
  const left: ServiceHostDebt[] = [];
  for (const d of debtOf(op)) {
    const reg = await registerRequestIdOf(d.proposalId);
    if (d.kind !== "capacity-release" || reg === undefined || !(await release(ctx, d.proposalId, reg))) left.push(d);
  }
  return left;
}

// ---- engine -------------------------------------------------------------------------------------

/** What discovery located for one invocation before its effect connection opens. */
export interface ServiceHostScopeTarget {
  operation: "startup" | "register" | "decide" | "revoke" | "name-bind" | "serve" | "caller-grant" | "caller-revoke";
  operationId: string | null;
  proposalId: string | null;
  owner: string | null;
  endpoint: string | null;
  instanceId: string | null;
  lifecycleUid: string | null;
  /** A serving invocation's public operation; required exactly when `operation` is `serve`. */
  serve?: ServiceServeOperation;
  /** The contract artifacts (sha256 hex) a serving registration publishes. */
  contract?: readonly string[];
  /** A caller operation's grantee lifecycle uid, whose policy row it writes. */
  granteeUid?: string;
  /** A caller revoke's cutoff operation: the one whose marker key it may create. */
  cutoffOperationId?: string;
}
/** One invocation's scope: its target, the exact keys it may write and its original deadline. The
 *  engine guards every write with `keys` and never starts a request at or past `deadlineMs`, so an
 *  effect credential granted from the same keys and expiring from the same deadline cannot differ
 *  from it. */
export interface ServiceHostEffectScope extends ServiceHostScopeTarget { readonly keys: ServiceWriteScope; readonly reads: ServiceHostEffectReads; readonly deadlineMs: number }

/** The one key source for an invocation's writes: its own S2-A records, plus native custody's keys
 *  for the located reservation. A decide with a reservation can bootstrap it; a revoke only cancels. */
export function serviceHostScopeKeys(account: { accountPublicKey: string; space: string }, t: ServiceHostScopeTarget): ServiceWriteScope {
  const auth: string[] = [], records: string[] = [], authFamilies: string[] = [];
  const opKeyOf = () => opKey(hexN(t.operationId, 32));
  const custody = (run: "bootstrap" | "cancel") => {
    if (t.owner === null || t.endpoint === null || t.instanceId === null || t.lifecycleUid === null) return;
    const actor = serviceEndpointActor({ ...account, owner: t.owner, endpoint: t.endpoint, instanceId: t.instanceId });
    const k = serviceCustodyKeys({ owner: t.owner, actor, endpoint: t.endpoint, instanceId: t.instanceId, lifecycleUid: t.lifecycleUid }, run);
    records.push(...k.records); auth.push(...k.auth); authFamilies.push(...k.authFamilies);
  };
  switch (t.operation) {
    case "startup": auth.push(ADMISSION_KEY); break;
    case "register": auth.push(opKeyOf(), proposalKey(hexN(t.proposalId, 64)), CAPACITY_KEY); break;
    case "decide":
      auth.push(opKeyOf(), proposalKey(hexN(t.proposalId, 64)), CAPACITY_KEY);
      if (t.lifecycleUid !== null && t.endpoint !== null && t.instanceId !== null) { auth.push(assignmentKey(t.endpoint, t.instanceId)); custody("bootstrap"); }
      break;
    case "revoke":
      if (t.endpoint === null || t.instanceId === null) bad("a revoke scope names its selector");
      auth.push(opKeyOf(), assignmentKey(t.endpoint, t.instanceId), CAPACITY_KEY, ...(t.proposalId === null ? [] : [proposalKey(hexN(t.proposalId, 64))]));
      custody("cancel");
      break;
    case "name-bind":
      if (t.endpoint === null) bad("a name binding scope names its endpoint");
      auth.push(serviceNameKey(t.endpoint));
      break;
    // A caller operation writes its op, the grantee's policy row and the payload precondition's
    // withdrawal, plus the instance index for a grant or the cutoff marker for a revoke. No custody key.
    case "caller-grant":
      if (t.endpoint === null || t.instanceId === null || t.granteeUid === undefined) bad("a caller grant scope names its selector and grantee");
      auth.push(opKeyOf(), servicePolicyKey(t.granteeUid), callerIndexKey(t.endpoint, t.instanceId), SERVICE_CALLER_PAYLOAD_KEY);
      break;
    case "caller-revoke":
      if (t.granteeUid === undefined || t.cutoffOperationId === undefined) bad("a caller revoke scope names its grantee and cutoff operation");
      auth.push(opKeyOf(), servicePolicyKey(t.granteeUid), cutoffKey(t.cutoffOperationId), SERVICE_CALLER_PAYLOAD_KEY);
      break;
    case "serve": {
      // A serving request writes its intent and its instance's index, then only its own effect's keys.
      if (t.endpoint === null || t.instanceId === null || t.serve === undefined) bad("a serving scope names its selector and operation");
      auth.push(intentKey(hexN(t.operationId, 32)), intentIndexKey(t.endpoint, t.instanceId));
      if (t.serve === "register" || t.serve === "activate") auth.push(epgateKey(t.endpoint, t.instanceId));
      records.push(...serveRecordKeys(t).writes);
      break;
    }
  }
  const uniq = (a: string[]) => Object.freeze([...new Set(a)]);
  return Object.freeze({ records: uniq(records), auth: uniq(auth), authFamilies: uniq(authFamilies) });
}
/** A native registration writes and reads the spec and the endpoint's governance head; readiness
 *  writes the status and reads it with the spec. */
function serveRecordKeys(t: ServiceHostScopeTarget): { writes: string[]; reads: string[] } {
  if (t.operation !== "serve" || t.endpoint === null || t.instanceId === null) return { writes: [], reads: [] };
  const sel = [t.endpoint, assertLifecycleToken(t.instanceId, "instanceId")];
  const spec = recordSpecKey(RECORD_KINDS.svc, sel), status = recordStatusKey(RECORD_KINDS.svc, sel), govern = recordAtomicKey(GOVERN_HEAD, [t.endpoint]);
  if (t.serve === "register") return { writes: [spec, govern], reads: [spec, govern] };
  if (t.serve === "ready") return { writes: [status], reads: [spec, status] };
  return { writes: [], reads: [] };
}
/** What one invocation's effect credential may read by Direct Get and publish to the contract store. */
export function serviceHostScopeReads(t: ServiceHostScopeTarget): ServiceHostEffectReads {
  const contract = t.operation === "serve" && t.serve === "register" ? [...(t.contract ?? [])] : [];
  return Object.freeze({ records: Object.freeze([...new Set(serveRecordKeys(t).reads)]), contract: Object.freeze([...new Set(contract)]) });
}
const NO_WRITES: ServiceWriteScope = Object.freeze({ records: Object.freeze([]), auth: Object.freeze([]), authFamilies: Object.freeze([]) });
/** One per-invocation effect connection's registry. `gone` resolves when the connection is gone for
 *  good, which fences the invocation. `close` runs only after every awaited call returned. */
export interface ServiceHostEffect { registry: LifecycleRegistry; gone: Promise<void>; close(): Promise<void>;
  /** The contract store over the same connection; a serving registration holds without it. */
  contract?: ContractStoreContext }

/** Open one invocation's effect connection: a fresh identity whose credential publishes exactly
 *  `scope.keys`, never reconnects or renews, and expires at `scope.deadlineMs` rounded up to the
 *  whole second. The registry over it is the effect registry. */
export async function openServiceHostEffect(
  opts: { server: string; space: string; dataAccount: { pub: string; signingSeed: string }; log: (line: string) => void; onConnection?: (nc: NatsConnection, label: string) => void },
  scope: Pick<ServiceHostEffectScope, "keys" | "deadlineMs"> & { reads?: ServiceHostEffectReads },
): Promise<ServiceHostEffect> {
  const client = await openAuthorityClient({
    server: opts.server, space: opts.space, dataAccount: opts.dataAccount, log: opts.log, label: serviceHostEffectLabel(opts.space),
    grants: (connId) => serviceHostEffectGrants(opts.space, connId, scope.keys, scope.reads), noReconnect: true, serviceHostInvocation: { deadlineMs: scope.deadlineMs },
    ...(opts.onConnection ? { onConnection: opts.onConnection } : {}),
  });
  try {
    return { registry: await openLifecycleRegistry(client.nc, opts.space), gone: client.gone!, close: () => client.close(),
      contract: await contractStoreContext(client.nc, opts.space) };
  }
  catch (e) { await client.close().catch(() => {}); throw e; }
}
export interface ServiceHostOperationsOptions {
  /** A standing read-only registry used only to locate an invocation's keys. */
  discovery: LifecycleRegistry;
  openEffect(scope: ServiceHostEffectScope): Promise<ServiceHostEffect>;
  /** This process's genuine plane-claim hold; every invocation's custody host checks it. */
  hold: PlaneClaimHold;
  accountPublicKey: string;
  /** The actor ledger directory an owner's current interactive row is read from. */
  ledgerDir: string;
  /** Required. Only normal startup is supported; restore refuses construction. */
  startup?: { kind: "normal" } | { kind: "restore"; restoreId: string };
  /** Serving reads a registered closure's artifacts from the contract store; without it a
   *  serving read that needs them is unavailable. */
  serving?: { readContractArtifact(digest: string): Promise<unknown> };
}
/** One verified public serving request (SPEC 13.1). The face verified the proof: `owner` is an IdP
 *  owner, whose current interactive row the engine still requires, or a service proof's witness
 *  owner whose proof binds `witness`. */
export interface ServiceServeRequest {
  operation: ServiceServeOperation;
  caller: "owner" | "service";
  owner: string; endpoint: string; instanceId: string;
  /** The public request id and digest, and the engine request id of its full idempotency key. */
  requestId: string; requestDigest: string; engineRequestId: string;
  /** activate, renew and ready: the request witness. register: the expected witness, or null for unregistered. */
  witness: ServiceRegistrationWitness | null;
  /** register only: the compiled surface and the submitted artifacts. */
  register?: { clusterDigests: string[]; commands: Command[]; artifacts: unknown[] };
}
export type ServiceServeResult =
  | { state: "registered"; witness: ServiceRegistrationWitness; snapshot: ServiceRegistrationSnapshot }
  /** activate (after its CAS) and renew: the current registration and the fixed bounds material may not outlive. */
  | { state: "current"; witness: ServiceRegistrationWitness; snapshot: ServiceRegistrationSnapshot; rootExpiresAt: number; approvalExpiresAt: number | null }
  | { state: "ready"; witness: ServiceRegistrationWitness; reportedAt: number }
  | { state: "denied"; reason: string }
  /** Unread, unknown or inconsistent: the request may be bound, and its identity must be kept. */
  | { state: "unavailable"; detail: string };
/** One status query by a verified reader: an IdP owner, or a service proof's witness. */
export interface ServiceStatusQuery {
  owner: string; endpoint: string; instanceId: string;
  reader: { kind: "owner" } | { kind: "service"; witness: ServiceRegistrationWitness };
  target: { kind: "instance" } | { kind: "operation"; operation: ServiceServeOperation; engineRequestId: string };
}
export type ServiceStatusAnswer =
  | { kind: "status"; status: ServiceAuthorityStatus }
  /** A register with no intent: its proposal-phase operation record answers. */
  | { kind: "proposal-phase" }
  /** An owner reader without an interactive row. */
  | { kind: "denied"; reason: "permission-denied" }
  | { kind: "not-found" }
  | { kind: "unavailable"; detail: string };
export interface ServiceRegisterRequest {
  v: 1; kind: "service-endpoint-host"; requestId: string; operation: "register";
  input: { owner: string; endpoint: string; instanceId: string; clusterDigests: string[]; commands: Command[];
    /** The public request this admission serves, so a changed public body under one key is a conflict. */
    publicRequest?: { requestId: string; requestDigest: string } };
  granter: { kind: "owner"; owner: string };
}
export type ServiceRegisterResult = { v: 1; kind: "service-endpoint-host"; operation: "register"; requestId: string; space: string; accountPublicKey: string } & (
  | { state: "registered"; outcome: ServiceHostOutcome; operationId: string; proposalId: string; proposalDigest: string; revision: number; expiresAtMs: number; debt?: ServiceHostDebt[] }
  | Arms);
type Arms =
  | { state: "pending"; operationId: string; phase: string; notBefore?: number; assignmentDigest?: string; denyNew?: ServiceDenyNew; root?: "none" | "revoked" | "retained-stamped"; debt?: ServiceHostDebt[] }
  | { state: "held"; operationId: string; reason: string; phase: string; assignmentDigest?: string; denyNew?: ServiceDenyNew; debt?: ServiceHostDebt[] }
  | { state: "refused"; operationId: string; reason: ServiceOperationRefusal; boundOperationId?: string; debt?: ServiceHostDebt[] }
  | { state: "denied"; reason: ServiceHostReason; boundOperationId?: string };
export interface ServiceHostOperations {
  readonly space: string;
  readonly accountPublicKey: string;
  /** Internal register admission; the public register route that verifies the owner calls it. */
  register(raw: unknown): Promise<ServiceRegisterResult>;
  /** decide, revoke, name-bind, caller-grant, caller-revoke, operation-read, proposal-read and the two
   *  caller-policy reads; every other operation is `unsupported`. */
  handle(raw: unknown): Promise<ServiceHostResult>;
  /** One owner's assignment at a selector, from one discovery read of its record and endpoint gate.
   *  Another owner's assignment reads absent. For the authority door, which proved the owner. */
  serviceState(owner: string, endpoint: string, instanceId: string): Promise<ServiceAssignmentState>;
  /** One verified serving request: intent, quota and binding, then its effect (SPEC 13.1). */
  serve(request: ServiceServeRequest): Promise<ServiceServeResult>;
  /** Instance or serving-operation status, by the precedence rules; never a guessed absence. */
  serveStatus(query: ServiceStatusQuery): Promise<ServiceStatusAnswer>;
  /** The current bound assignment a service witness names, for the native service callout; throws otherwise. */
  serviceBinding(witness: ServiceRegistrationWitness): Promise<ServiceAssignmentBinding>;
  /** The engine-level fatal latch: refuses new invocations and trips every live invocation host. */
  trip(reason: string): void;
  /** From the moment it is called, refuses every later call with the latch's answers. */
  refuse(): void;
  /** Refuses every later call with the latch's answers, then resolves once every register or handle
   *  call that entered before it has returned, from entry: through discovery, effect open and its
   *  writes. It trips nothing; each call already in flight ends under its own discovery and
   *  invocation bounds. */
  close(): Promise<void>;
}

/** The current state of one assignment. `pending-root` has no approval on its endpoint gate yet;
 *  `revoking` has a bound cancel identity. `unavailable` is a failed or inconsistent read, never absence. */
export type ServiceAssignmentState =
  | { state: "absent" } | { state: "unavailable" }
  | { state: "pending-root"; proposalId: string; assignmentDigest: string }
  | { state: "approved"; proposalId: string; assignmentDigest: string; approvalDigest: string; registrationRequestId: string | null }
  | { state: "revoking"; proposalId: string; assignmentDigest: string; operationId: string; denyNew: ServiceDenyNew };

interface Inv { host: ServiceCustodyHost; h: HostInternals; writes: ServiceWriteScope; endMs: number; operationId: string; bound: boolean; assignmentDigest?: string; contract?: ContractStoreContext }
const denied = (reason: ServiceHostReason, boundOperationId?: string): Arms => ({ state: "denied", reason, ...(boundOperationId ? { boundOperationId } : {}) });
const refusedArm = (operationId: string, reason: ServiceOperationRefusal, debts: ServiceHostDebt[], boundOperationId?: string): Arms =>
  ({ state: "refused", operationId, reason, ...(boundOperationId ? { boundOperationId } : {}), ...(debts.length ? { debt: debts } : {}) });
const finalArm = (operationId: string, f: Exclude<Final, { state: "complete" }>, debts: ServiceHostDebt[]): Arms =>
  f.state === "refused" ? refusedArm(operationId, f.reason, debts) : refusedArm(operationId, "superseded", debts, f.boundOperationId);

function badRequest(detail: string): never { throw new EpEnvelopeError("bad-request", `service host request: ${detail}`); }

/** The host register request a public register's proposal phase admits. Serving recomputes it, so
 *  one public request key binds one body across both phases. */
export function serviceRegisterHostRequest(r: { owner: string; endpoint: string; instanceId: string; engineRequestId: string;
  requestId: string; requestDigest: string; clusterDigests: string[]; commands: Command[] }): ServiceRegisterRequest {
  return { v: 1, kind: "service-endpoint-host", requestId: r.engineRequestId, operation: "register", granter: { kind: "owner", owner: r.owner },
    input: { owner: r.owner, endpoint: r.endpoint, instanceId: r.instanceId, clusterDigests: r.clusterDigests, commands: r.commands,
      publicRequest: { requestId: r.requestId, requestDigest: r.requestDigest } } };
}

/** Structural admission of the internal register request. */
export function parseServiceRegisterRequest(raw: unknown): ServiceRegisterRequest {
  let o: Rec, input: Rec, g: Rec;
  try {
    o = closed(raw, ["v", "kind", "requestId", "operation", "input", "granter"]);
    if (o.v !== 1 || o.kind !== "service-endpoint-host" || o.operation !== "register") bad("unknown version, kind or operation");
    hexN(o.requestId, 32);
    g = closed(o.granter, ["kind", "owner"]); pick(g.kind, ["owner"]); owner(g.owner);
    input = closed(o.input, ["owner", "endpoint", "instanceId", "clusterDigests", "commands"], ["publicRequest"]);
    owner(input.owner); endpointName(input.endpoint); token(input.instanceId, "instanceId");
    if (Object.hasOwn(input, "publicRequest")) { const pr = closed(input.publicRequest, ["requestId", "requestDigest"]); hexN(pr.requestId, 32); digest(pr.requestDigest); }
  } catch (e) { return badRequest(message(e)); }
  const clusterDigests = parseServiceProposalClusters(input.clusterDigests), commands = parseServiceProposalCommands(input.commands);
  if (commands.some((c) => !clusterDigests.includes(c.clusterDigest))) badRequest("every command must come from a submitted cluster");
  return structuredClone(o) as unknown as ServiceRegisterRequest;
}

export async function openServiceHostOperations(opts: ServiceHostOperationsOptions): Promise<ServiceHostOperations> {
  if (opts.startup === undefined) throw new EpEnvelopeError("failed-precondition", "service host operations require an explicit startup kind");
  if (opts.startup.kind !== "normal") throw new EpEnvelopeError("unimplemented", "restore startup is not supported; a restored store stays closed");
  // Discovery only reads: its host writes nothing at all.
  const discovery = openServiceCustodyHost({ registry: opts.discovery, hold: opts.hold, accountPublicKey: opts.accountPublicKey, writes: NO_WRITES });
  const space = discovery.host.space, accountPublicKey = opts.accountPublicKey;
  const live = new Set<(reason: string) => void>();
  let tripped: string | undefined, closed = false;
  /** Every register and handle call, from entry until it returns. */
  const entered = new Set<Promise<unknown>>();
  const tracked = <T>(p: Promise<T>): Promise<T> => {
    entered.add(p);
    p.then(() => entered.delete(p), () => entered.delete(p));
    return p;
  };
  const discoveryCtx = (step: string) => { const c = context(HOSTS.get(discovery.host)!, Date.now() + S2A_INVOCATION_MS); c.step = step; return c; };

  /** One invocation: an effect connection for the discovered scope and its original deadline, one
   *  custody host over it sharing the process hold and writing only the scope's keys, and the
   *  engine latch. The connection's loss trips the host. Every awaited call returns before close. */
  async function invoke<T>(target: ServiceHostScopeTarget, run: (inv: Inv) => Promise<T>, deadlineMs = Date.now() + S2A_INVOCATION_MS): Promise<T> {
    if (tripped !== undefined) throw new Held("readiness", "open", `the service host is fenced: ${tripped}`);
    const keys = serviceHostScopeKeys({ accountPublicKey, space }, target), reads = serviceHostScopeReads(target);
    const scope: ServiceHostEffectScope = Object.freeze({ ...target, keys, reads, deadlineMs });
    let effect: ServiceHostEffect;
    try { effect = await opts.openEffect(scope); }
    catch (e) { throw new Held("unavailable", "effect-open", `the invocation's effect connection did not open: ${message(e)}`); }
    try {
      const opened = openServiceCustodyHost({ registry: effect.registry, hold: opts.hold, accountPublicKey, writes: keys }), host = opened.host;
      if (host.space !== space) throw new EpEnvelopeError("permission-denied", "the effect registry belongs to another space");
      // A native registration and a ready status write through their own client, not the custody
      // writer: a trip also closes their connection, so none of their requests is issued after the
      // fence. A request already issued stays unknown.
      const native = target.operation === "serve" && (target.serve === "register" || target.serve === "ready");
      const trip = (reason: string) => { opened.trip(reason); if (native) void effect.close().catch(() => {}); };
      live.add(trip);
      if (tripped !== undefined) trip(tripped);
      // Attached before the first request: a write issued after the loss holds, one in flight across it reports held.
      void effect.gone.then(() => trip("the invocation's effect connection is gone"));
      const h = HOSTS.get(host)!;
      try { return await run({ host, h, writes: h.writes!, endMs: deadlineMs, operationId: target.operationId ?? "", bound: true, ...(effect.contract ? { contract: effect.contract } : {}) }); }
      finally { live.delete(trip); }
    } finally { await effect.close(); }
  }
  const readCtx = (inv: Inv, step: string) => { const c = context(inv.h, inv.endMs); c.step = step; return c; };
  /** Hold before a native custody run whose keys this invocation's scope does not cover. A replay
   *  of the same request discovers the stored reservation and scopes it. */
  const coverCustody = (inv: Inv, ctx: Ctx, reservation: ServiceUidCustodyV1, run: "bootstrap" | "cancel") => {
    const need = serviceReservationKeys(inv.host, reservation, run);
    const gap = [...need.records.filter((k) => !scopeCovers(inv.writes, "records", k)), ...need.auth.filter((k) => !scopeCovers(inv.writes, "auth", k)),
      ...need.authFamilies.filter((f) => !inv.writes.authFamilies.includes(f))];
    if (gap.length) held("scope-mismatch", ctx.step, `native custody needs ${gap.join(", ")} outside this invocation's write scope`);
  };
  /** Normal advancement only, and only before the original deadline. */
  const authorityCtx = (inv: Inv, notAfterMs: number, step: string) => { const c = context(inv.h, Math.min(inv.endMs, notAfterMs)); c.step = step; return c; };
  /** A held step names its operation whenever the request may be bound: until this invocation's own
   *  binding read finds the key absent, and again once its create may be issued. Only a step after
   *  that absence is a zero-write denial, and the absence is point-in-time: another invocation of
   *  the same request already in flight can still bind it later. */
  const heldArm = (inv: Inv, e: Held): Arms => {
    const reason = e.reason === "deadline" && Date.now() >= inv.endMs ? "reconcile-pending" : e.reason;
    return inv.bound ? { state: "held", operationId: inv.operationId, reason, phase: e.step, ...(inv.assignmentDigest ? { assignmentDigest: inv.assignmentDigest } : {}) } : denied("unavailable");
  };
  /** A discovery read failed. A request that is or may be bound is never a zero-write denial; one
   *  bound to another body is a conflict, as its admission would answer. */
  const discoveryHeld = (operationId: string, requestDigest: string, found: Read<Op> | undefined, e: Held, assignmentDigest?: string): Arms => {
    if (found?.state === "absent") return denied("unavailable");
    if (found?.state === "value" && found.row.requestDigest !== requestDigest) return denied("conflict");
    return { state: "held", operationId, reason: e.reason, phase: e.step, ...(assignmentDigest ? { assignmentDigest } : {}) };
  };
  /** The held arm of a request this invocation read nothing about: its deterministic operation
   *  coordinate, the same whether or not the request is bound or its granter authorized. */
  const unread = (requestId: string, reason: string, phase: string, assignmentDigest?: string): Arms =>
    ({ state: "held", operationId: serviceHostOperationId(space, requestId), reason, phase, ...(assignmentDigest ? { assignmentDigest } : {}) });
  const interactive = (o: string) => {
    try { return (findInteractiveActor(opts.ledgerDir, o, "cli") ?? findInteractiveActor(opts.ledgerDir, o, "web")) !== undefined; }
    catch { return false; }
  };

  // Normal-startup admission: absent creates `open` epoch 1; `open` is used; `quarantined` stays.
  // An unknown or unavailable create fails construction closed.
  await invoke({ operation: "startup", operationId: null, proposalId: null, owner: null, endpoint: null, instanceId: null, lifecycleUid: null }, async (inv) => {
    const ctx = readCtx(inv, "admission");
    for (let i = 0; i < S2A_MAX_REDECIDE; i++) {
      const a = await readAdmission(ctx);
      if (a.state === "value") return;
      await put(ctx, ADMISSION_KEY, { v: 1, kind: "service-host-admission", state: "open", epoch: 1, restoreId: null } satisfies Admission, parseServiceAdmissionRecord);
    }
    held("contention", ctx.step);
  });

  // ---- register (R1-R7) ---------------------------------------------------------------------------

  const proposalBodyDigest = (sel: { owner: string; endpoint: string; instanceId: string }, clusterDigests: string[], commands: Command[]) =>
    contractDigest({ v: 1, kind: "service-proposal-body", accountPublicKey, space, ...sel, clusterDigests, commands });

  type Selector = { owner: string; endpoint: string; instanceId: string };
  type Registered = { state: "registered"; outcome: ServiceHostOutcome; operationId: string; proposalId: string; proposalDigest: string; revision: number; expiresAtMs: number; debt?: ServiceHostDebt[] };
  /** R3: the initial refusal reasons, from one read of each authority. */
  async function registerRefusal(ctx: Ctx, sel: Selector, cap: Read<Capacity>, now: number, epoch?: number): Promise<{ reason?: ServiceOperationRefusal & ServiceHostReason; epoch: number }> {
    const adm = await readAdmission(ctx);
    if (adm.state === "absent" || adm.row.state !== "open" || (epoch !== undefined && adm.row.epoch !== epoch)) return { reason: "admission-closed", epoch: adm.state === "value" ? adm.row.epoch : 0 };
    const live = eligible(cap, now);
    if (live.some((e) => e.endpoint === sel.endpoint && e.instanceId === sel.instanceId)) return { reason: "selector-pending", epoch: adm.row.epoch };
    if (live.length >= S2A_MAX_PENDING || live.filter((e) => e.owner === sel.owner).length >= S2A_MAX_PENDING_PER_OWNER) return { reason: "resource-exhausted", epoch: adm.row.epoch };
    if ((await readAssignment(ctx, sel.endpoint, sel.instanceId)).state === "value") return { reason: "selector-bound", epoch: adm.row.epoch };
    const name = await nameOf(ctx, sel.endpoint);
    if (name !== undefined && name.owner !== sel.owner) return { reason: "name-owned", epoch: adm.row.epoch };
    return { epoch: adm.row.epoch };
  }

  async function register(raw: unknown): Promise<ServiceRegisterResult> {
    const req = parseServiceRegisterRequest(raw);
    const env = { v: 1 as const, kind: "service-endpoint-host" as const, operation: "register" as const, requestId: req.requestId, space, accountPublicKey };
    const out = (a: Arms | Registered) => ({ ...env, ...a }) as ServiceRegisterResult;
    // The latch comes before the ledger and every broker read; a tripped engine cannot tell a bound request.
    if (tripped !== undefined || closed) return out(unread(req.requestId, "readiness", "open"));
    const { owner: o, endpoint: e, instanceId: i, clusterDigests, commands } = req.input;
    if (req.granter.owner !== o) return out(denied("permission-denied"));                                   // never binds
    // Authorization precedes every request-key read, and its refusal is one answer whether or not the request is bound.
    if (!interactive(o)) return out(unread(req.requestId, "permission-denied", "authorize"));
    // A native control endpoint is never a service name: refused before any effect, like a name binding.
    try { serviceNameKey(e); }
    catch (err) { if (err instanceof EpEnvelopeError && err.code === "permission-denied") return out(denied("permission-denied")); throw err; }   // never binds
    const operationId = serviceHostOperationId(space, req.requestId), requestDigest = requestDigestOf(req);
    const proposalDigest = proposalBodyDigest({ owner: o, endpoint: e, instanceId: i }, clusterDigests, commands);
    const proposalId = proposalIdOf(proposalDigest, req.requestId);
    const proposalRow = (p: RegisterPlan): ProposalLive => ({ v: 1, kind: "service-proposal", proposalId, proposalDigest, account: { accountPublicKey, space },
      owner: o, endpoint: e, instanceId: i, register: { requestId: req.requestId, requestDigest, operationId }, createdAtMs: p.createdAtMs, expiresAtMs: p.expiresAtMs,
      clusterDigests, commands, state: { state: "proposed" } });
    if (enc.encode(JSON.stringify(proposalRow({ kind: "register", proposalId, proposalDigest, createdAtMs: 0, expiresAtMs: 0 }))).length > S2A_MAX_PROPOSAL_BYTES)
      return out(denied("bad-request"));
    const sel = { owner: o, endpoint: e, instanceId: i };
    try {
      return out(await invoke({ operation: "register", operationId, proposalId, owner: o, endpoint: e, instanceId: i, lifecycleUid: null }, async (inv) => {
        try {
          const ctx = readCtx(inv, "R2-binding");
          for (let n = 0; ; n++) {
            if (n >= S2A_MAX_REDECIDE) held("contention", ctx.step);
            const op = await readOp(ctx, operationId);
            if (op.state === "value") {
              if (op.row.requestDigest !== requestDigest) return denied("conflict");
              return await advanceRegister(inv, op.row);
            }
            inv.bound = false;
            ctx.step = "R3-decide";
            const now = Date.now(), cap = await readCapacity(ctx);
            const decision = await registerRefusal(ctx, sel, cap, now);
            if (decision.reason !== undefined) return denied(decision.reason);
            ctx.step = "R4-binding";
            const binding: OpLive = { v: 1, kind: "service-host-operation", operationId, requestId: req.requestId, requestDigest, operation: "register",
              account: { accountPublicKey, space }, granter: req.granter, admittedAtMs: now, notAfterMs: now + S2A_OPERATION_TTL_MS, admissionEpoch: decision.epoch,
              projection: { subjectOwner: o, endpoint: e, instanceId: i, proposalId },
              plan: { kind: "register", proposalId, proposalDigest, createdAtMs: now, expiresAtMs: now + S2A_PROPOSAL_LIFETIME_MS }, progress: { state: "admitted" }, debt: [] };
            // The create may be issued from here, so a held step names the operation.
            inv.bound = true;
            if ((await put(ctx, opKey(operationId), binding, parseServiceHostOperationRecord)) !== "moved") return await advanceRegister(inv, binding);
            // A lost create is a concurrent first use, so the request stays possibly bound: re-read, then conflict or replay.
          }
        } catch (err) { if (err instanceof Held) return heldArm(inv, err); throw err; }
      }));
    } catch (err) { if (err instanceof Held) return out(unread(req.requestId, err.reason, err.step)); throw err; }

    async function advanceRegister(inv: Inv, first: Op): Promise<Arms | Registered> {
      const ctx = readCtx(inv, "R-replay");
      // The digest is the binding's own: a matching request digest fixes the same proposal body.
      const registered = (r: RegisterResult, outcome: ServiceHostOutcome, debts: ServiceHostDebt[] = []): Registered => ({ state: "registered", outcome, operationId, proposalDigest, ...r, ...(debts.length ? { debt: debts } : {}) });
      const recorded = async (op: Op) => {
        const f = outcomeOf(op)!, left = await retryDebt(ctx, op, async () => req.requestId);
        const s = await settle(ctx, operationId, undefined, left);
        return f.state === "complete" ? registered(f.result as RegisterResult, "recorded", debtOf(s.op)) : finalArm(operationId, f, debtOf(s.op));
      };
      if (outcomeOf(first) !== undefined) return recorded(first);
      const op = first as OpLive, p = op.plan as RegisterPlan;
      /** Close the op: release my entry first, then record the outcome with any debt. */
      const close = async (f: Final) => {
        const debts: ServiceHostDebt[] = (await release(ctx, proposalId, req.requestId)) ? [] : [{ kind: "capacity-release", proposalId }];
        const s = await settle(ctx, operationId, f, debts), stored = outcomeOf(s.op)!;
        if (stored.state === "complete") return registered(stored.result as RegisterResult, s.wrote ? "applied" : "recorded", debtOf(s.op));
        return finalArm(operationId, stored, debtOf(s.op));
      };
      /** R6's one rule for a present proposal. */
      const fromProposal = async (prop: Extract<Read<Proposal>, { state: "value" }>) => {
        const r = prop.row;
        if (r.proposalDigest !== proposalDigest || r.register.operationId !== operationId || r.register.requestId !== req.requestId || r.register.requestDigest !== requestDigest)
          return close({ state: "refused", reason: "conflict" });
        if (r.kind === "service-proposal-terminal" && r.state === "expired") return close({ state: "refused", reason: "expired" });
        const done: Final = { state: "complete", result: { proposalId, revision: prop.revision, expiresAtMs: p.expiresAtMs } };
        if (r.kind === "service-proposal") {
          const s = await settle(ctx, operationId, done, []), stored = outcomeOf(s.op)!;
          return stored.state === "complete" ? registered(stored.result as RegisterResult, s.wrote ? "applied" : "recorded") : finalArm(operationId, stored, debtOf(s.op));
        }
        return close(done);
      };
      /** Past the register bound with the proposal absent: same-key fence, release, refuse. */
      const bound = async () => {
        ctx.step = "R-bound";
        const fence: ProposalTerminal = { v: 1, kind: "service-proposal-terminal", proposalId, proposalDigest, owner: o, endpoint: e, instanceId: i,
          register: { requestId: req.requestId, requestDigest, operationId }, state: "expired", operationId: null, approvalDigest: null, reason: "expired", atMs: Date.now() };
        await put(ctx, proposalKey(proposalId), fence, parseServiceProposalRecord);
        const prop = await readProposal(ctx, proposalId);
        if (prop.state === "absent") return held("proposal-unreadable", ctx.step, "the fenced proposal key is not readable");
        return fromProposal(prop);
      };

      ctx.step = "R6-proposal";
      let prop = await readProposal(ctx, proposalId);
      if (prop.state === "value") return fromProposal(prop);
      if (Date.now() >= op.notAfterMs) return bound();
      for (let n = 0; ; n++) {
        if (n >= S2A_MAX_REDECIDE) held("contention", "R5-capacity");
        ctx.step = "R5-capacity";
        const now = Date.now(), cap = await readCapacity(ctx);
        if (cap.state === "value" && cap.row.pending.some(isEntry(proposalId, req.requestId))) break;
        const decision = await registerRefusal(ctx, sel, cap, now, op.admissionEpoch);
        if (decision.reason !== undefined) return close({ state: "refused", reason: decision.reason });
        if (Date.now() >= op.notAfterMs) return bound();
        const entry: CapEntry = { proposalId, owner: o, endpoint: e, instanceId: i, registerRequestId: req.requestId, expiresAtMs: p.expiresAtMs };
        if ((await putCapacity(authorityCtx(inv, op.notAfterMs, "R5-capacity"), cap, [...eligible(cap, now), entry])) !== "moved") break;
      }
      if (Date.now() >= op.notAfterMs) return bound();
      await put(authorityCtx(inv, op.notAfterMs, "R6-proposal"), proposalKey(proposalId), proposalRow(p), parseServiceProposalRecord);
      ctx.step = "R6-proposal";
      prop = await readProposal(ctx, proposalId);
      if (prop.state === "absent") return held("proposal-unreadable", ctx.step, "the created proposal is not readable");
      return fromProposal(prop);
    }
  }

  // ---- shared closes ------------------------------------------------------------------------------

  type Live<T> = Extract<Read<T>, { state: "value" }>;
  const tombstone = (p: ProposalLive, state: ProposalTerminal["state"], operationId: string | null, approvalDigest: string | null, reason: ServiceProposalCloseReason | null): ProposalTerminal => ({
    v: 1, kind: "service-proposal-terminal", proposalId: p.proposalId, proposalDigest: p.proposalDigest, owner: p.owner, endpoint: p.endpoint, instanceId: p.instanceId,
    register: p.register, state, operationId, approvalDigest, reason, atMs: Date.now() });
  const causeReason = (c: Cancel | null): "expired" | "revoked" => (c?.cause === "approval-expired" ? "expired" : "revoked");
  const toRefusal = (t: ProposalTerminal): { reason: ServiceOperationRefusal; bound?: string } =>
    t.state === "approved" ? { reason: "superseded", bound: t.operationId ?? undefined } : { reason: t.reason ?? "expired" };

  /** Close a live proposal with a terminal CAS when `matches` still holds; re-read on a loss.
   *  Returns the proposal as finally read. Proposal-first: callers release only after this. */
  async function closeProposal(ctx: Ctx, proposalId: string, matches: (p: ProposalLive, revision: number) => ProposalTerminal | undefined): Promise<Live<Proposal>> {
    for (let i = 0; i < S2A_MAX_REDECIDE; i++) {
      const prop = await readProposal(ctx, proposalId);
      if (prop.state === "absent") return held("proposal-unreadable", ctx.step, "the proposal record is not readable");
      if (prop.row.kind !== "service-proposal") return prop;
      const next = matches(prop.row, prop.revision);
      if (next === undefined) return prop;
      await put(ctx, proposalKey(proposalId), next, parseServiceProposalRecord, prop);
    }
    return held("contention", ctx.step);
  }
  /** Release a terminal proposal's entry; the debt it leaves when unobserved. */
  const releaseFor = async (ctx: Ctx, p: Proposal): Promise<ServiceHostDebt[]> =>
    (await release(ctx, p.proposalId, p.register.requestId)) ? [] : [{ kind: "capacity-release", proposalId: p.proposalId }];

  /** V4: once deny-new has landed (or the assignment is fenced), close an `approving` proposal of
   *  this assignment truthfully from the gate, then release its capacity. */
  async function v4(ctx: Ctx, asg: Assignment, gate: EndpointClass | undefined): Promise<ServiceHostDebt[]> {
    ctx.step = "V4-close";
    const landed = gate && (gate.kind === "approved" || gate.kind === "revoked") ? gate.row.serviceAuthority.approvalDigest : null;
    const prop = await closeProposal(ctx, asg.proposalId, (p) => p.state.state === "approving" && p.state.assignmentDigest === asg.assignmentDigest
      ? (landed ? tombstone(p, "approved", p.state.operationId, landed, null) : tombstone(p, "refused", p.state.operationId, null, causeReason(asg.cancel)))
      : undefined);
    return prop.row.kind === "service-proposal-terminal" ? releaseFor(ctx, prop.row) : [];
  }

  /** Deny-new from one read of this assignment's endpoint gate, on every revoke path that reads it. Another
   *  assignment's row at the key is no evidence about this one's deny-new: `unknown`, as a failed read. */
  const denyNewOf = (gate: EndpointClass): ServiceDenyNew => (gate.kind === "revoked" ? "landed" : gate.kind === "foreign" ? "unknown" : "not-landed");
  type CancelRun = { s1: ServiceCancelResult | { kind: "seal-refused"; detail: string }; denyNew: ServiceDenyNew; gate?: EndpointClass };
  /** V3: native cancellation of a bound assignment with the material recorded in `svcasg`, then
   *  the endpoint gate read that decides whether deny-new landed. S1 is awaited, never raced. */
  async function nativeCancel(inv: Inv, ctx: Ctx, asg: Extract<Assignment, { state: "bound" }>, cancel: Cancel): Promise<CancelRun> {
    coverCustody(inv, ctx, asg.reservation, "cancel");
    let s1: CancelRun["s1"];
    try {
      const intent = sealServiceCancelIntent(inv.host, { reservation: asg.reservation, opId: cancel.operationId, requestDigest: cancel.requestDigest });
      s1 = await cancelServiceCustody(intent, { deadlineMs: ctx.deadlineMs });
    } catch (e) {
      if (!(e instanceof EpEnvelopeError)) throw e;
      s1 = { kind: "seal-refused", detail: e.message };
    }
    ctx.step = "V3-gate";
    try {
      const gate = await endpoint(ctx, serviceAssignmentGate(inv.host, asg.reservation));
      return { s1, gate, denyNew: denyNewOf(gate) };
    } catch (e) {
      if (e instanceof Held || e instanceof EpEnvelopeError) return { s1, denyNew: "unknown" };
      throw e;
    }
  }

  // ---- decide: approve (A1-A5) and refuse ---------------------------------------------------------

  type DecideOut = Arms | { state: "approved"; outcome: ServiceHostOutcome; approval: ServiceApprovalResult; debt?: ServiceHostDebt[] }
    | { state: "refused"; outcome: ServiceHostOutcome; proposal: ServiceProposalTombstoneView; revision: number; debt?: ServiceHostDebt[] };
  const view = (t: ProposalTerminal): ServiceProposalTombstoneView => ({ proposalId: t.proposalId, proposalDigest: t.proposalDigest, owner: t.owner, endpoint: t.endpoint,
    instanceId: t.instanceId, register: t.register, state: t.state, operationId: t.operationId, approvalDigest: t.approvalDigest, reason: t.reason, at: seconds(t.atMs) });

  async function decide(req: Extract<ServiceHostRequest, { operation: "decide" }>, authorized: boolean): Promise<DecideOut> {
    // Authorization precedes every request-key read, and its refusal is one answer whether or not the request is bound.
    if (!authorized) return unread(req.requestId, "permission-denied", "authorize");
    const operationId = serviceHostOperationId(space, req.requestId), requestDigest = requestDigestOf(req), { proposalId } = req.input;
    const approve = req.input.decision === "approve";
    type Admitted = { kind: "out"; out: DecideOut } | { kind: "bind"; binding: OpLive };
    const out = (o: DecideOut): Admitted => ({ kind: "out", out: o });
    const granterOwner = req.granter.kind === "owner" ? req.granter.owner : null;
    const scope: ServiceHostScopeTarget = { operation: "decide", operationId, proposalId, owner: null, endpoint: null, instanceId: null, lifecycleUid: null };
    let found: Read<Op> | undefined;
    try {
      const dctx = discoveryCtx("discover");
      const op = found = await readOp(dctx, operationId), prop = await readProposal(dctx, proposalId);
      // A stored approve scopes its own reservation; a first use scopes the one it is about to admit.
      if (op.state === "value" && op.row.kind === "service-host-operation" && op.row.plan.kind === "approve") {
        const a = op.row.plan.reservation.assignment;
        Object.assign(scope, { owner: a.owner, endpoint: a.endpoint, instanceId: a.instanceId, lifecycleUid: op.row.plan.reservation.native.lifecycleUid });
      } else if (op.state === "absent" && approve) {
        scope.lifecycleUid = mintLifecycleUid();
        if (prop.state === "value") Object.assign(scope, { owner: prop.row.owner, endpoint: prop.row.endpoint, instanceId: prop.row.instanceId });
      }
    } catch (e) { if (e instanceof Held) return discoveryHeld(operationId, requestDigest, found, e); throw e; }
    try {
      return await invoke(scope, async (inv) => {
        inv.operationId = operationId;
        try {
          const ctx = readCtx(inv, "admit");
          for (let n = 0; ; n++) {
            if (n >= S2A_MAX_REDECIDE) held("contention", ctx.step);
            const op = await readOp(ctx, operationId);
            if (op.state === "value" && op.row.requestDigest === requestDigest) {
              if (req.granter.kind === "owner" && op.row.projection.subjectOwner !== req.granter.owner)
                return { state: "held", operationId, reason: "permission-denied", phase: "authorize" };
              return approve ? await advanceApprove(inv, op.row) : await advanceRefuse(inv, op.row);
            }
            if (op.state === "value") return denied("conflict");
            inv.bound = false;
            const admitted = approve ? await admitApprove(inv, ctx, scope.lifecycleUid!) : await admitRefuse(inv, ctx);
            if (admitted.kind === "out") return admitted.out;
            inv.bound = true;
            if ((await put(ctx, opKey(operationId), admitted.binding, parseServiceHostOperationRecord)) !== "moved")
              return approve ? await advanceApprove(inv, admitted.binding) : await advanceRefuse(inv, admitted.binding);
          }
        } catch (err) { if (err instanceof Held) return heldArm(inv, err); throw err; }
      });
    } catch (err) { if (err instanceof Held) return discoveryHeld(operationId, requestDigest, found, err); throw err; }


    async function admitApprove(inv: Inv, ctx: Ctx, lifecycleUid: string): Promise<Admitted> {
      ctx.step = "A0-admit";
      const adm = await readAdmission(ctx);
      if (adm.state === "absent" || adm.row.state !== "open") return out(denied("admission-closed"));
      const prop = await readProposal(ctx, proposalId);
      if (prop.state === "absent" || prop.row.owner !== granterOwner) return out(denied("not-found"));
      if (prop.row.kind !== "service-proposal") return out(denied("conflict"));
      const p = prop.row;
      if (p.state.state === "approving") return out(denied("approval-in-progress", p.state.operationId));
      if (prop.revision !== req.input.expectedProposalRevision) return out(denied("conflict"));
      const now = Date.now();
      if (p.expiresAtMs <= now) return out(denied("expired"));
      if (!eligible(await readCapacity(ctx), now).some(isEntry(proposalId, p.register.requestId))) return out(denied("expired"));
      const name = await nameOf(ctx, p.endpoint);
      if (name === undefined || name.owner !== p.owner) return out(denied("name-claim-required"));
      if (name.revision !== req.input.expectedNameRevision) return out(denied("conflict"));
      const ceiling = parseEndpointCapabilities(req.input.callerCeiling);
      if (ceiling.some((c) => !ceilingEntryAdmitted(c, p))) return out(denied("bad-request"));
      const reservation: ServiceUidCustodyV1 = { v: 1, kind: "native-service-uid", native: { accountPublicKey, space, lifecycleUid },
        assignment: { owner: p.owner, actor: serviceEndpointActor({ accountPublicKey, space, owner: p.owner, endpoint: p.endpoint, instanceId: p.instanceId }),
          endpoint: p.endpoint, instanceId: p.instanceId, duty: "serve" },
        creation: { operationId, requestDigest } };
      serviceAssignmentGate(inv.host, reservation);
      ctx.step = "A-binding";
      return { kind: "bind", binding: { v: 1, kind: "service-host-operation", operationId, requestId: req.requestId, requestDigest, operation: "decide",
        account: { accountPublicKey, space }, granter: req.granter, admittedAtMs: now, notAfterMs: Math.min(now + S2A_OPERATION_TTL_MS, p.expiresAtMs),
        admissionEpoch: adm.row.epoch, projection: { subjectOwner: p.owner, endpoint: p.endpoint, instanceId: p.instanceId, proposalId },
        plan: { kind: "approve", proposalId, proposalDigest: p.proposalDigest, proposalRevision: prop.revision, nameRevision: name.revision, reservation,
          callerCeiling: ceiling, approvalExpiresAt: null }, progress: { state: "admitted" }, debt: [] } };
    }

    async function advanceApprove(inv: Inv, first: Op): Promise<DecideOut> {
      const ctx = readCtx(inv, "A-replay");
      const stored = outcomeOf(first);
      if (stored !== undefined && stored.state === "complete") return finishApproved(inv, ctx, stored.result as ServiceApprovalResult, "recorded");
      if (stored !== undefined) {
        const left = await retryDebt(ctx, first, async (pid) => { const p = await readProposal(ctx, pid); return p.state === "value" ? p.row.register.requestId : undefined; });
        const s = await settle(ctx, operationId, undefined, left);
        return finalArm(operationId, stored, debtOf(s.op));
      }
      const op = first as OpLive, plan = op.plan as ApprovePlan, res = plan.reservation;
      const { binding, epgate } = serviceAssignmentGate(inv.host, res);
      const assignmentDigest = binding.assignmentDigest;
      inv.assignmentDigest = assignmentDigest;
      const approvalDigest = approvalDigestOf({ proposalDigest: plan.proposalDigest, assignmentDigest, callerCeiling: plan.callerCeiling,
        approvalExpiresAt: plan.approvalExpiresAt, nameAuthorityRevision: plan.nameRevision, operationId });
      const mine = (g: EndpointClass) => (g.kind === "approved" || g.kind === "revoked") && g.row.serviceAuthority.approvalDigest === approvalDigest;
      /** Row 3: my approval CAS landed, possibly before a later revoke. A historical fact only. */
      const landed = async (g: EndpointClass, approvedGateRevision: number | null) => {
        if (g.kind !== "approved" && g.kind !== "revoked") return held("approval-unreadable", ctx.step);
        const sa = g.row.serviceAuthority;
        const result: ServiceApprovalResult = { proposalId, proposalDigest: plan.proposalDigest, operationId,
          assignment: { endpoint: res.assignment.endpoint, instanceId: res.assignment.instanceId, assignmentDigest, lifecycleUid: res.native.lifecycleUid },
          approvalDigest, approvalExpiresAt: plan.approvalExpiresAt, callerCeiling: plan.callerCeiling, nameAuthorityRevision: plan.nameRevision,
          rootCredentialId: sa.rootCredentialId!, rootExpiresAt: sa.rootExpiresAt!, approvedGateRevision };
        ctx.step = "A5a-result";
        const a5a = await updateOp(ctx, operationId, (cur) => (isFinal(cur.progress) ? undefined : { ...cur, progress: { state: "complete", result } }));
        const kept = outcomeOf(a5a.op);
        if (kept?.state !== "complete") return finalArm(operationId, kept as Exclude<Final, { state: "complete" }>, debtOf(a5a.op));
        return finishApproved(inv, ctx, kept.result as ServiceApprovalResult, a5a.wrote ? "applied" : "recorded");
      };
      /** Proposal-first refusal: close my approving proposal, release, then record. R-bound also
       *  closes a still-proposed target, by a CAS pinned to the revision this approval admitted. */
      const refuseWith = async (close: ServiceProposalCloseReason, reason: ServiceOperationRefusal, target = false) => {
        ctx.step = `R-${reason}`;
        const prop = await closeProposal(ctx, proposalId, (p, revision) => (p.state.state === "approving" && p.state.operationId === operationId)
          || (target && p.state.state === "proposed" && revision === plan.proposalRevision) ? tombstone(p, "refused", operationId, null, close) : undefined);
        const debts = prop.row.kind === "service-proposal-terminal" ? await releaseFor(ctx, prop.row) : [];
        const s = await settle(ctx, operationId, { state: "refused", reason }, debts);
        return finalArm(operationId, outcomeOf(s.op) as Exclude<Final, { state: "complete" }>, debtOf(s.op));
      };

      for (let n = 0; ; n++) {
        if (n >= 2 * S2A_MAX_REDECIDE) held("contention", ctx.step);
        ctx.step = "A-table";
        const gate = await endpoint(ctx, { epgate });
        if (mine(gate)) return landed(gate, null);                                                       // row 3
        const prop = await readProposal(ctx, proposalId);
        if (prop.state === "absent") return held("proposal-unreadable", ctx.step, "the approved proposal record is not readable");
        if (prop.row.kind === "service-proposal-terminal") {
          if (prop.row.state === "approved" && prop.row.operationId === operationId) return held("approval-unreadable", ctx.step, "the proposal records my approval but the gate does not"); // row 4
          const debts = await releaseFor(ctx, prop.row), why = toRefusal(prop.row);                    // row 5
          const s = await settle(ctx, operationId, why.reason === "superseded" ? { state: "superseded", boundOperationId: why.bound! } : { state: "refused", reason: why.reason }, debts);
          return finalArm(operationId, outcomeOf(s.op) as Exclude<Final, { state: "complete" }>, debtOf(s.op));
        }
        const p = prop.row;
        if (p.state.state === "approving" && p.state.operationId !== operationId) {                      // row 9
          const s = await settle(ctx, operationId, { state: "superseded", boundOperationId: p.state.operationId }, []);
          return finalArm(operationId, outcomeOf(s.op) as Exclude<Final, { state: "complete" }>, debtOf(s.op));
        }
        const asg = await readAssignment(ctx, res.assignment.endpoint, res.assignment.instanceId);
        if (asg.state === "value" && asg.row.assignmentDigest !== assignmentDigest) return refuseWith("selector-bound", "conflict", true); // R-bound
        if (asg.state === "value" && asg.row.state === "fenced") return refuseWith(causeReason(asg.row.cancel), causeReason(asg.row.cancel)); // row 11, R-fence
        const bound = asg.state === "value" ? asg.row as Extract<Assignment, { state: "bound" }> : undefined;
        if (bound && gate.kind === "revoked") return refuseWith(causeReason(bound.cancel), causeReason(bound.cancel));   // R-revoked: deny-new landed without my digest
        if (Date.now() >= op.notAfterMs) return expirySettle(p, bound, gate);                            // row 6
        // Normal advancement (rows 7, 8, 10) only inside the original authority.
        const adm = await readAdmission(ctx);
        if (adm.state === "absent" || adm.row.state !== "open" || adm.row.epoch !== op.admissionEpoch) return { state: "held", operationId, reason: "admission-held", phase: "admission", assignmentDigest };
        if (p.state.state === "proposed") {
          if (prop.revision !== plan.proposalRevision) return held("proposal-moved", ctx.step, "the proposal moved from the revision this approval admitted");
          await put(authorityCtx(inv, op.notAfterMs, "A1-approving"), proposalKey(proposalId), { ...p, state: { state: "approving", operationId, assignmentDigest } } satisfies ProposalLive, parseServiceProposalRecord, prop);
          continue;
        }
        if (!bound) {
          if (op.progress.state !== "admitted") return held("reference-unavailable", ctx.step, "the assignment row is missing after custody began");  // row 12
          const row: Assignment = { v: 1, kind: "service-assignment", state: "bound", endpoint: p.endpoint, instanceId: p.instanceId, owner: p.owner, proposalId,
            assignmentDigest, reservation: res, creation: { operationId }, cancel: null };
          await put(authorityCtx(inv, op.notAfterMs, "A2-assignment"), assignmentKey(p.endpoint, p.instanceId), row, parseServiceAssignmentRecord);
          continue;
        }
        if (bound.cancel !== null) return { state: "held", operationId, reason: "revoke-in-progress", phase: "A3-bootstrap", assignmentDigest };
        ctx.step = "A3-bootstrap";
        coverCustody(inv, ctx, res, "bootstrap");
        if (op.progress.state === "admitted") await updateOp(ctx, operationId, (cur) => (cur.progress.state === "admitted" ? { ...cur, progress: { state: "custody", step: "A3-bootstrap" } } : undefined));
        ctx.step = "A3-bootstrap";
        const boot = await runServiceBootstrap(sealServiceBootstrapIntent(inv.host, { reservation: res, notAfterMs: op.notAfterMs }));
        if (boot.kind === "held") {
          await updateOp(ctx, operationId, (cur) => (isFinal(cur.progress) ? undefined : { ...cur, progress: { state: "held", reason: boot.reason, phase: boot.step } })).catch((e) => { if (!(e instanceof Held)) throw e; });
          return { state: "held", operationId, reason: boot.reason, phase: boot.step, assignmentDigest };
        }
        if (boot.kind === "cancelled" || boot.kind === "endpoint-revoked") continue;                  // the gate read decides R-revoked
        if (boot.kind !== "active") return refuseWith("custody-refused", "custody-refused");
        // A4: recheck by read, then the one approval-row builder at the gate revision read now.
        const actx = authorityCtx(inv, op.notAfterMs, "A4-approve");
        const name = await nameOf(actx, p.endpoint);
        if (name === undefined || name.owner !== p.owner || name.revision !== plan.nameRevision) return { state: "held", operationId, reason: "name-changed", phase: actx.step, assignmentDigest };
        const p4 = await readProposal(actx, proposalId), a4 = await readAssignment(actx, p.endpoint, p.instanceId), adm4 = await readAdmission(actx);
        if (p4.state !== "value" || p4.row.kind !== "service-proposal" || p4.row.state.state !== "approving" || p4.row.state.operationId !== operationId) continue;
        if (a4.state !== "value" || a4.row.state !== "bound" || a4.row.cancel !== null) continue;
        if (adm4.state === "absent" || adm4.row.state !== "open" || adm4.row.epoch !== op.admissionEpoch) return { state: "held", operationId, reason: "admission-held", phase: actx.step, assignmentDigest };
        const g4 = await endpoint(actx, { epgate });
        if (g4.kind !== "pending") continue;
        const args = { rootCredentialId: boot.root.credentialId, approvalDigest, nameAuthorityRevision: plan.nameRevision, approvalExpiresAt: plan.approvalExpiresAt, callerCeiling: plan.callerCeiling };
        let next: ReturnType<typeof approvedServiceGateRow>;
        try {
          assertApprovableServiceGate(g4.row, args);
          const proof = await bounded(actx, () => readRegistryServiceRoot(inv.h.registry, binding, boot.root.credentialId, Date.now()));
          if (!proof.ok) return held("unavailable", actx.step, "timedOut" in proof ? "the root proof timed out" : message(proof.error));
          next = approvedServiceGateRow(g4.row, args, proof.value.expiresAt, Date.now());
        } catch (e) {
          if (e instanceof EpEnvelopeError) return { state: "held", operationId, reason: e.code, phase: actx.step, assignmentDigest };
          throw e;
        }
        const w = await write(actx, "auth", epgate.key, enc.encode(JSON.stringify(next)), { revision: g4.revision, preimage: g4.bytes });
        if (w !== "moved") return landed(await endpoint(ctx, { epgate }), w);
      }

      /** Row 6: after the original deadline only bookkeeping and authority-reducing steps run. */
      async function expirySettle(p: ProposalLive, bound: Extract<Assignment, { state: "bound" }> | undefined, gate: EndpointClass): Promise<DecideOut> {
        ctx.step = "settle-expired";
        if (p.state.state === "proposed") {
          const s = await settle(ctx, operationId, { state: "refused", reason: "expired" }, []);
          return finalArm(operationId, outcomeOf(s.op) as Exclude<Final, { state: "complete" }>, debtOf(s.op));
        }
        if (bound === undefined) return refuseWith("expired", "expired");
        let asg: Extract<Assignment, { state: "bound" }> = bound;
        for (let i = 0; asg.cancel === null; i++) {
          if (i >= S2A_MAX_REDECIDE) held("contention", ctx.step);
          const cancel: Cancel = { operationId: expiryOperationId(space, operationId), requestDigest: expiryRequestDigest(operationId, assignmentDigest), cause: "approval-expired" };
          const cur = await readAssignment(ctx, asg.endpoint, asg.instanceId);
          if (cur.state !== "value" || cur.row.state !== "bound" || cur.row.assignmentDigest !== assignmentDigest) return held("assignment-moved", ctx.step);
          if (cur.row.cancel !== null) { asg = cur.row; break; }
          await put(ctx, assignmentKey(asg.endpoint, asg.instanceId), { ...cur.row, cancel } satisfies Assignment, parseServiceAssignmentRecord, cur);
          const again = await readAssignment(ctx, asg.endpoint, asg.instanceId);
          if (again.state === "value" && again.row.state === "bound") asg = again.row;
        }
        const run = gate.kind === "revoked" ? { s1: undefined, denyNew: "landed" as const, gate } : await nativeCancel(inv, ctx, asg, asg.cancel!);
        if (run.denyNew !== "landed") {
          const reason = run.s1 === undefined ? "cancel-pending" : run.s1.kind === "held" ? run.s1.reason : run.s1.kind === "seal-refused" ? "cancel-intent-refused" : run.s1.kind;
          return { state: "held", operationId, reason, phase: "settle-expired", assignmentDigest, denyNew: run.denyNew };
        }
        const debts = await v4(ctx, asg, run.gate);
        if (run.gate && mine(run.gate)) return landed(run.gate, null);
        const s = await settle(ctx, operationId, { state: "refused", reason: causeReason(asg.cancel) }, debts);
        return finalArm(operationId, outcomeOf(s.op) as Exclude<Final, { state: "complete" }>, debtOf(s.op));
      }
    }

    /** A5b-A5d after A5a: proposal terminal, capacity release, then compaction once no debt remains. */
    async function finishApproved(inv: Inv, ctx: Ctx, result: ServiceApprovalResult, outcome: ServiceHostOutcome): Promise<DecideOut> {
      ctx.step = "A5b-proposal";
      const prop = await closeProposal(ctx, result.proposalId, (p) => p.state.state === "approving" && p.state.operationId === result.operationId
        ? tombstone(p, "approved", result.operationId, result.approvalDigest, null) : undefined);
      ctx.step = "A5c-release";
      const debts = prop.row.kind === "service-proposal-terminal" ? await releaseFor(ctx, prop.row) : [];
      ctx.step = "A5d-compact";
      const s = await settle(ctx, operationId, undefined, debts), left = debtOf(s.op);
      void inv;
      return { state: "approved", outcome, approval: result, ...(left.length ? { debt: left } : {}) };
    }

    async function admitRefuse(inv: Inv, ctx: Ctx): Promise<Admitted> {
      ctx.step = "F0-admit";
      const prop = await readProposal(ctx, proposalId);
      if (prop.state === "absent" || (granterOwner !== null && prop.row.owner !== granterOwner)) return out(denied("not-found"));
      if (prop.row.kind !== "service-proposal") return out(denied("conflict"));
      const p = prop.row;
      if (p.state.state === "approving") {
        // A stale approving{X}: X is terminal and did not complete, so it holds no native authority.
        const x = await readOp(ctx, p.state.operationId);
        if (x.state !== "value" || x.row.kind !== "service-host-operation-terminal" || x.row.outcome.state === "complete")
          return out(denied("approval-in-progress", p.state.operationId));
      }
      if (prop.revision !== req.input.expectedProposalRevision) return out(denied("conflict"));
      const adm = await readAdmission(ctx), now = Date.now();
      void inv;
      ctx.step = "F-binding";
      return { kind: "bind", binding: { v: 1, kind: "service-host-operation", operationId, requestId: req.requestId, requestDigest, operation: "decide",
        account: { accountPublicKey, space }, granter: req.granter, admittedAtMs: now, notAfterMs: now + S2A_OPERATION_TTL_MS,
        admissionEpoch: adm.state === "value" ? adm.row.epoch : 0, projection: { subjectOwner: p.owner, endpoint: p.endpoint, instanceId: p.instanceId, proposalId },
        plan: { kind: "refuse", proposalId, proposalRevision: prop.revision }, progress: { state: "admitted" }, debt: [] } };
    }

    async function advanceRefuse(inv: Inv, first: Op): Promise<DecideOut> {
      const ctx = readCtx(inv, "F-replay");
      const refused = (r: RefuseResult, outcome: ServiceHostOutcome, debts: ServiceHostDebt[] = []): DecideOut => ({ state: "refused", outcome, proposal: r.proposal, revision: r.revision, ...(debts.length ? { debt: debts } : {}) });
      const stored = outcomeOf(first);
      if (stored !== undefined) {
        const left = await retryDebt(ctx, first, async (pid) => { const p = await readProposal(ctx, pid); return p.state === "value" ? p.row.register.requestId : undefined; });
        const s = await settle(ctx, operationId, undefined, left);
        return stored.state === "complete" ? refused(stored.result as RefuseResult, "recorded", debtOf(s.op)) : finalArm(operationId, stored, debtOf(s.op));
      }
      const op = first as OpLive, plan = op.plan as RefusePlan;
      const closeReason: ServiceProposalCloseReason = req.granter.kind === "owner" ? "owner" : "operator";
      for (let n = 0; ; n++) {
        if (n >= S2A_MAX_REDECIDE) held("contention", ctx.step);
        ctx.step = "F-table";
        const prop = await readProposal(ctx, proposalId);
        if (prop.state === "absent") return held("proposal-unreadable", ctx.step);
        if (prop.row.kind === "service-proposal-terminal") {
          const t = prop.row, debts = await releaseFor(ctx, t);
          if (t.state === "refused" && t.operationId === operationId) {
            const s = await settle(ctx, operationId, { state: "complete", result: { proposal: view(t), revision: prop.revision } }, debts);
            const kept = outcomeOf(s.op)!;
            return kept.state === "complete" ? refused(kept.result as RefuseResult, s.wrote ? "applied" : "recorded", debtOf(s.op)) : finalArm(operationId, kept, debtOf(s.op));
          }
          const why = toRefusal(t);
          const s = await settle(ctx, operationId, why.reason === "superseded" ? { state: "superseded", boundOperationId: why.bound! } : { state: "refused", reason: why.reason }, debts);
          return finalArm(operationId, outcomeOf(s.op) as Exclude<Final, { state: "complete" }>, debtOf(s.op));
        }
        if (prop.revision !== plan.proposalRevision) {
          const s = await settle(ctx, operationId, { state: "refused", reason: "conflict" }, []);
          return finalArm(operationId, outcomeOf(s.op) as Exclude<Final, { state: "complete" }>, debtOf(s.op));
        }
        if (Date.now() >= op.notAfterMs) {
          const s = await settle(ctx, operationId, { state: "refused", reason: "expired" }, []);
          return finalArm(operationId, outcomeOf(s.op) as Exclude<Final, { state: "complete" }>, debtOf(s.op));
        }
        await put(authorityCtx(inv, op.notAfterMs, "F-refuse"), proposalKey(proposalId), tombstone(prop.row, "refused", operationId, null, closeReason), parseServiceProposalRecord, prop);
      }
    }
  }

  // ---- revoke (V0-V5) -----------------------------------------------------------------------------

  async function revoke(req: Extract<ServiceHostRequest, { operation: "revoke" }>, authorized: boolean): Promise<Arms> {
    const operationId = serviceHostOperationId(space, req.requestId), requestDigest = requestDigestOf(req);
    const { endpoint: e, instanceId: i, expectedAssignmentDigest, cause } = req.input;
    const ownerCause = cause === "owner-request";
    if ((req.granter.kind === "owner") !== ownerCause) return denied("permission-denied");                 // never binds
    // Authorization precedes every request-key read, and its refusal is one answer whether or not the request is bound.
    if (!authorized) return unread(req.requestId, "permission-denied", "authorize", expectedAssignmentDigest);
    const scope: ServiceHostScopeTarget = { operation: "revoke", operationId, proposalId: null, owner: null, endpoint: e, instanceId: i, lifecycleUid: null };
    let found: Read<Op> | undefined;
    try {
      const dctx = discoveryCtx("discover");
      found = await readOp(dctx, operationId);
      const asg = await readAssignment(dctx, e, i);
      if (asg.state === "value") {
        Object.assign(scope, { proposalId: asg.row.proposalId, owner: asg.row.owner });
        if (asg.row.state === "bound") scope.lifecycleUid = asg.row.reservation.native.lifecycleUid;
      } else {
        const entry = eligible(await readCapacity(dctx), Date.now()).find((x) => x.endpoint === e && x.instanceId === i);
        if (entry !== undefined) Object.assign(scope, { proposalId: entry.proposalId, owner: entry.owner });
      }
    } catch (err) { if (err instanceof Held) return discoveryHeld(operationId, requestDigest, found, err, expectedAssignmentDigest); throw err; }
    try {
      return await invoke(scope, async (inv) => {
        inv.operationId = operationId; inv.assignmentDigest = expectedAssignmentDigest;
        try {
          const ctx = readCtx(inv, "V0-read");
          for (let n = 0; ; n++) {
            if (n >= S2A_MAX_REDECIDE) held("contention", ctx.step);
            const op = await readOp(ctx, operationId);
            if (op.state === "value" && op.row.requestDigest === requestDigest) {
              if (req.granter.kind === "owner" && op.row.projection.subjectOwner !== req.granter.owner)
                return { state: "held", operationId, reason: "permission-denied", phase: "authorize", assignmentDigest: expectedAssignmentDigest };
              return await advanceRevoke(inv, op.row);
            }
            if (op.state === "value") return denied("conflict");
            inv.bound = false;
            // V0: the assignment, else an approving proposal at the selector, then the assignment again.
            let asg = await readAssignment(ctx, e, i);
            let prop: Read<Proposal> = { state: "absent" };
            if (asg.state === "absent") {
              const entry = eligible(await readCapacity(ctx), Date.now()).find((x) => x.endpoint === e && x.instanceId === i);
              if (entry !== undefined) prop = await readProposal(ctx, entry.proposalId);
              asg = await readAssignment(ctx, e, i);
            }
            const subjectOwner = asg.state === "value" ? asg.row.owner : prop.state === "value" ? prop.row.owner : undefined;
            if (subjectOwner === undefined || (req.granter.kind === "owner" && req.granter.owner !== subjectOwner)) return denied("not-found");
            if (asg.state === "value" && asg.row.assignmentDigest !== expectedAssignmentDigest) return denied("conflict");
            if (asg.state === "absent" && !(prop.state === "value" && prop.row.kind === "service-proposal" && prop.row.state.state === "approving"
              && prop.row.state.assignmentDigest === expectedAssignmentDigest)) return denied("not-found");
            const proposalId = asg.state === "value" ? asg.row.proposalId : (prop as Live<Proposal>).row.proposalId;
            const adm = await readAdmission(ctx), now = Date.now();
            ctx.step = "V1-binding";
            const binding: OpLive = { v: 1, kind: "service-host-operation", operationId, requestId: req.requestId, requestDigest, operation: "revoke",
              account: { accountPublicKey, space }, granter: req.granter, admittedAtMs: now, notAfterMs: now + S2A_OPERATION_TTL_MS,
              admissionEpoch: adm.state === "value" ? adm.row.epoch : 0, projection: { subjectOwner, endpoint: e, instanceId: i, proposalId },
              plan: { kind: "revoke", endpoint: e, instanceId: i, expectedAssignmentDigest, cause }, progress: { state: "admitted" }, debt: [] };
            inv.bound = true;
            if ((await put(ctx, opKey(operationId), binding, parseServiceHostOperationRecord)) !== "moved") return await advanceRevoke(inv, binding);
          }
        } catch (err) { if (err instanceof Held) return heldArm(inv, err); throw err; }
      });
    } catch (err) { if (err instanceof Held) return discoveryHeld(operationId, requestDigest, found, err, expectedAssignmentDigest); throw err; }

    async function advanceRevoke(inv: Inv, first: Op): Promise<Arms> {
      const ctx = readCtx(inv, "V-replay");
      const stored = outcomeOf(first);
      if (stored !== undefined) return stored.state === "complete" ? held("operation-malformed", ctx.step, "a revoke never completes") : finalArm(operationId, stored, debtOf(first));
      const op = first as OpLive;
      const a = expectedAssignmentDigest;
      const progress = async (phase: string) => {
        await updateOp(ctx, operationId, (cur) => (cur.progress.state === "custody" && cur.progress.step === phase ? undefined : { ...cur, progress: { state: "custody", step: phase } }))
          .catch((err) => { if (!(err instanceof Held)) throw err; });
      };
      /** The release debt this revoke owes: as stored until V4 observes again, then kept by a guarded
       *  CAS whether it grows or clears. Every result reports it. */
      let owed = op.debt;
      const keepDebt = async (debts: ServiceHostDebt[]) => {
        owed = debts;
        await updateOp(ctx, operationId, (cur) => (sameDebt(cur.debt, debts) ? undefined : { ...cur, debt: debts }));
      };
      const owing = () => (owed.length ? { debt: owed } : {});
      for (let n = 0; ; n++) {
        if (n >= S2A_MAX_REDECIDE) held("contention", ctx.step);
        ctx.step = "V0-read";
        const asg = await readAssignment(ctx, e, i);
        if (asg.state === "absent") {
          const prop = op.projection.proposalId === null ? undefined : await readProposal(ctx, op.projection.proposalId);
          if (prop?.state !== "value" || prop.row.kind !== "service-proposal" || prop.row.state.state !== "approving" || prop.row.state.assignmentDigest !== a) {
            const s = await settle(ctx, operationId, { state: "refused", reason: "conflict" }, []);
            return finalArm(operationId, outcomeOf(s.op) as Exclude<Final, { state: "complete" }>, debtOf(s.op));
          }
          if (Date.now() >= op.notAfterMs) return { state: "held", operationId, reason: "expired", phase: "V2-fence", assignmentDigest: a, ...owing() };
          ctx.step = "V2-fence";
          const fence: Assignment = { v: 1, kind: "service-assignment", state: "fenced", endpoint: e, instanceId: i, owner: prop.row.owner, proposalId: prop.row.proposalId,
            assignmentDigest: a, cancel: { operationId, requestDigest, cause } };
          await put(ctx, assignmentKey(e, i), fence, parseServiceAssignmentRecord);
          continue;
        }
        const row = asg.row;
        if (row.assignmentDigest !== a) {
          const s = await settle(ctx, operationId, { state: "refused", reason: "conflict" }, []);
          return finalArm(operationId, outcomeOf(s.op) as Exclude<Final, { state: "complete" }>, debtOf(s.op));
        }
        if (row.state === "fenced") {
          await keepDebt(await v4(ctx, row, undefined)); await progress("assignment-fenced");
          return { state: "pending", operationId, phase: "assignment-fenced", assignmentDigest: a, denyNew: "landed", ...owing() };
        }
        if (row.cancel === null) {
          if (Date.now() >= op.notAfterMs) return { state: "held", operationId, reason: "expired", phase: "V2-cancel", assignmentDigest: a, ...owing() };
          ctx.step = "V2-cancel";
          await put(ctx, assignmentKey(e, i), { ...row, cancel: { operationId, requestDigest, cause } } satisfies Assignment, parseServiceAssignmentRecord, asg);
          continue;
        }
        if (Date.now() >= op.notAfterMs) {
          // Spent: no further native step under this request; a new revoke adopts the binding.
          let denyNew: ServiceDenyNew = "unknown";
          try { denyNew = denyNewOf(await endpoint(ctx, serviceAssignmentGate(inv.host, row.reservation))); }
          catch (err) { if (!(err instanceof Held) && !(err instanceof EpEnvelopeError)) throw err; }
          return { state: "held", operationId, reason: "expired", phase: "spent", assignmentDigest: a, denyNew, ...owing() };
        }
        ctx.step = "V3-cancel";
        const run = await nativeCancel(inv, ctx, row, row.cancel);
        if (run.denyNew === "landed") await keepDebt(await v4(ctx, row, run.gate));
        const s1 = run.s1;
        if (s1.kind === "pending" && run.denyNew === "landed") {
          await progress("cancelled-nonterminal");
          return { state: "pending", operationId, phase: "cancelled-nonterminal", assignmentDigest: a, denyNew: "landed", root: s1.root, ...owing() };
        }
        if (s1.kind === "uid-unconfirmed" && run.denyNew === "landed") {
          await progress("uid-unconfirmed");
          return { state: "pending", operationId, phase: "uid-unconfirmed", assignmentDigest: a, denyNew: "landed", ...owing() };
        }
        const reason = s1.kind === "held" ? s1.reason : s1.kind === "seal-refused" ? "cancel-intent-refused" : s1.kind === "pending" || s1.kind === "uid-unconfirmed" ? "deny-new-unconfirmed" : s1.kind;
        const phase = s1.kind === "held" ? s1.step : s1.kind === "uid-foreign" ? "U-uid" : "V3-cancel";
        return { state: "held", operationId, reason, phase, assignmentDigest: a, denyNew: run.denyNew, ...owing() };
      }
    }
  }

  // ---- caller policy: grant, revoke and the policy reads ------------------------------------------

  const readPolicy = (ctx: Ctx, uid: string) => read(ctx, servicePolicyKey(uid), "policy", parseNativeServiceCallerPolicy);
  const readCallerIndex = (ctx: Ctx, e: string, i: string) => read(ctx, callerIndexKey(e, i), "caller-index", parseServiceCallerIndexRecord);
  const readPayload = (ctx: Ctx) => read(ctx, SERVICE_CALLER_PAYLOAD_KEY, "payload", parseServiceCallerPayloadRecord);
  /** Whether a row at a grantee's key is bound to that grantee in this account and space. */
  const boundTo = (row: NativeServiceCallerPolicy, g: ServicePrincipal) =>
    row.accountPublicKey === accountPublicKey && row.space === space && canonicalJson(row.grantee) === canonicalJson(g);
  const emptyPolicy = (g: ServicePrincipal): NativeServiceCallerPolicy => ({ v: 1, accountPublicKey, space, grantee: g, grants: [] });

  /** This connection's live limits: its server's `max_payload` and the auth stream's `max_msg_size`. */
  async function payloadLimits(ctx: Ctx): Promise<ServiceCallerPayloadLimits> {
    const maxPayload = registryMaxPayload(ctx.h.registry);
    const r = await bounded(ctx, () => ctx.jsm.streams.info(`KV_${ctx.bucket.auth}`));
    const size = r.ok ? r.value.config.max_msg_size : undefined;
    return { maxPayload: Number.isSafeInteger(maxPayload) ? maxPayload : undefined, authMaxMsgSize: Number.isSafeInteger(size) ? size : undefined };
  }
  /** Withdraw an asserted payload precondition after a failed live check or a write that would not
   *  fit; only an operator's assertion records it again. A withdrawal whose own write does not land
   *  is made again by the next writer that sees the same failure. */
  async function withdrawPayload(ctx: Ctx, rec: Read<ServiceCallerPayloadRecord>, reason: "live-check" | "payload-precondition", operationId: string | null): Promise<void> {
    if (rec.state !== "value" || rec.row.state !== "asserted") return;
    const step = ctx.step;
    try {
      await put(ctx, SERVICE_CALLER_PAYLOAD_KEY, { v: 1, kind: "service-caller-payload", state: "withdrawn", reason, operationId, atMs: Date.now() } satisfies ServiceCallerPayloadRecord,
        parseServiceCallerPayloadRecord, rec);
    } catch (e) { if (!(e instanceof Held)) throw e; } finally { ctx.step = step; }
  }
  /** Whether the payload precondition holds now, from its durable record and this connection's live limits. */
  async function payloadHolds(ctx: Ctx, operationId: string | null): Promise<boolean> {
    const rec = await readPayload(ctx), check = serviceCallerPayloadCheck(rec.state === "value" ? rec.row : undefined, await payloadLimits(ctx));
    if (!check.holds && (check.why === "server-limit" || check.why === "stream-limit")) await withdrawPayload(ctx, rec, "live-check", operationId);
    return check.holds;
  }
  /** Before a policy row write: a row that would not fit the live limits is never issued. The step
   *  holds `payload-precondition`, a known non-issue, never an unknown outcome. */
  async function assertWriteFits(ctx: Ctx, row: NativeServiceCallerPolicy, operationId: string): Promise<void> {
    if (serviceCallerWriteFits(encodeRoundTrip(row, parseNativeServiceCallerPolicy).length, await payloadLimits(ctx))) return;
    await withdrawPayload(ctx, await readPayload(ctx), "payload-precondition", operationId);
    held("payload-precondition", ctx.step, "the policy row write would not fit the live payload limits; nothing was issued");
  }
  /** Containment within the approval's ceiling image for grantee G. The image keeps only entries on
   *  this endpoint pinned to this instance with `instanceOnly`, and drops `any` and `ledger` entries
   *  (no operator target policy is wired) and `owner` or `child` entries for another owner, which can
   *  never cover G. Mode filtering of stored entries waits on grant-time command declarations. A
   *  lowering throw counts as not contained. */
  const withinCeiling = (ceiling: EpCapability[], capabilities: EpCapability[], g: ServicePrincipal, sel: { endpoint: string; instanceId: string }) => {
    const image = ceiling.filter((c) => {
      const t = c.target as { mode: string; tOwner?: string } | undefined;
      return c.endpoint === sel.endpoint && c.instanceId === sel.instanceId && c.instanceOnly === true && t?.mode !== "any" && t?.mode !== "ledger"
        && !((t?.mode === "owner" || t?.mode === "child") && t.tOwner !== g.owner);
    });
    const caller = { owner: g.owner, actor: g.actor, uid: g.lifecycleUid };
    try { return endpointCapabilitiesWithin({ space, child: { caller, capabilities }, parent: { caller, capabilities: image } }); } catch { return false; }
  };

  type GrantOut = Arms | { state: "granted"; grant: ServiceCallerGrant; revision: number };
  const grantedArm = (r: OpResult): GrantOut => { const g = r as GrantResult; return { state: "granted", grant: structuredClone(g.grant), revision: g.revision }; };

  /** caller-grant (G1-G6): an interactive owner grants one interactive, parentless grantee rights on
   *  its own approved instance, within the approval's ceiling. A grant is recorded `active`; nothing
   *  in this host issues rights from it. */
  async function callerGrant(req: Extract<ServiceHostRequest, { operation: "caller-grant" }>, authorized: boolean): Promise<GrantOut> {
    // Authorization precedes every request-key read, and its refusal is one answer whether or not the request is bound.
    if (!authorized) return unread(req.requestId, "permission-denied", "authorize");
    const operationId = serviceHostOperationId(space, req.requestId), requestDigest = requestDigestOf(req);
    const granterOwner = req.granter.kind === "owner" ? req.granter.owner : badRequest("a caller grant requires an owner decision");
    const { grantee, service, expectedPolicyRevision } = req.input;
    // The scope comes from the input alone, so a grant has no discovery read.
    const scope: ServiceHostScopeTarget = { operation: "caller-grant", operationId, proposalId: null, owner: granterOwner, endpoint: service.endpoint,
      instanceId: service.instanceId, lifecycleUid: null, granteeUid: grantee.lifecycleUid };
    try {
      return await invoke(scope, async (inv) => {
        inv.operationId = operationId;
        try {
          const ctx = readCtx(inv, "G1-binding");
          for (let n = 0; ; n++) {
            if (n >= S2A_MAX_REDECIDE) held("contention", ctx.step);
            const op = await readOp(ctx, operationId);
            if (op.state === "value") return op.row.requestDigest === requestDigest ? await advanceGrant(inv, op.row) : denied("conflict");
            inv.bound = false;
            const admitted = await admitGrant(inv, ctx);
            if (admitted.kind !== "service-host-operation") return admitted.out;
            // The create may be issued from here, so a held step names the operation.
            inv.bound = true;
            if ((await put(ctx, opKey(operationId), admitted, parseServiceHostOperationRecord)) !== "moved") return await advanceGrant(inv, admitted);
          }
        } catch (err) { if (err instanceof Held) return heldArm(inv, err); throw err; }
      });
    } catch (err) { if (err instanceof Held) return unread(req.requestId, err.reason, err.step); throw err; }

    /** G2: the payload precondition, then each eligibility check from one leader read, point in
     *  time. Every refusal is a zero-write denial; the only write before binding is the precondition's
     *  withdrawal after a failed live check. */
    async function admitGrant(inv: Inv, ctx: Ctx): Promise<OpLive | { kind: "out"; out: GrantOut }> {
      const out = (o: GrantOut) => ({ kind: "out" as const, out: o });
      ctx.step = "G2-precondition";
      if (!(await payloadHolds(ctx, null))) return out(denied("unsupported"));
      ctx.step = "G2-eligibility";
      const adm = await readAdmission(ctx);
      if (adm.state === "absent" || adm.row.state !== "open") return out(denied("admission-closed"));
      let row: ReturnType<typeof findActorUnified>;
      try { row = findActorUnified(opts.ledgerDir, grantee.owner, grantee.actor); } catch { return out(denied("not-found")); }
      if (row === undefined) return out(denied("not-found"));
      if (row.kind !== "interactive" || row.parent !== undefined) return out(denied("unsupported"));
      if (row.lifecycleUid !== grantee.lifecycleUid) return out(denied("not-found"));
      const asg = await readAssignment(ctx, service.endpoint, service.instanceId);
      if (asg.state === "absent" || asg.row.owner !== granterOwner || asg.row.state !== "bound" || asg.row.cancel !== null) return out(denied("not-found"));
      const a = asg.row;
      const gate = await endpoint(ctx, serviceAssignmentGate(inv.host, a.reservation));
      if (gate.kind !== "approved" || gate.row.serviceAuthority.approvalDigest !== service.approvalDigest) return out(denied("conflict"));
      const now = Date.now();
      if (!serviceGateApprovalLive(gate.row.serviceAuthority, seconds(now))) return out(denied("expired"));
      const name = await nameOf(ctx, service.endpoint);
      if (name === undefined || name.owner !== granterOwner || name.revision !== gate.row.nameAuthorityRevision) return out(denied("conflict"));
      const capabilities = parseEndpointCapabilities(req.input.capabilities);
      if (capabilities.length === 0 || capabilities.some((c) => c.endpoint !== service.endpoint || c.instanceId !== service.instanceId || c.instanceOnly !== true))
        return out(denied("bad-request"));
      // A journal row has no instance segment, so it would reach the command's journal on every instance.
      if (capabilities.some((c) => c.journal === true)) return out(denied("unsupported"));
      if (capabilities.some((c) => c.target?.mode === "any" || c.target?.mode === "ledger")) return out(denied("permission-denied"));
      if (!withinCeiling(gate.row.serviceAuthority.callerCeiling, capabilities, grantee, service)) return out(denied("permission-denied"));
      const policy = await readPolicy(ctx, grantee.lifecycleUid);
      if (policy.state === "value" && !boundTo(policy.row, grantee)) return out(denied("conflict"));
      if ((policy.state === "value" ? policy.revision : 0) !== expectedPolicyRevision) return out(denied("conflict"));
      const body: GrantBody = { grantId: callerGrantId(space, operationId), endpoint: service.endpoint, instanceId: service.instanceId,
        serviceApprovalDigest: service.approvalDigest, capabilities,
        source: { kind: "service-owner", owner: granterOwner, approvalDigest: service.approvalDigest, nameAuthorityRevision: gate.row.nameAuthorityRevision }, parentRefs: [] };
      const step = callerAppendStep(policy.state === "value" ? { row: policy.row, revision: policy.revision } : undefined, emptyPolicy(grantee),
        expectedPolicyRevision, withStatus(body, { state: "active" }));
      if (step.kind === "headroom") return out(denied("resource-exhausted"));
      if (step.kind !== "write") return out(denied("conflict"));
      const index = await readCallerIndex(ctx, service.endpoint, service.instanceId);
      if (index.state === "value" && index.row.entries.length >= S3_MAX_CALLER_GRANTS_PER_INSTANCE) return out(denied("resource-exhausted"));
      ctx.step = "G3-binding";
      return { v: 1, kind: "service-host-operation", operationId, requestId: req.requestId, requestDigest, operation: "grant", account: { accountPublicKey, space },
        granter: req.granter, admittedAtMs: now, notAfterMs: now + S2A_OPERATION_TTL_MS, admissionEpoch: adm.row.epoch,
        projection: { subjectOwner: granterOwner, endpoint: service.endpoint, instanceId: service.instanceId, proposalId: a.proposalId },
        plan: { kind: "caller-grant", grantee, assignmentDigest: a.assignmentDigest, approvalDigest: service.approvalDigest,
          nameAuthorityRevision: gate.row.nameAuthorityRevision, expectedPolicyRevision, request: req.input, grant: body },
        progress: { state: "admitted" }, debt: [] };
    }

    /** G4-G6 from the stored plan. A positive write is recorded `issued` first; past `notAfterMs`
     *  a replay makes no positive write and settles from one read of the policy row. */
    async function advanceGrant(inv: Inv, first: Op): Promise<GrantOut> {
      const ctx = readCtx(inv, "G-replay");
      const stored = outcomeOf(first);
      if (stored !== undefined) return stored.state === "complete" ? grantedArm(stored.result) : finalArm(operationId, stored, debtOf(first));
      let op = first as OpLive;
      const p = op.plan as CallerGrantPlan, uid = p.grantee.lifecycleUid, candidate = withStatus(p.grant, { state: "active" });
      const view = immutableGrantView(candidate), indexKey = callerIndexKey(p.grant.endpoint, p.grant.instanceId), policyKey = servicePolicyKey(uid);
      const mine = (e: { granteeUid: string; grantId: string }) => e.granteeUid === uid && e.grantId === p.grant.grantId;
      const finish = async (f: Final): Promise<GrantOut> => {
        const s = await settle(ctx, operationId, f, []), o = outcomeOf(s.op)!;
        return o.state === "complete" ? grantedArm(o.result) : finalArm(operationId, o, debtOf(s.op));
      };
      const refuse = (reason: ServiceOperationRefusal) => finish({ state: "refused", reason });
      const adopt = (grant: ServiceCallerGrant, revision: number) => finish({ state: "complete", result: { grant, revision } });
      /** Move the live progress from what this invocation last saw; another invocation's record holds. */
      const progressTo = async (next: Progress) => {
        const seen = canonicalJson(op.progress), want = canonicalJson(next);
        const r = await updateOp(ctx, operationId, (cur) => {
          const now = canonicalJson(cur.progress);
          if (isFinal(cur.progress) || now === want) return undefined;
          if (now !== seen) held("contention", ctx.step, "another invocation advanced this operation");
          return { ...cur, progress: next };
        });
        if (r.op.kind !== "service-host-operation" || isFinal(r.op.progress)) held("contention", ctx.step, "the operation settled under another invocation");
        op = r.op;
      };
      /** Record the write as issued, never with too little of the authority window left to start it:
       *  an open record is settled only by a later read, so one without its write holds until the key moves. */
      const issue = async (step: string, key: string, atRevision: number) => {
        if (Date.now() + 2 * S1_REQUEST_TIMEOUT_MS >= Math.min(inv.endMs, op.notAfterMs)) held("deadline", step, "too little of the authority window remains to issue the write");
        await progressTo({ state: "issued", step, key, atRevision });
      };
      /** The grant in the row from one read: present with this plan's immutable view, or absent. Anything else holds. */
      const lookup = async () => {
        const pol = await readPolicy(ctx, uid);
        if (pol.state === "value" && !boundTo(pol.row, p.grantee)) held("witness-mismatch", ctx.step, "the policy row at the grantee key is bound to another principal");
        const grant = pol.state === "value" ? pol.row.grants.find((x) => x.grantId === p.grant.grantId) : undefined;
        if (grant !== undefined && immutableGrantView(grant) !== view) held("witness-mismatch", ctx.step, "the stored grant differs from the operation's witness");
        return { pol, grant, revision: pol.state === "value" ? pol.revision : 0 };
      };

      // An open issued write: one read of its own key settles it, or its outcome stays unknown.
      if (op.progress.state === "issued") {
        const iss = op.progress;
        ctx.step = iss.step;
        if (iss.key === policyKey) {
          const found = await lookup();
          if (found.grant !== undefined) return adopt(found.grant, found.revision);
          if (found.revision <= iss.atRevision) held("outcome-unknown", ctx.step, "the issued append's outcome stays unknown until its key moves");
          await progressTo({ state: "custody", step: "G5-not-landed" });
        } else {
          const idx = await readCallerIndex(ctx, p.grant.endpoint, p.grant.instanceId);
          const landed = idx.state === "value" && idx.row.entries.some(mine);
          if (!landed && (idx.state === "value" ? idx.revision : 0) <= iss.atRevision) held("outcome-unknown", ctx.step, "the issued index write's outcome stays unknown until its key moves");
          await progressTo({ state: "custody", step: landed ? "G4-indexed" : "G4-not-landed" });
        }
      }
      // Past the operation's bound: no positive write. Adopt a landed grant, else the attempt expired.
      if (Date.now() >= op.notAfterMs) {
        ctx.step = "G-expired";
        const found = await lookup();
        return found.grant !== undefined ? adopt(found.grant, found.revision) : refuse("expired");
      }
      // A bound grant whose precondition stopped holding holds before G4 or G5; nothing is issued.
      ctx.step = "G4-precondition";
      if (!(await payloadHolds(ctx, operationId))) held("payload-precondition", ctx.step, "the payload precondition does not hold; nothing was issued");
      for (let n = 0; ; n++) {
        if (n >= S2A_MAX_REDECIDE) held("contention", "G4-index");
        ctx.step = "G4-index";
        const idx = await readCallerIndex(ctx, p.grant.endpoint, p.grant.instanceId);
        if (idx.state === "value" && idx.row.entries.some(mine)) {
          if (op.progress.state === "issued") await progressTo({ state: "custody", step: "G4-indexed" });
          break;
        }
        if (idx.state === "value" && idx.row.entries.length >= S3_MAX_CALLER_GRANTS_PER_INSTANCE) return refuse("resource-exhausted");
        const entries = [...(idx.state === "value" ? idx.row.entries : []), { granteeUid: uid, grantId: p.grant.grantId }].sort(byEntry);
        await issue("G4-index", indexKey, idx.state === "value" ? idx.revision : 0);
        const wrote = await put(authorityCtx(inv, op.notAfterMs, "G4-index"), indexKey, { v: 1, kind: "service-caller-grant-index", entries } satisfies CallerIndex,
          parseServiceCallerIndexRecord, idx.state === "value" ? idx : undefined);
        if (wrote !== "moved") { await progressTo({ state: "custody", step: "G4-indexed" }); break; }
        // A lost write: the next read of the same key settles it before anything is issued again.
      }
      // G5: the grant may already be in the row; otherwise re-check the approval's authority, then append.
      ctx.step = "G5-recheck";
      const found = await lookup();
      if (found.grant !== undefined) return adopt(found.grant, found.revision);
      const asg = await readAssignment(ctx, p.grant.endpoint, p.grant.instanceId);
      if (asg.state === "absent" || asg.row.assignmentDigest !== p.assignmentDigest || asg.row.owner !== op.projection.subjectOwner) return refuse("conflict");
      if (asg.row.state === "fenced" || asg.row.cancel !== null) return refuse("revoked");
      const gate = await endpoint(ctx, serviceAssignmentGate(inv.host, asg.row.reservation));
      if (gate.kind === "revoked") return refuse("revoked");
      if (gate.kind !== "approved" || gate.row.serviceAuthority.approvalDigest !== p.approvalDigest || gate.row.nameAuthorityRevision !== p.nameAuthorityRevision) return refuse("conflict");
      if (!serviceGateApprovalLive(gate.row.serviceAuthority, seconds(Date.now()))) return refuse("expired");
      const name = await nameOf(ctx, p.grant.endpoint);
      if (name === undefined || name.owner !== op.projection.subjectOwner || name.revision !== p.nameAuthorityRevision) return refuse("conflict");
      const step = callerAppendStep(found.pol.state === "value" ? { row: found.pol.row, revision: found.pol.revision } : undefined, emptyPolicy(p.grantee),
        p.expectedPolicyRevision, candidate);
      if (step.kind === "moved") return refuse("conflict");
      if (step.kind === "headroom") return refuse("resource-exhausted");
      if (step.kind !== "write") held("witness-mismatch", ctx.step, "the stored grant differs from the operation's witness");
      ctx.step = "G5-precondition";
      if (!(await payloadHolds(ctx, operationId))) held("payload-precondition", ctx.step, "the payload precondition does not hold; nothing was issued");
      await issue("G5-append", policyKey, p.expectedPolicyRevision);
      const wrote = await put(authorityCtx(inv, op.notAfterMs, "G5-append"), policyKey, step.row, parseNativeServiceCallerPolicy,
        found.pol.state === "value" ? found.pol : undefined);
      if (wrote !== "moved") return adopt(candidate, wrote);
      ctx.step = "G5-append";
      const after = await lookup();
      if (after.grant !== undefined) return adopt(after.grant, after.revision);
      if (after.revision > p.expectedPolicyRevision) return refuse("conflict");
      return held("outcome-unknown", ctx.step, "the issued append's outcome stays unknown until its key moves");
    }
  }

  /** caller-revoke (K0-K3): deny-new, the op-bound cutoff marker and its fixed deadline. It answers
   *  `pending` and never completes here: a terminal caller revocation needs the post-cutoff receipt
   *  inventory and absence proof this host does not build. */
  async function callerRevoke(req: Extract<ServiceHostRequest, { operation: "caller-revoke" }>, authorized: boolean): Promise<Arms> {
    if (!authorized) return unread(req.requestId, "permission-denied", "authorize");
    const operationId = serviceHostOperationId(space, req.requestId), requestDigest = requestDigestOf(req);
    const { grantee, grantId, expectedPolicyRevision } = req.input;
    const scope: ServiceHostScopeTarget = { operation: "caller-revoke", operationId, proposalId: null, owner: null, endpoint: null, instanceId: null,
      lifecycleUid: null, granteeUid: grantee.lifecycleUid, cutoffOperationId: operationId };
    let found: Read<Op> | undefined;
    // Discovery, read only: the cutoff operation is the one the grant's revoking status names, else this request's own.
    try {
      const dctx = discoveryCtx("discover");
      found = await readOp(dctx, operationId);
      const pol = await readPolicy(dctx, grantee.lifecycleUid);
      const g = pol.state === "value" ? pol.row.grants.find((x) => x.grantId === grantId) : undefined;
      if (g !== undefined && g.status.state !== "active") scope.cutoffOperationId = g.status.operationId;
    } catch (err) { if (err instanceof Held) return discoveryHeld(operationId, requestDigest, found, err); throw err; }
    const deadlineMs = Date.now() + S2A_INVOCATION_MS;
    try {
      const first = await invoke(scope, (inv) => attempt(inv, scope.cutoffOperationId!), deadlineMs);
      if (!("rescope" in first)) return first;
      // Another operation landed deny-new first. Every write this invocation issued had a known
      // outcome and its effect closed; reopen once, under the same deadline, for that operation's marker.
      if (Date.now() >= deadlineMs) return { state: "held", operationId, reason: "reconcile-pending", phase: "K1-rescope" };
      const second = await invoke({ ...scope, cutoffOperationId: first.rescope }, (inv) => attempt(inv, first.rescope), deadlineMs);
      return "rescope" in second ? { state: "held", operationId, reason: "scope-mismatch", phase: "K1-rescope" } : second;
    } catch (err) { if (err instanceof Held) return discoveryHeld(operationId, requestDigest, found, err); throw err; }

    async function attempt(inv: Inv, cutoff: string): Promise<Arms | { rescope: string }> {
      inv.operationId = operationId;
      try {
        const ctx = readCtx(inv, "K0-binding");
        for (let n = 0; ; n++) {
          if (n >= S2A_MAX_REDECIDE) held("contention", ctx.step);
          const op = await readOp(ctx, operationId);
          if (op.state === "value" && op.row.requestDigest === requestDigest) {
            // The digest covers the granter, so a replay is by the recorded granter: an operator, or an
            // owner who is the witness's source owner or grantee owner.
            if (req.granter.kind === "owner" && op.row.kind === "service-host-operation" && op.row.plan.kind === "caller-revoke") {
              const w = op.row.plan;
              if (!((w.grant.source.kind === "service-owner" && w.grant.source.owner === req.granter.owner) || w.grantee.owner === req.granter.owner))
                return { state: "held", operationId, reason: "permission-denied", phase: "authorize" };
            }
            return await advanceCallerRevoke(inv, op.row, cutoff);
          }
          if (op.state === "value") return denied("conflict");
          inv.bound = false;
          ctx.step = "K0-admit";
          const pol = await readPolicy(ctx, grantee.lifecycleUid);
          const g = pol.state === "value" && boundTo(pol.row, grantee) ? pol.row.grants.find((x) => x.grantId === grantId) : undefined;
          if (g === undefined) return denied("not-found");
          // A delegated source is never written here, and only a source or grantee owner may revoke as an owner.
          if (g.source.kind !== "service-owner") return denied("unsupported");
          if (req.granter.kind === "owner" && req.granter.owner !== g.source.owner && req.granter.owner !== grantee.owner) return denied("not-found");
          if (g.status.state === "revoked") return denied("conflict");
          if (g.status.state === "active" && (pol as Live<NativeServiceCallerPolicy>).revision !== expectedPolicyRevision) return denied("conflict");
          const adm = await readAdmission(ctx), now = Date.now();
          const { status: _status, ...body } = g;
          ctx.step = "K0-binding";
          const binding: OpLive = { v: 1, kind: "service-host-operation", operationId, requestId: req.requestId, requestDigest, operation: "revoke",
            account: { accountPublicKey, space }, granter: req.granter, admittedAtMs: now, notAfterMs: now + S2A_OPERATION_TTL_MS,
            admissionEpoch: adm.state === "value" ? adm.row.epoch : 0,
            projection: { subjectOwner: g.source.owner, endpoint: g.endpoint, instanceId: g.instanceId, proposalId: null },
            plan: { kind: "caller-revoke", grantee, grantId, expectedPolicyRevision, request: req.input, grant: body }, progress: { state: "admitted" }, debt: [] };
          inv.bound = true;
          if ((await put(ctx, opKey(operationId), binding, parseServiceHostOperationRecord)) !== "moved") return await advanceCallerRevoke(inv, binding, cutoff);
        }
      } catch (err) { if (err instanceof Held) return heldArm(inv, err); throw err; }
    }

    /** K1-K3 from the stored witness. Each step narrows authority only, so none is bounded by the
     *  operation's `notAfterMs`; each still ends at its invocation's deadline. */
    async function advanceCallerRevoke(inv: Inv, first: Op, cutoff: string): Promise<Arms | { rescope: string }> {
      const ctx = readCtx(inv, "K-replay");
      const stored = outcomeOf(first);
      if (stored !== undefined) return stored.state === "complete" ? held("operation-malformed", ctx.step, "a caller revoke never completes") : finalArm(operationId, stored, debtOf(first));
      const p = (first as OpLive).plan as CallerRevokePlan, policyKey = servicePolicyKey(p.grantee.lifecycleUid);
      const witness = immutableGrantView(withStatus(p.grant, { state: "active" }));
      /** The grant from one read; anything but the witness's immutable view holds and writes nothing. */
      const lookup = async () => {
        const pol = await readPolicy(ctx, p.grantee.lifecycleUid);
        const grant = pol.state === "value" && boundTo(pol.row, p.grantee) ? pol.row.grants.find((x) => x.grantId === p.grantId) : undefined;
        if (grant === undefined || immutableGrantView(grant) !== witness) return held("witness-mismatch", ctx.step, "the grant no longer matches the operation's witness");
        return { pol: pol as Live<NativeServiceCallerPolicy>, grant };
      };
      // K1: deny-new under this operation, or the operation that already holds the grant's intent.
      let holder: string | undefined;
      for (let n = 0; holder === undefined; n++) {
        if (n >= S2A_MAX_REDECIDE) held("contention", "K1-deny-new");
        ctx.step = "K1-deny-new";
        const { pol, grant } = await lookup();
        if (grant.status.state === "revoked") held("terminal-unsupported", ctx.step, "a terminal caller revocation is outside this host");
        const step = callerBeginStep(pol.row, p.grantId, operationId);
        if (step.kind === "held") { holder = step.operationId; break; }
        if (step.kind !== "write") held("witness-mismatch", ctx.step, "the grant no longer matches the operation's witness");
        await assertWriteFits(ctx, step.row, operationId);
        if ((await put(ctx, policyKey, step.row, parseNativeServiceCallerPolicy, pol)) !== "moved") holder = operationId;
      }
      if (holder !== cutoff) return { rescope: holder };
      // K2: the holder's marker, created once from the witness; identical bytes are adopted.
      ctx.step = "K2-marker";
      const markerKey = cutoffKey(holder);
      const marker: CutoffMarker = { v: 1, kind: "service-cutoff-marker", accountPublicKey, space, operationId: holder,
        target: { kind: "caller-grant", grantee: p.grantee, grantId: p.grantId, endpoint: p.grant.endpoint, instanceId: p.grant.instanceId },
        authorityDigest: contractDigest({ v: 1, kind: "service-caller-grant-authority", accountPublicKey, space, grantee: p.grantee, grant: p.grant }) };
      let m = await leader(ctx, "auth", markerKey);
      if (m.state === "absent") { await put(ctx, markerKey, marker, parseServiceCutoffMarkerRecord); m = await leader(ctx, "auth", markerKey); }
      if (m.state === "marker") held("marker-tombstone", ctx.step, `${markerKey} carries a ${m.op} marker`);
      let same = false;
      if (m.state === "value") { try { same = contractDigest(parseServiceCutoffMarkerRecord(m.value)) === contractDigest(marker); } catch { same = false; } }
      if (m.state !== "value" || !same) return held("marker-conflict", ctx.step, "the cutoff marker key holds another value; it is never overwritten");
      const at = serviceMarkerCeilSeconds(m.timestamp);
      if (at === undefined) return held("marker-time-unknown", ctx.step, "the marker's stored time is not a readable server time; now is never substituted");
      const cut = { operationId: holder, markerKey, markerRevision: m.revision, notBefore: at + SERVICE_CUTOFF_MARGIN_S };
      // K3: the deadline, recorded once and never reset.
      for (let n = 0; ; n++) {
        if (n >= S2A_MAX_REDECIDE) held("contention", "K3-deadline");
        ctx.step = "K3-deadline";
        const { pol } = await lookup();
        const step = callerCutoffStep(pol.row, p.grantId, cut);
        if (step.kind === "same") break;
        if (step.kind === "conflict") held("marker-conflict", ctx.step, step.detail);
        if (step.kind !== "write") held("witness-mismatch", ctx.step, "the grant no longer matches the operation's witness");
        await assertWriteFits(ctx, step.row, operationId);
        if ((await put(ctx, policyKey, step.row, parseNativeServiceCallerPolicy, pol)) !== "moved") break;
      }
      await updateOp(ctx, operationId, (cur) => (cur.progress.state === "custody" && cur.progress.step === "cutoff-recorded" ? undefined
        : isFinal(cur.progress) ? undefined : { ...cur, progress: { state: "custody", step: "cutoff-recorded" } })).catch((err) => { if (!(err instanceof Held)) throw err; });
      // The phase is advisory, in the gate's whole-second convention; a terminal proof compares broker time.
      return { state: "pending", operationId, phase: seconds(Date.now()) < cut.notBefore ? "cutoff-wait" : "awaiting-terminal-proof", notBefore: cut.notBefore, denyNew: "landed" };
    }
  }

  type PolicyOut = { state: "present"; record: { value: ServiceCallerPolicyView; revision: number } } | { state: "absent" } | Arms;
  type PolicyPage = { state: "page"; records: Array<{ value: ServiceCallerPolicyView; revision: number }>; nextCursor: string | null } | Arms;
  /** A view of one row; a filtered view carries only that service's grants, and the revision is always the whole row's. */
  const policyView = (row: NativeServiceCallerPolicy, service: ServiceSelector | null): ServiceCallerPolicyView => ({
    grantee: { ...row.grantee }, service: service === null ? null : { endpoint: service.endpoint, instanceId: service.instanceId },
    grants: structuredClone(service === null ? row.grants : row.grants.filter((g) => g.endpoint === service.endpoint && g.instanceId === service.instanceId)) });

  /** caller-policy-read: an operator reads any grantee; an owner reads its own grantees in full or
   *  filtered, and another owner's grantee only filtered to a service the owner holds. */
  async function callerPolicyRead(req: Extract<ServiceHostRequest, { operation: "caller-policy-read" }>): Promise<PolicyOut> {
    try {
      const ctx = discoveryCtx("caller-policy-read");
      const { grantee, service } = req.input, g = req.granter;
      if (g.kind === "owner" && grantee.owner !== g.owner) {
        if (service === null) return { state: "absent" };
        const asg = await readAssignment(ctx, service.endpoint, service.instanceId);
        if (asg.state === "absent" || asg.row.owner !== g.owner) return { state: "absent" };
      }
      const pol = await readPolicy(ctx, grantee.lifecycleUid);
      if (pol.state === "absent") return { state: "absent" };
      if (!boundTo(pol.row, grantee)) return denied("conflict");
      return { state: "present", record: { value: policyView(pol.row, service), revision: pol.revision } };
    } catch (err) { if (err instanceof Held) return denied("unavailable"); throw err; }
  }

  const listCursor = (service: ServiceSelector, ownerFilter: string | null, after: string) =>
    Buffer.from(canonicalJson({ v: 1, op: "caller-policy-list", accountPublicKey, space, service, owner: ownerFilter, after }), "utf8").toString("base64url");
  /** caller-policy-list: one service's grantees, from its instance index, in uid order. Space-wide
   *  enumeration is unsupported. An owner lists only a service it holds; an operator any. Orphan
   *  entries are skipped, and an unreadable row fails the whole page. */
  async function callerPolicyList(req: Extract<ServiceHostRequest, { operation: "caller-policy-list" }>): Promise<PolicyPage> {
    const { service, owner: ownerFilter, cursor, limit } = req.input;
    if (service === null) return denied("unsupported");
    const sel = { endpoint: service.endpoint, instanceId: service.instanceId };
    let after: string | null = null;
    if (cursor !== null) {
      try { after = (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Rec)?.after as string; } catch { return denied("bad-request"); }
      if (typeof after !== "string" || listCursor(sel, ownerFilter, after) !== cursor) return denied("bad-request");
    }
    try {
      const ctx = discoveryCtx("caller-policy-list");
      const empty: PolicyPage = { state: "page", records: [], nextCursor: null };
      if (req.granter.kind === "owner") {
        const asg = await readAssignment(ctx, sel.endpoint, sel.instanceId);
        if (asg.state === "absent" || asg.row.owner !== req.granter.owner) return empty;
      }
      const idx = await readCallerIndex(ctx, sel.endpoint, sel.instanceId);
      const uids = [...new Set((idx.state === "value" ? idx.row.entries : []).map((e) => e.granteeUid))].filter((u) => after === null || u > after);
      const records: Array<{ value: ServiceCallerPolicyView; revision: number }> = [];
      let last: string | undefined, more = false;
      for (const uid of uids) {
        const pol = await readPolicy(ctx, uid);
        if (pol.state === "absent") continue;
        if (pol.row.grantee.lifecycleUid !== uid || pol.row.accountPublicKey !== accountPublicKey || pol.row.space !== space) return denied("unavailable");
        const value = policyView(pol.row, sel);
        if (value.grants.length === 0 || (ownerFilter !== null && pol.row.grantee.owner !== ownerFilter)) continue;
        if (records.length === limit) { more = true; break; }
        records.push({ value, revision: pol.revision }); last = uid;
      }
      return { state: "page", records, nextCursor: more && last !== undefined ? listCursor(sel, ownerFilter, last) : null };
    } catch (err) { if (err instanceof Held) return denied("unavailable"); throw err; }
  }

  // ---- reads (never write) ------------------------------------------------------------------------

  type ReadOut<T> = { state: "present"; record: { value: T; revision: number } } | { state: "absent" } | Arms;
  async function operationRead(req: Extract<ServiceHostRequest, { operation: "operation-read" }>): Promise<ReadOut<ServiceOperationView | ServiceOperationTerminalView>> {
    try {
      const ctx = discoveryCtx("operation-read");
      const op = await readOp(ctx, req.input.operationId);
      if (op.state === "absent") return { state: "absent" };
      const g = req.granter, o = op.row;
      if (g.kind === "owner" && !((o.granter.kind === "owner" && o.granter.owner === g.owner) || o.projection.subjectOwner === g.owner)) return { state: "absent" };
      const projection = { ...o.projection };
      if (o.kind === "service-host-operation-terminal")
        return { state: "present", record: { value: { operationId: o.operationId, requestDigest: o.requestDigest, operation: o.operation, projection, outcome: finalView(o.outcome) }, revision: op.revision } };
      const p = o.plan, assignmentDigest = p.kind === "approve" ? serviceAssignmentGate(discovery.host, p.reservation).binding.assignmentDigest : p.kind === "revoke" ? p.expectedAssignmentDigest : null;
      const target: ServiceOperationView["target"] = p.kind === "caller-grant" || p.kind === "caller-revoke" ? { kind: "caller", grantee: { ...p.grantee } }
        : { kind: "service", endpoint: o.projection.endpoint, instanceId: o.projection.instanceId, assignmentDigest };
      const g2 = o.progress;
      const progress: ServiceOperationView["progress"] = g2.state === "admitted" ? { state: "pending", phase: "admitted" }
        : g2.state === "custody" || g2.state === "issued" ? { state: "pending", phase: g2.step }
        : g2.state === "held" ? { state: "held", reason: g2.reason, phase: g2.phase } : finalView(g2);
      return { state: "present", record: { value: { operationId: o.operationId, requestDigest: o.requestDigest, operation: o.operation,
        target, projection, progress, debt: o.debt.map((d) => ({ ...d })) }, revision: op.revision } };
    } catch (err) { if (err instanceof Held) return denied("unavailable"); throw err; }
  }
  const finalView = (f: Final): ServiceOperationTerminalView["outcome"] =>
    f.state === "complete" ? { state: "complete", resultDigest: contractDigest(f.result) } : f.state === "refused" ? { state: "refused", reason: f.reason } : { state: "superseded", boundOperationId: f.boundOperationId };

  async function proposalRead(req: Extract<ServiceHostRequest, { operation: "proposal-read" }>): Promise<ReadOut<ServiceProposalView | ServiceProposalTombstoneView>> {
    try {
      const ctx = discoveryCtx("proposal-read");
      const prop = await readProposal(ctx, req.input.proposalId);
      if (prop.state === "absent" || (req.granter.kind === "owner" && prop.row.owner !== req.granter.owner)) return { state: "absent" };
      const p = prop.row;
      if (p.kind === "service-proposal-terminal") return { state: "present", record: { value: view(p), revision: prop.revision } };
      const name = await nameOf(ctx, p.endpoint);
      return { state: "present", record: { value: { proposalId: p.proposalId, proposalDigest: p.proposalDigest, owner: p.owner, endpoint: p.endpoint, instanceId: p.instanceId,
        state: p.state.state, createdAt: seconds(p.createdAtMs), expiresAt: seconds(p.expiresAtMs), clusterDigests: [...p.clusterDigests], commands: structuredClone(p.commands),
        nameBinding: name ?? null, decision: p.state.state === "approving" ? { operationId: p.state.operationId, assignmentDigest: p.state.assignmentDigest } : null }, revision: prop.revision } };
    } catch (err) { if (err instanceof Held) return denied("unavailable"); throw err; }
  }

  // ---- name binding (create-only) ----------------------------------------------------------------

  type NameOut = Arms | { state: "bound"; binding: ServiceNameView };
  /** One zero-history create of the endpoint's name row through this invocation's custody host. Only
   *  the identical request recovers an existing row; transfer, release and update do not exist. */
  async function nameBind(req: Extract<ServiceHostRequest, { operation: "name-bind" }>): Promise<NameOut> {
    const { endpoint: e, owner: o, expectedRevision, claimReference } = req.input;
    if (expectedRevision !== 0) return denied("unsupported");                                            // never binds
    let key: string;
    try { key = serviceNameKey(e); }
    catch (err) { if (err instanceof EpEnvelopeError && err.code === "permission-denied") return denied("permission-denied"); throw err; }
    const bytes = serviceNameRowBytes({ accountPublicKey, space }, req), requestDigest = contractDigest(req);
    const operationId = serviceHostOperationId(space, req.requestId);
    try {
      return await invoke({ operation: "name-bind", operationId: null, proposalId: null, owner: null, endpoint: e, instanceId: null, lifecycleUid: null }, async (inv) => {
        inv.operationId = operationId;
        try {
          const ctx = readCtx(inv, "N-read");
          for (let n = 0; ; n++) {
            if (n >= S2A_MAX_REDECIDE) held("contention", ctx.step);
            const found = await nameOf(ctx, e);
            if (found !== undefined) {
              if (found.requestId === req.requestId && found.requestDigest === requestDigest && found.owner === o && found.claimReference === claimReference)
                return { state: "bound", binding: found };
              return denied(found.requestId === req.requestId ? "conflict" : "name-bound");
            }
            ctx.step = "N-create";
            await write(ctx, "auth", key, bytes, { create: true });
            ctx.step = "N-read";
          }
        } catch (err) { if (err instanceof Held) return heldArm(inv, err); throw err; }
      });
    } catch (err) { if (err instanceof Held) return unread(req.requestId, err.reason, err.step); throw err; }
  }

  // ---- serving: register, activate, renew and ready (SPEC 13.1) -----------------------------------

  type Bound = { state: "bound"; row: Extract<Assignment, { state: "bound" }>; binding: ServiceAssignmentBinding; epgate: ServiceGateRows };
  type Binding = { state: "absent" } | { state: "fenced"; row: Extract<Assignment, { state: "fenced" }> } | Bound;
  const deniedServe = (reason: string): ServiceServeResult => ({ state: "denied", reason });
  /** The owner's own assignment at a selector; another owner's reads absent. */
  async function bindingOf(ctx: Ctx, o: string, e: string, i: string): Promise<Binding> {
    const asg = await readAssignment(ctx, e, i);
    if (asg.state === "absent" || asg.row.owner !== o) return { state: "absent" };
    if (asg.row.state === "fenced") return { state: "fenced", row: asg.row };
    return { state: "bound", row: asg.row, ...serviceAssignmentGate(discovery.host, asg.row.reservation) };
  }
  /** A witness is a public coordinate: it must name this selector, owner, actor and lifecycle. */
  const namesBinding = (w: ServiceRegistrationWitness, b: ServiceAssignmentBinding) =>
    namesSelector(w, b) && w.principal.actor === serviceEndpointActor(b) && w.principal.lifecycleUid === b.lifecycleUid;
  /** The part of {@link namesBinding} a selector alone decides, before anything is read. */
  const namesSelector = (w: ServiceRegistrationWitness, s: { owner: string; endpoint: string; instanceId: string }) =>
    w.accountPublicKey === accountPublicKey && w.space === space && w.endpoint === s.endpoint && w.instanceId === s.instanceId && w.principal.owner === s.owner;
  /** The witness of a gate's current registration stamp, or undefined when the gate has none. A stamp
   *  whose coordinates disagree with the gate's is inconsistent and holds. */
  function stampWitness(ctx: Ctx, b: ServiceAssignmentBinding, row: EndpointRow): ServiceRegistrationWitness | undefined {
    const a = row.serviceAuthority, stamp = a.registration;
    if (stamp === undefined) return undefined;
    if (a.rootCredentialId === null || a.approvalDigest === null || stamp.processEpoch !== row.processEpoch
      || stamp.registrationRevision !== row.registrationRevision || stamp.nameAuthorityRevision !== row.nameAuthorityRevision)
      return held("registration-inconsistent", ctx.step, "the registration stamp disagrees with its endpoint gate");
    return { accountPublicKey, space, endpoint: b.endpoint, instanceId: b.instanceId,
      principal: { owner: b.owner, actor: serviceEndpointActor(b), lifecycleUid: b.lifecycleUid },
      rootCredentialId: a.rootCredentialId, approvalDigest: a.approvalDigest, processEpoch: stamp.processEpoch,
      registrationRevision: stamp.registrationRevision, nameAuthorityRevision: stamp.nameAuthorityRevision,
      registrationRequestId: stamp.requestId, registrationProof: stamp.registrationProof };
  }
  /** The closures' manifest and root documents, each verified against its digest. */
  async function closureArtifacts(ctx: Ctx, clusterDigests: string[]): Promise<unknown[]> {
    const reader = opts.serving?.readContractArtifact;
    if (reader === undefined) return held("unavailable", ctx.step, "this host has no contract store reader");
    const get = async (d: string) => {
      const r = await bounded(ctx, () => reader(d));
      if (!r.ok) return held("unavailable", ctx.step, "timedOut" in r ? `the contract artifact ${d} read timed out` : message(r.error));
      return r.value;
    };
    const out: unknown[] = [];
    for (const closure of clusterDigests) {
      const manifest = await get(closure);
      const document = await grammarHeld(ctx, async () => { const { root } = verifyClusterManifest(closure, manifest); const raw = await get(root); verifyClusterRoot(root, raw); return raw; });
      out.push(manifest, document);
    }
    return out;
  }
  /** A read that its own parser or verifier refuses holds as inconsistent, never as absence. */
  async function grammarHeld<T>(ctx: Ctx, f: () => Promise<T> | T): Promise<T> {
    try { return await f(); } catch (e) { if (e instanceof Held) throw e; return held("registration-inconsistent", ctx.step, message(e)); }
  }
  /** The registered spec at the witness revision, the name revision and the closures' artifacts. */
  async function snapshotOf(ctx: Ctx, w: ServiceRegistrationWitness, artifacts?: unknown[]): Promise<ServiceRegistrationSnapshot> {
    const cur = await leader(ctx, "records", recordSpecKey(RECORD_KINDS.svc, [w.endpoint, w.instanceId]));
    if (cur.state !== "value" || cur.revision !== w.registrationRevision)
      return held("registration-inconsistent", ctx.step, "the registered spec is not readable at the witness revision");
    const spec: ServiceSpec = await grammarHeld(ctx, () => parseServiceSpec(cur.value, { endpoint: w.endpoint }));
    if (spec.owner !== w.principal.owner) return held("registration-inconsistent", ctx.step, "the registered spec names another owner");
    return { spec: { value: spec, revision: cur.revision }, name: { authorized: true, revision: w.nameAuthorityRevision }, processEpoch: w.processEpoch,
      contractArtifacts: artifacts ?? await closureArtifacts(ctx, spec.clusterDigests) };
  }
  /** The service-reported ready status at the witness's epoch and spec revision, if recorded. */
  async function reportedAt(ctx: Ctx, w: ServiceRegistrationWitness): Promise<number | undefined> {
    const cur = await leader(ctx, "records", recordStatusKey(RECORD_KINDS.svc, [w.endpoint, w.instanceId]));
    if (cur.state === "absent" || cur.state === "marker") return undefined;
    if (cur.state === "malformed") return held("registration-inconsistent", ctx.step, "the service status is not JSON");
    const status = await grammarHeld(ctx, () => parseServiceStatus(cur.value));
    const at = (status as { reportedAt?: unknown }).reportedAt;
    return status.state === "ready" && status.epoch === w.processEpoch && status.observedSpecRevision === w.registrationRevision
      && typeof at === "number" && Number.isSafeInteger(at) && at >= 0 ? at : undefined;
  }
  /** The live native root's expiry in Unix seconds; a refused proof is a definite refusal. */
  async function rootExpiresAt(ctx: Ctx, inv: Inv, b: ServiceAssignmentBinding, rootCredentialId: string): Promise<number | ServiceServeResult> {
    const r = await bounded(ctx, () => readRegistryServiceRoot(inv.h.registry, b, rootCredentialId, Date.now()));
    if (r.ok) return r.value.expiresAt;
    if ("error" in r && r.error instanceof EpEnvelopeError && r.error.code === "permission-denied") return deniedServe("root-revoked");
    return held("unavailable", ctx.step, "timedOut" in r ? "the native root read timed out" : message(r.error));
  }
  /** Run one native multi-request step to completion or the invocation's original deadline, which
   *  ends the step held; the step's own later requests then fail on the closed connection. */
  async function native<T>(ctx: Ctx, start: () => Promise<T>): Promise<T> {
    const remaining = ctx.deadlineMs - Date.now();
    if (remaining <= 0) return held("deadline", ctx.step, "the original deadline has passed; no request starts");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), remaining); });
    const settled = start().then((value) => ({ value }), (error: unknown) => ({ error }));
    let r: { value: T } | { error: unknown } | "timeout";
    try { r = await Promise.race([settled, timeout]); } finally { clearTimeout(timer); }
    if (r === "timeout") return held("deadline", ctx.step, "the original deadline was reached during a native step");
    if ("error" in r) return held("unknown", ctx.step, `the native step did not complete: ${message(r.error)}`);
    return r.value;
  }
  /** Classify the assignment's endpoint gate; anything but an approved or revoked service gate is
   *  inconsistent for a bound selector past approval. */
  async function servedGate(ctx: Ctx, b: Bound) {
    const g = await endpoint(ctx, b);
    if (g.kind !== "approved" && g.kind !== "revoked") return held("registration-inconsistent", ctx.step, `the endpoint gate is ${g.kind}`);
    return g;
  }
  const sameIntent = (a: Intent, b: Intent) => canonicalJson({ ...a, admittedAtMs: 0 }) === canonicalJson({ ...b, admittedAtMs: 0 });

  /** A register key the proposal phase already admitted stays bound to that admission's body and
   *  proposal: a changed body is a conflict, and a key of another proposal answers that proposal's
   *  own refusal, or a conflict. */
  async function keyHistory(ctx: Ctx, req: ServiceServeRequest, b: Bound, id: string): Promise<ServiceServeResult | undefined> {
    ctx.step = "S-key";
    const op = await readOp(ctx, id);
    if (op.state === "absent") return undefined;
    const r = req.register!;
    const admitted = serviceRegisterHostRequest({ owner: req.owner, endpoint: req.endpoint, instanceId: req.instanceId, engineRequestId: req.engineRequestId,
      requestId: req.requestId, requestDigest: req.requestDigest, clusterDigests: r.clusterDigests, commands: r.commands });
    if (op.row.operation !== "register" || op.row.requestDigest !== requestDigestOf(admitted)) return deniedServe("conflict");
    const proposalId = op.row.projection.proposalId;
    if (proposalId === b.row.proposalId) return undefined;
    const p = proposalId === null ? undefined : await readProposal(ctx, proposalId);
    if (p?.state === "value") {
      if (p.row.kind === "service-proposal-terminal" && (p.row.state === "refused" || p.row.state === "expired"))
        return deniedServe(p.row.state === "expired" ? "proposal-expired" : "proposal-refused");
      if (p.row.kind === "service-proposal" && p.row.state.state === "proposed" && Date.now() >= p.row.expiresAtMs) return deniedServe("proposal-expired");
    }
    return deniedServe("conflict");
  }

  /** R1 §A: a new admission's key history and state check, read before anything is written. */
  async function admissible(ctx: Ctx, req: ServiceServeRequest, b: Bound, id: string): Promise<ServiceServeResult | undefined> {
    if (req.operation === "register") {
      const k = await keyHistory(ctx, req, b, id);
      if (k !== undefined) return k;
    }
    ctx.step = "S-state";
    if (b.row.cancel !== null) return deniedServe("approval-revoked");
    const g = await servedGate(ctx, b);
    if (g.kind === "revoked") return deniedServe("approval-revoked");
    const a = g.row.serviceAuthority, current = stampWitness(ctx, b.binding, g.row);
    if (req.operation === "register") {
      if (a.activationIssued) return deniedServe("registration-active");
      const p = await readProposal(ctx, b.row.proposalId);
      if (p.state !== "value" || p.row.kind !== "service-proposal-terminal" || p.row.state !== "approved" || p.row.approvalDigest !== a.approvalDigest)
        return held("registration-inconsistent", ctx.step, "the assignment's approved proposal is not readable");
      const r = req.register!;
      if (proposalBodyDigest({ owner: b.binding.owner, endpoint: b.binding.endpoint, instanceId: b.binding.instanceId }, r.clusterDigests, r.commands) !== p.row.proposalDigest)
        return deniedServe("approval-mismatch");
      const expected = req.witness === null ? undefined : serviceWitnessDigest(req.witness);
      if ((current === undefined) !== (expected === undefined) || (current !== undefined && serviceWitnessDigest(current) !== expected)) return deniedServe("conflict");
      return undefined;
    }
    if (current === undefined || serviceWitnessDigest(current) !== serviceWitnessDigest(req.witness!)) return deniedServe("stale-witness");
    return undefined;
  }
  /** Append the request to its instance's index, or find it listed. */
  async function listIntent(ctx: Ctx, b: Bound, id: string, operation: ServiceServeOperation): Promise<ServiceServeResult | undefined> {
    ctx.step = "S-index";
    const { owner: o, endpoint: e, instanceId: i } = b.binding;
    for (let n = 0; n < S2A_MAX_REDECIDE; n++) {
      const cur = await readIntentIndex(ctx, e, i);
      if (cur.state === "value") {
        if (cur.row.owner !== o || cur.row.endpoint !== e || cur.row.instanceId !== i)
          return held("intent-index-inconsistent", ctx.step, "the intent index names another assignment");
        if (cur.row.intents.some((x) => x.operationId === id)) return undefined;
        if (cur.row.intents.length >= S3_MAX_INTENTS_PER_INSTANCE) return deniedServe("resource-exhausted");
      }
      const intents = [...(cur.state === "value" ? cur.row.intents : []), { operationId: id, operation }]
        .sort((x, y) => (x.operationId < y.operationId ? -1 : 1));
      const row: IntentIndex = { v: 1, kind: "service-request-intent-index", owner: o, endpoint: e, instanceId: i, intents };
      if ((await put(ctx, intentIndexKey(e, i), row, parseServiceRequestIntentIndexRecord, cur.state === "value" ? cur : undefined)) !== "moved") return undefined;
    }
    return held("contention", ctx.step);
  }

  async function serve(req: ServiceServeRequest): Promise<ServiceServeResult> {
    if (tripped !== undefined || closed) return { state: "unavailable", detail: "the service host is fenced or closing" };
    const { owner: o, endpoint: e, instanceId: i } = req;
    if (req.caller === "owner" && !interactive(o)) return deniedServe("permission-denied");
    const id = serviceHostOperationId(space, req.engineRequestId);
    let b: Binding;
    try { b = await bindingOf(discoveryCtx("S-binding"), o, e, i); }
    catch (err) { if (err instanceof Held) return { state: "unavailable", detail: `the assignment is not readable (${err.reason})` }; throw err; }
    if (b.state === "absent") return deniedServe("permission-denied");
    if (b.state === "fenced") return deniedServe("approval-revoked");
    if (req.witness !== null && !namesBinding(req.witness, b.binding)) return deniedServe("permission-denied");
    const intent: Intent = { v: 1, kind: "service-request-intent", operationId: id, operation: req.operation, account: { accountPublicKey, space },
      owner: o, endpoint: e, instanceId: i, requestId: req.requestId, requestDigest: req.requestDigest,
      registrationRequestId: req.witness?.registrationRequestId ?? null, witnessDigest: req.witness === null ? null : serviceWitnessDigest(req.witness),
      admittedAtMs: Date.now() };
    const contract = req.register?.artifacts.map((a) => contractDigest(a).slice("sha256:".length)) ?? [];
    const bound = b;
    try {
      return await invoke({ operation: "serve", serve: req.operation, operationId: id, proposalId: null, owner: o, endpoint: e, instanceId: i,
        lifecycleUid: b.binding.lifecycleUid, contract }, async (inv) => {
        const ctx = readCtx(inv, "S-intent");
        const found = await readIntent(ctx, id);
        if (found.state === "value") { if (!sameIntent(found.row, intent)) return deniedServe("conflict"); }
        else {
          const refusal = (await admissible(ctx, req, bound, id)) ?? (await listIntent(ctx, bound, id, req.operation));
          if (refusal !== undefined) return refusal;
          ctx.step = "S-intent-create";
          if ((await put(ctx, intentKey(id), intent, parseServiceRequestIntentRecord)) === "moved") {
            const again = await readIntent(ctx, id);
            if (again.state !== "value") return held("unknown", ctx.step, "the intent create lost but no intent is readable");
            if (!sameIntent(again.row, intent)) return deniedServe("conflict");
          }
        }
        switch (req.operation) {
          case "register": return registerEffect(ctx, inv, req, bound, id);
          case "activate": case "renew": return credentialEffect(ctx, inv, req, bound);
          case "ready": return readyEffect(ctx, inv, req, bound);
        }
      });
    } catch (err) {
      if (err instanceof Held) return { state: "unavailable", detail: `${req.operation} held (${err.reason} at ${err.step})` };
      throw err;
    }
  }

  /** Same-request recovery first, from the stamp alone; otherwise publish, barrier, spec and stamp. */
  async function registerEffect(ctx: Ctx, inv: Inv, req: ServiceServeRequest, b: Bound, id: string): Promise<ServiceServeResult> {
    ctx.step = "R-gate";
    const r = req.register!;
    const stampedHere = (row: EndpointRow) => {
      const stamp = row.serviceAuthority.registration;
      return stamp?.requestId === req.requestId && stamp.requestDigest === req.requestDigest;
    };
    const frozenHere = (row: EndpointRow) => {
      const pending = row.serviceAuthority.pendingRegistration;
      return row.state === "frozen" && pending?.operationId === id && pending.requestId === req.requestId && pending.requestDigest === req.requestDigest;
    };
    const recovered = async (g: Awaited<ReturnType<typeof servedGate>>) => {
      if (!stampedHere(g.row)) return undefined;
      const witness = stampWitness(ctx, b.binding, g.row)!;
      return { state: "registered" as const, witness, snapshot: await snapshotOf(ctx, witness, r.artifacts) };
    };
    // Revocation answers first, as status does; then a completed same request recovers from its
    // stamp before any expected or activation check, with no barrier and no epoch advance.
    const g = await servedGate(ctx, b);
    if (g.kind === "revoked" || b.row.cancel !== null) return deniedServe("approval-revoked");
    const done = await recovered(g);
    if (done !== undefined) return done;
    const a = g.row.serviceAuthority;
    if (a.activationIssued) return deniedServe("registration-active");
    const resuming = frozenHere(g.row);
    const expected = req.witness === null ? undefined : serviceWitnessDigest(req.witness);
    const expectationHolds = (row: EndpointRow) => {
      const current = stampWitness(ctx, b.binding, row);
      return current === undefined ? expected === undefined : serviceWitnessDigest(current) === expected;
    };
    if (!resuming) {
      if (g.row.state !== "open") return deniedServe("registration-pending");
      if (!expectationHolds(g.row)) return deniedServe("conflict");
      if (!serviceGateApprovalLive(a, seconds(Date.now()))) return deniedServe("expired");
    }
    if (inv.contract === undefined) return held("unavailable", ctx.step, "the effect connection has no contract store");
    ctx.step = "R-publish";
    for (const artifact of r.artifacts) {
      await readyBefore(ctx);
      const p = await bounded(ctx, () => publishContractArtifact(inv.contract!, contractArtifactCanonicalBytes(artifact)));
      if (!p.ok) return held("unknown", ctx.step, "timedOut" in p ? "a contract artifact publish timed out" : message(p.error));
    }
    ctx.step = "R-register";
    const stores = registryStores(inv.h.registry), artifacts = new Map(r.artifacts.map((v) => [contractDigest(v), v] as const));
    // A service family is empty before activation, so the barrier keeps no repair cursor.
    const { progress: _progress, ...observed } = endpointRegistrationBarrier(stores.authKv, space,
      { endpoint: b.binding.endpoint, instanceId: b.binding.instanceId, opId: id, serviceRegistration: { requestId: req.requestId, requestDigest: req.requestDigest } });
    void _progress;
    // The barrier freezes the gate revision it observes after the publishes above, whenever it does
    // not find the gate frozen by this operation: also for a request that read it frozen and finds
    // it reopened. The checks above ran on an earlier read, so they are made again on exactly the
    // revision being frozen, and nothing is frozen or written unless they hold. A stamp that already
    // names this request was completed by another invocation of it and answers as a replay does; a
    // freeze of this operation with no stamp yet is that invocation still running, so this one holds.
    let decided: "approval-revoked" | "stamped" | "running" | "conflict" | undefined;
    const barrier = { ...observed, freeze: async (revision: number) => {
      const now = await servedGate(ctx, b);
      if (now.kind === "revoked") decided = "approval-revoked";
      else if (stampedHere(now.row)) decided = "stamped";
      else if (frozenHere(now.row)) decided = "running";
      else if (now.revision !== revision || now.row.state !== "open" || !expectationHolds(now.row)) decided = "conflict";
      return decided === undefined ? await observed.freeze(revision) : null;
    } };
    await readyBefore(ctx);
    try {
      await native(ctx, () => registerServiceInstance(stores.recordsKv, { space, instanceId: b.binding.instanceId, registrant: { owner: b.binding.owner },
        spec: { endpoint: b.binding.endpoint, owner: b.binding.owner, clusterDigests: [...r.clusterDigests], protocol: { v: 1 } },
        authority: nativeServiceNameAuthority(inv.h.registry, { space, accountPublicKey }), barrier, readClusterArtifact: (d) => artifacts.get(d) }));
    } catch (err) {
      if (decided === undefined || !(err instanceof Held)) throw err;
      if (decided === "running") return held("unknown", ctx.step, "another invocation of this request froze the gate and has not completed");
      if (decided !== "stamped") return deniedServe(decided);
      ctx.step = "R-confirm";
      const now = await servedGate(ctx, b);
      if (now.kind === "revoked") return deniedServe("approval-revoked");
      return (await recovered(now)) ?? held("unknown", ctx.step, "this request's registration was replaced while it was confirmed");
    }
    await readyAfter(ctx);
    ctx.step = "R-confirm";
    const after = await recovered(await servedGate(ctx, b));
    return after ?? held("unknown", ctx.step, "the registration completed but its stamp does not name this request");
  }

  /** activate: the monotonic activation CAS at the current witness; renew: the same checks with no
   *  write. Either returns the bounds fresh material must keep; no material is minted here. */
  async function credentialEffect(ctx: Ctx, inv: Inv, req: ServiceServeRequest, b: Bound): Promise<ServiceServeResult> {
    for (let n = 0; n < S2A_MAX_REDECIDE; n++) {
      ctx.step = req.operation === "activate" ? "A-gate" : "W-gate";
      const g = await servedGate(ctx, b);
      if (g.kind === "revoked" || b.row.cancel !== null) return deniedServe("approval-revoked");
      const a = g.row.serviceAuthority, current = stampWitness(ctx, b.binding, g.row);
      if (current === undefined || serviceWitnessDigest(current) !== serviceWitnessDigest(req.witness!)) return deniedServe("stale-witness");
      if (g.row.state !== "open") return deniedServe("registration-pending");
      if (!serviceGateApprovalLive(a, seconds(Date.now()))) return deniedServe("expired");
      const root = await rootExpiresAt(ctx, inv, b.binding, current.rootCredentialId);
      if (typeof root !== "number") return root;
      if (!a.activationIssued) {
        if (req.operation === "renew") return deniedServe("stale-witness");
        ctx.step = "A-activate";
        const next = await grammarHeld(ctx, () => activatedServiceGateRow(g.row, b.binding, current, Date.now()));
        if (next !== undefined) {
          const bytes = enc.encode(JSON.stringify(next));
          await grammarHeld(ctx, () => b.epgate.parse(bytes));
          if ((await write(ctx, "auth", b.epgate.key, bytes, { revision: g.revision, preimage: g.bytes })) === "moved") continue;
        }
      }
      return { state: "current", witness: current, snapshot: await snapshotOf(ctx, current), rootExpiresAt: root, approvalExpiresAt: a.approvalExpiresAt };
    }
    return held("contention", ctx.step);
  }

  /** ready: the service-reported status at the current activated witness, fenced on its epoch. */
  async function readyEffect(ctx: Ctx, inv: Inv, req: ServiceServeRequest, b: Bound): Promise<ServiceServeResult> {
    ctx.step = "Y-gate";
    const g = await servedGate(ctx, b);
    if (g.kind === "revoked" || b.row.cancel !== null) return deniedServe("approval-revoked");
    const a = g.row.serviceAuthority, current = stampWitness(ctx, b.binding, g.row);
    if (current === undefined || serviceWitnessDigest(current) !== serviceWitnessDigest(req.witness!) || !a.activationIssued) return deniedServe("stale-witness");
    if (g.row.state !== "open") return deniedServe("registration-pending");
    if (!serviceGateApprovalLive(a, seconds(Date.now()))) return deniedServe("expired");
    const root = await rootExpiresAt(ctx, inv, b.binding, current.rootCredentialId);
    if (typeof root !== "number") return root;
    const name = await nameOf(ctx, b.binding.endpoint);
    if (name === undefined || name.owner !== b.binding.owner || name.revision !== current.nameAuthorityRevision) return deniedServe("stale-witness");
    ctx.step = "Y-status";
    const at = seconds(Date.now()), stores = registryStores(inv.h.registry);
    await readyBefore(ctx);
    await native(ctx, () => writeServiceStatus(stores.recordsKv, { endpoint: b.binding.endpoint, instanceId: b.binding.instanceId, epoch: current.processEpoch,
      status: { epoch: current.processEpoch, state: "ready", observedSpecRevision: current.registrationRevision, reportedAt: at },
      readProcessEpoch: async () => {
        const now = await servedGate(ctx, b);
        if (now.row.state !== "open" || stampWitness(ctx, b.binding, now.row)?.registrationRequestId !== current.registrationRequestId)
          throw new EpEnvelopeError("conflict", "the registration changed before the ready status was written");
        return now.row.processEpoch;
      } }));
    await readyAfter(ctx);
    return { state: "ready", witness: current, reportedAt: at };
  }

  // ---- serving status (SPEC 13.1 precedence) ------------------------------------------------------

  async function serveStatus(q: ServiceStatusQuery): Promise<ServiceStatusAnswer> {
    if (tripped !== undefined || closed) return { kind: "unavailable", detail: "the service host is fenced or closing" };
    // An owner reads only while it holds an interactive row, as for every owner request; a service
    // reads only its own selector. Both are refused before any read.
    if (q.reader.kind === "owner" && !interactive(q.owner)) return { kind: "denied", reason: "permission-denied" };
    if (q.reader.kind === "service" && !namesSelector(q.reader.witness, q)) return { kind: "not-found" };
    try { return await statusOf(discoveryCtx("T-read"), q); }
    catch (err) { if (err instanceof Held) return { kind: "unavailable", detail: `status held (${err.reason} at ${err.step})` }; throw err; }
  }
  async function statusOf(ctx: Ctx, q: ServiceStatusQuery): Promise<ServiceStatusAnswer> {
    const status = (s: ServiceAuthorityStatus): ServiceStatusAnswer => ({ kind: "status", status: s });
    const unavailable = (detail: string): ServiceStatusAnswer => ({ kind: "unavailable", detail });
    const readerDigest = q.reader.kind === "service" ? serviceWitnessDigest(q.reader.witness) : null;
    let intent: Intent | undefined;
    if (q.target.kind === "operation") {
      const id = serviceHostOperationId(space, q.target.engineRequestId);
      const found = await readIntent(ctx, id);
      if (found.state === "absent") {
        const idx = await readIntentIndex(ctx, q.endpoint, q.instanceId);
        if (idx.state === "value" && idx.row.owner === q.owner && idx.row.intents.some((x) => x.operationId === id))
          return unavailable("the request is listed without its intent; replay it");
        return q.target.operation === "register" && readerDigest === null ? { kind: "proposal-phase" } : { kind: "not-found" };
      }
      intent = found.row;
      if (intent.owner !== q.owner || (readerDigest !== null && intent.witnessDigest !== readerDigest)) return { kind: "not-found" };
    }
    const b = await bindingOf(ctx, q.owner, q.endpoint, q.instanceId);
    if (b.state === "absent") return intent === undefined ? { kind: "not-found" } : unavailable("the intent's assignment is not readable");
    // A service reader's own incarnation before any precedence rule. A fenced assignment keeps no
    // lifecycle, so only the selector check above applies to it.
    if (b.state === "bound" && q.reader.kind === "service" && !namesBinding(q.reader.witness, b.binding)) return { kind: "not-found" };
    // Rule 3: cancellation and revocation first.
    if (b.state === "fenced") return status({ state: "revoking", operationId: b.row.cancel.operationId, phase: "deny-new-landed" });
    const g = await endpoint(ctx, b);
    if (b.row.cancel !== null) return status({ state: "revoking", operationId: b.row.cancel.operationId, phase: g.kind === "revoked" ? "deny-new-landed" : "deny-new-pending" });
    if (g.kind === "revoked" || g.kind === "foreign") return unavailable(`the endpoint gate is ${g.kind} without a bound cancel`);
    if (g.kind === "absent" || g.kind === "pending") {
      if (intent !== undefined) return unavailable("the intent's approval is not readable");
      return status({ state: "registering", operationId: b.row.creation.operationId, phase: "approving" });
    }
    const a = g.row.serviceAuthority, stamp = a.registration, pending = a.pendingRegistration;
    const current = stampWitness(ctx, b.binding, g.row);
    const live = async (w: ServiceRegistrationWitness): Promise<ServiceStatusAnswer> => {
      const snapshot = await snapshotOf(ctx, w), at = await reportedAt(ctx, w);
      return status(at === undefined ? { state: "registered", witness: w, snapshot } : { state: "ready", witness: w, snapshot, reportedAt: at });
    };
    if (intent === undefined) {
      // The instance: the reader's own incarnation, or the owner's current state.
      if (q.reader.kind === "service") {
        if (stamp === undefined) return unavailable("the reader's registration has no stamp");
        if (stamp.requestId !== q.reader.witness.registrationRequestId)
          return status({ state: "superseded", registrationRequestId: q.reader.witness.registrationRequestId, currentRegistrationRequestId: stamp.requestId });
      }
      if (g.row.state === "frozen") return pending ? status({ state: "registering", operationId: pending.operationId, phase: "barrier" }) : unavailable("the gate is frozen without a pending registration");
      if (current === undefined) return status({ state: "approved-unregistered", approvalDigest: a.approvalDigest! });
      if (readerDigest !== null && serviceWitnessDigest(current) !== readerDigest) return unavailable("the reader's witness disagrees with the current stamp");
      return live(current);
    }
    if (intent.operation === "register") {
      // Rule 5: the permanent answers before the transient ones.
      if (stamp?.requestId === intent.requestId && stamp.requestDigest === intent.requestDigest) return live(current!);
      if (stamp !== undefined && (stamp.requestId !== intent.registrationRequestId || a.activationIssued))
        return status({ state: "superseded", registrationRequestId: intent.requestId, currentRegistrationRequestId: stamp.requestId });
      if (pending?.requestId === intent.requestId && pending.requestDigest === intent.requestDigest)
        return status({ state: "registering", operationId: intent.operationId, phase: "barrier" });
      if ((stamp === undefined && intent.registrationRequestId === null) || (stamp?.requestId === intent.registrationRequestId && !a.activationIssued))
        return status({ state: "registering", operationId: intent.operationId, phase: "admitted" });
      return unavailable("the register intent matches no registration state");
    }
    // Rule 6: activate, renew and ready name a registration.
    if (stamp === undefined) return unavailable("the intent's registration has no stamp");
    if (stamp.requestId !== intent.registrationRequestId)
      return status({ state: "superseded", registrationRequestId: intent.registrationRequestId!, currentRegistrationRequestId: stamp.requestId });
    if (g.row.state === "frozen") return pending ? status({ state: "registering", operationId: pending.operationId, phase: "barrier" }) : unavailable("the gate is frozen without a pending registration");
    if (current !== undefined && serviceWitnessDigest(current) === intent.witnessDigest) return live(current);
    return unavailable("the intent's witness disagrees with the current stamp");
  }

  /** The callout's assignment: the current bound assignment the witness names, never a guess. */
  async function serviceBinding(w: ServiceRegistrationWitness): Promise<ServiceAssignmentBinding> {
    if (tripped !== undefined || closed) throw new EpEnvelopeError("unavailable", "the service host is fenced or closing");
    const b = await bindingOf(discoveryCtx("C-binding"), w.principal.owner, w.endpoint, w.instanceId);
    if (b.state !== "bound" || b.row.cancel !== null || !namesBinding(w, b.binding))
      throw new EpEnvelopeError("permission-denied", "the service witness names no current bound assignment");
    return { ...b.binding };
  }

  // ---- one owner's assignment state (read only) ---------------------------------------------------

  async function serviceState(o: string, e: string, i: string): Promise<ServiceAssignmentState> {
    if (tripped !== undefined || closed) return { state: "unavailable" };
    try {
      const ctx = discoveryCtx("state-read");
      const asg = await readAssignment(ctx, e, i);
      if (asg.state === "absent" || asg.row.owner !== o) return { state: "absent" };
      const a = asg.row, ids = { proposalId: a.proposalId, assignmentDigest: a.assignmentDigest };
      if (a.state === "fenced") return { state: "revoking", ...ids, operationId: a.cancel.operationId, denyNew: "landed" };
      const gate = await endpoint(ctx, serviceAssignmentGate(discovery.host, a.reservation));
      if (a.cancel !== null) return { state: "revoking", ...ids, operationId: a.cancel.operationId, denyNew: denyNewOf(gate) };
      const approvalDigest = gate.kind === "approved" ? gate.row.serviceAuthority.approvalDigest : null;
      if (approvalDigest !== null && gate.kind === "approved")
        return { state: "approved", ...ids, approvalDigest, registrationRequestId: gate.row.serviceAuthority.registration?.requestId ?? null };
      if (gate.kind === "absent" || gate.kind === "pending") return { state: "pending-root", ...ids };
      // A revoked gate without a bound cancel identity, an approved gate without its digest, or another assignment's row.
      return { state: "unavailable" };
    } catch (err) { if (err instanceof Held || err instanceof EpEnvelopeError) return { state: "unavailable" }; throw err; }
  }

  // ---- dispatch -----------------------------------------------------------------------------------

  async function handle(raw: unknown): Promise<ServiceHostResult> {
    const req = parseServiceHostRequest(raw);
    const env = { v: 1 as const, kind: "service-endpoint-host" as const, operation: req.operation, requestId: req.requestId, space, accountPublicKey };
    const out = (r: object) => ({ ...env, ...r }) as ServiceHostResult;
    // The latch comes before the ledger and every broker read. A request that could bind holds under its
    // operation coordinate, with no deny-new claim because no gate was read; a read never binds.
    const binds = req.operation === "decide" || req.operation === "revoke" || req.operation === "name-bind" || req.operation === "caller-grant" || req.operation === "caller-revoke";
    if (tripped !== undefined || closed) return out(binds ? unread(req.requestId, "readiness", "open", req.operation === "revoke" ? req.input.expectedAssignmentDigest : undefined) : denied("unavailable"));
    const authorized = req.granter.kind === "operator" || interactive(req.granter.owner);
    switch (req.operation) {
      case "decide": return out(await decide(req, authorized));
      case "revoke": return out(await revoke(req, authorized));
      case "name-bind": return out(await nameBind(req));
      case "operation-read": return out(authorized ? await operationRead(req) : denied("permission-denied"));
      case "proposal-read": return out(authorized ? await proposalRead(req) : denied("permission-denied"));
      case "caller-grant": return out(await callerGrant(req, authorized));
      case "caller-revoke": return out(await callerRevoke(req, authorized));
      case "caller-policy-read": return out(authorized ? await callerPolicyRead(req) : denied("permission-denied"));
      case "caller-policy-list": return out(authorized ? await callerPolicyList(req) : denied("permission-denied"));
      default: return out(denied("unsupported"));
    }
  }

  return Object.freeze({
    space, accountPublicKey,
    register: (raw: unknown) => tracked(register(raw)),
    handle: (raw: unknown) => tracked(handle(raw)),
    serviceState: (owner: string, endpoint: string, instanceId: string) => tracked(serviceState(owner, endpoint, instanceId)),
    serve: (request: ServiceServeRequest) => tracked(serve(request)),
    serveStatus: (query: ServiceStatusQuery) => tracked(serveStatus(query)),
    serviceBinding: (witness: ServiceRegistrationWitness) => tracked(serviceBinding(witness)),
    refuse() { closed = true; },
    async close() {
      closed = true;
      while (entered.size > 0) await Promise.allSettled([...entered]);
    },
    trip(reason: string) {
      if (tripped === undefined) tripped = reason;
      discovery.trip(tripped);
      for (const t of live) t(tripped);
    },
  });
}
