/** Package-internal DORMANT service host operations: register admission, decide (approve or
 * refuse), revoke, and the operation and proposal reads, over closed per-key records in the auth
 * bucket. Nothing in the product calls it and the index does not export it. It grants no serving,
 * registration, caller policy, restore, terminal retirement or KICK.
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
  EpEnvelopeError, assertDerivedOwnerToken, assertLifecycleToken, canonicalJson, contractDigest, endpointToken,
  isContractDigest, mintLifecycleUid, parseEndpointCapabilities, parseNativeUidCustody, serviceEndpointActor,
  type EpCapability, type EpCommandAuthority, type ServiceUidCustodyV1,
} from "@cotal-ai/core";
import { SERVICE_HOST_INVOCATION_MS, openAuthorityClient, serviceHostEffectGrants, serviceHostEffectLabel } from "./authority-client.js";
import { findInteractiveActor } from "./ledger.js";
import { openLifecycleRegistry, type LifecycleRegistry } from "./lifecycle-registry.js";
import { approvedServiceGateRow, assertApprovableServiceGate, type ServiceAssignmentBinding, type ServiceGateRows } from "./native-service-gate.js";
import { readNativeServiceName } from "./native-service-name.js";
import type { PlaneClaimHold } from "./plane-claim.js";
import { encodeRoundTrip } from "./service-custody-shapes.js";
import {
  cancelServiceCustody, runServiceBootstrap, sealServiceBootstrapIntent, sealServiceCancelIntent, serviceAssignmentGate,
  serviceCustodyKeys, serviceReservationKeys, type ServiceCancelResult,
} from "./service-custody.js";
import {
  parseServiceHostRequest, parseServiceProposalClusters, parseServiceProposalCommands,
  type ServiceApprovalResult, type ServiceDenyNew, type ServiceHostDebt, type ServiceHostGranter, type ServiceHostOutcome,
  type ServiceHostReason, type ServiceHostRequest, type ServiceHostResult, type ServiceNameView, type ServiceOperationKind,
  type ServiceOperationProjection, type ServiceOperationRefusal, type ServiceOperationTerminalView, type ServiceOperationView,
  type ServiceProposalCloseReason, type ServiceProposalTombstoneView, type ServiceProposalView,
} from "./service-host-contract.js";
import { readRegistryServiceRoot } from "./service-root-reader.js";
import {
  HOSTS, Held, bounded, context, endpoint, held, leader, message, openServiceCustodyHost, scopeCovers, write,
  type Ctx, type EndpointClass, type HostInternals, type ServiceCustodyHost, type ServiceWriteScope,
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

const ADMISSION_KEY = "svchost.admission";
const CAPACITY_KEY = "svccap.space";
const opKey = (operationId: string) => `svcop.${operationId}`;
const proposalKey = (proposalId: string) => `svcprop.${proposalId}`;
const assignmentKey = (endpoint: string, instanceId: string) => `svcasg.${endpointToken(endpoint)}.${assertLifecycleToken(instanceId, "instanceId")}`;
const enc = new TextEncoder();
const seconds = (ms: number) => Math.floor(ms / 1000);

// ---- identities ---------------------------------------------------------------------------------

const hex32 = (tag: string, space: string, value: string) => createHash("sha256").update(`${tag}\0${space}\0${value}`, "utf8").digest("hex").slice(0, 32);
/** One id namespace for every host request in a space; a valid lifecycle token. */
export const serviceHostOperationId = (space: string, requestId: string) => hex32("cotal-service-host-op", space, requestId);
/** The native cancel identity an expiry settlement derives from recorded facts only. */
const expiryOperationId = (space: string, approveOperationId: string) => hex32("cotal-service-host-expiry", space, approveOperationId);
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
type Plan = RegisterPlan | ApprovePlan | RefusePlan | RevokePlan;
type RegisterResult = { proposalId: string; revision: number; expiresAtMs: number };
type RefuseResult = { proposal: ServiceProposalTombstoneView; revision: number };
type OpResult = RegisterResult | ServiceApprovalResult | RefuseResult;
type Final = { state: "complete"; result: OpResult } | { state: "refused"; reason: ServiceOperationRefusal } | { state: "superseded"; boundOperationId: string };
type Progress = { state: "admitted" } | { state: "custody"; step: string } | { state: "held"; reason: string; phase: string } | Final;
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
    operation: pick(x.operation, ["register", "decide", "revoke"] as const), account: account(x.account), granter: granter(x.granter), admittedAtMs: ms(x.admittedAtMs), projection: projection(x.projection) });
  if (o?.kind === "service-host-operation") {
    closed(raw, ["v", "kind", "operationId", "requestId", "requestDigest", "operation", "account", "granter", "admittedAtMs", "notAfterMs", "admissionEpoch", "projection", "plan", "progress", "debt"]);
    if (o.v !== 1) bad("unknown version");
    const c = common(o), p = plan(o.plan);
    if ((c.operation === "register") !== (p.kind === "register") || (c.operation === "revoke") !== (p.kind === "revoke")) bad("plan does not match its operation");
    const g = o.progress as Rec;
    let progress: Progress;
    if (g?.state === "admitted") { closed(g, ["state"]); progress = { state: "admitted" }; }
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
export function parseServiceAdmissionRecord(raw: unknown): Admission {
  const o = closed(raw, ["v", "kind", "state", "epoch", "restoreId"]);
  if (o.v !== 1 || o.kind !== "service-host-admission") bad("unknown version or kind");
  const epoch = ms(o.epoch);
  if (epoch < 1) bad("admission epochs start at 1");
  return { v: 1, kind: "service-host-admission", state: pick(o.state, ["open", "quarantined"] as const), epoch, restoreId: o.restoreId === null ? null : hexN(o.restoreId, 32) };
}

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
  operation: "startup" | "register" | "decide" | "revoke";
  operationId: string | null;
  proposalId: string | null;
  owner: string | null;
  endpoint: string | null;
  instanceId: string | null;
  lifecycleUid: string | null;
}
/** One invocation's scope: its target, the exact keys it may write and its original deadline. The
 *  engine guards every write with `keys` and never starts a request at or past `deadlineMs`, so an
 *  effect credential granted from the same keys and expiring from the same deadline cannot differ
 *  from it. */
export interface ServiceHostEffectScope extends ServiceHostScopeTarget { readonly keys: ServiceWriteScope; readonly deadlineMs: number }

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
  }
  const uniq = (a: string[]) => Object.freeze([...new Set(a)]);
  return Object.freeze({ records: uniq(records), auth: uniq(auth), authFamilies: uniq(authFamilies) });
}
const NO_WRITES: ServiceWriteScope = Object.freeze({ records: Object.freeze([]), auth: Object.freeze([]), authFamilies: Object.freeze([]) });
/** One per-invocation effect connection's registry. `gone` resolves when the connection is gone for
 *  good, which fences the invocation. `close` runs only after every awaited call returned. */
export interface ServiceHostEffect { registry: LifecycleRegistry; gone: Promise<void>; close(): Promise<void> }

/** Open one invocation's effect connection: a fresh identity whose credential publishes exactly
 *  `scope.keys`, never reconnects or renews, and expires at `scope.deadlineMs` rounded up to the
 *  whole second. The registry over it is the effect registry. */
export async function openServiceHostEffect(
  opts: { server: string; space: string; dataAccount: { pub: string; signingSeed: string }; log: (line: string) => void; onConnection?: (nc: NatsConnection, label: string) => void },
  scope: Pick<ServiceHostEffectScope, "keys" | "deadlineMs">,
): Promise<ServiceHostEffect> {
  const client = await openAuthorityClient({
    server: opts.server, space: opts.space, dataAccount: opts.dataAccount, log: opts.log, label: serviceHostEffectLabel(opts.space),
    grants: (connId) => serviceHostEffectGrants(opts.space, connId, scope.keys), noReconnect: true, serviceHostInvocation: { deadlineMs: scope.deadlineMs },
    ...(opts.onConnection ? { onConnection: opts.onConnection } : {}),
  });
  try { return { registry: await openLifecycleRegistry(client.nc, opts.space), gone: client.gone!, close: () => client.close() }; }
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
}
export interface ServiceRegisterRequest {
  v: 1; kind: "service-endpoint-host"; requestId: string; operation: "register";
  input: { owner: string; endpoint: string; instanceId: string; clusterDigests: string[]; commands: Command[] };
  granter: { kind: "owner"; owner: string };
}
export type ServiceRegisterResult = { v: 1; kind: "service-endpoint-host"; operation: "register"; requestId: string; space: string; accountPublicKey: string } & (
  | { state: "registered"; outcome: ServiceHostOutcome; operationId: string; proposalId: string; revision: number; expiresAtMs: number; debt?: ServiceHostDebt[] }
  | Arms);
type Arms =
  | { state: "pending"; operationId: string; phase: string; assignmentDigest?: string; denyNew?: ServiceDenyNew; root?: "none" | "revoked" | "retained-stamped"; debt?: ServiceHostDebt[] }
  | { state: "held"; operationId: string; reason: string; phase: string; assignmentDigest?: string; denyNew?: ServiceDenyNew; debt?: ServiceHostDebt[] }
  | { state: "refused"; operationId: string; reason: ServiceOperationRefusal; boundOperationId?: string; debt?: ServiceHostDebt[] }
  | { state: "denied"; reason: ServiceHostReason; boundOperationId?: string };
export interface ServiceHostOperations {
  readonly space: string;
  readonly accountPublicKey: string;
  /** Internal register admission; the public register route that verifies the owner calls it. */
  register(raw: unknown): Promise<ServiceRegisterResult>;
  /** decide, revoke, operation-read and proposal-read; every other operation is `unsupported`. */
  handle(raw: unknown): Promise<ServiceHostResult>;
  /** The engine-level fatal latch: refuses new invocations and trips every live invocation host. */
  trip(reason: string): void;
}

interface Inv { host: ServiceCustodyHost; h: HostInternals; writes: ServiceWriteScope; endMs: number; operationId: string; bound: boolean; assignmentDigest?: string }
const denied = (reason: ServiceHostReason, boundOperationId?: string): Arms => ({ state: "denied", reason, ...(boundOperationId ? { boundOperationId } : {}) });
const refusedArm = (operationId: string, reason: ServiceOperationRefusal, debts: ServiceHostDebt[], boundOperationId?: string): Arms =>
  ({ state: "refused", operationId, reason, ...(boundOperationId ? { boundOperationId } : {}), ...(debts.length ? { debt: debts } : {}) });
const finalArm = (operationId: string, f: Exclude<Final, { state: "complete" }>, debts: ServiceHostDebt[]): Arms =>
  f.state === "refused" ? refusedArm(operationId, f.reason, debts) : refusedArm(operationId, "superseded", debts, f.boundOperationId);

function badRequest(detail: string): never { throw new EpEnvelopeError("bad-request", `service host request: ${detail}`); }

/** Structural admission of the internal register request. */
export function parseServiceRegisterRequest(raw: unknown): ServiceRegisterRequest {
  let o: Rec, input: Rec, g: Rec;
  try {
    o = closed(raw, ["v", "kind", "requestId", "operation", "input", "granter"]);
    if (o.v !== 1 || o.kind !== "service-endpoint-host" || o.operation !== "register") bad("unknown version, kind or operation");
    hexN(o.requestId, 32);
    g = closed(o.granter, ["kind", "owner"]); pick(g.kind, ["owner"]); owner(g.owner);
    input = closed(o.input, ["owner", "endpoint", "instanceId", "clusterDigests", "commands"]);
    owner(input.owner); endpointName(input.endpoint); token(input.instanceId, "instanceId");
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
  let tripped: string | undefined;
  const discoveryCtx = (step: string) => { const c = context(HOSTS.get(discovery.host)!, Date.now() + S2A_INVOCATION_MS); c.step = step; return c; };

  /** One invocation: an effect connection for the discovered scope and its original deadline, one
   *  custody host over it sharing the process hold and writing only the scope's keys, and the
   *  engine latch. The connection's loss trips the host. Every awaited call returns before close. */
  async function invoke<T>(target: ServiceHostScopeTarget, run: (inv: Inv) => Promise<T>): Promise<T> {
    if (tripped !== undefined) throw new Held("readiness", "open", `the service host is fenced: ${tripped}`);
    const keys = serviceHostScopeKeys({ accountPublicKey, space }, target);
    const deadlineMs = Date.now() + S2A_INVOCATION_MS;
    const scope: ServiceHostEffectScope = Object.freeze({ ...target, keys, deadlineMs });
    let effect: ServiceHostEffect;
    try { effect = await opts.openEffect(scope); }
    catch (e) { throw new Held("unavailable", "effect-open", `the invocation's effect connection did not open: ${message(e)}`); }
    try {
      const { host, trip } = openServiceCustodyHost({ registry: effect.registry, hold: opts.hold, accountPublicKey, writes: keys });
      if (host.space !== space) throw new EpEnvelopeError("permission-denied", "the effect registry belongs to another space");
      live.add(trip);
      if (tripped !== undefined) trip(tripped);
      // Attached before the first request: a write issued after the loss holds, one in flight across it reports held.
      void effect.gone.then(() => trip("the invocation's effect connection is gone"));
      const h = HOSTS.get(host)!;
      try { return await run({ host, h, writes: h.writes!, endMs: deadlineMs, operationId: target.operationId ?? "", bound: true }); }
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

  type Selector = { owner: string; endpoint: string; instanceId: string };
  type Registered = { state: "registered"; outcome: ServiceHostOutcome; operationId: string; proposalId: string; revision: number; expiresAtMs: number; debt?: ServiceHostDebt[] };
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
    if (tripped !== undefined) return out(unread(req.requestId, "readiness", "open"));
    const { owner: o, endpoint: e, instanceId: i, clusterDigests, commands } = req.input;
    if (req.granter.owner !== o) return out(denied("permission-denied"));                                   // never binds
    // Authorization precedes every request-key read, and its refusal is one answer whether or not the request is bound.
    if (!interactive(o)) return out(unread(req.requestId, "permission-denied", "authorize"));
    const operationId = serviceHostOperationId(space, req.requestId), requestDigest = requestDigestOf(req);
    const proposalDigest = contractDigest({ v: 1, kind: "service-proposal-body", accountPublicKey, space, owner: o, endpoint: e, instanceId: i, clusterDigests, commands });
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
      const registered = (r: RegisterResult, outcome: ServiceHostOutcome, debts: ServiceHostDebt[] = []): Registered => ({ state: "registered", outcome, operationId, ...r, ...(debts.length ? { debt: debts } : {}) });
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

  /** Deny-new from one read of this assignment's endpoint gate, on every revoke path. Another
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
      if (ceiling.some((c) => c.endpoint !== p.endpoint || !p.commands.some((k) => k.name === c.command) || (c.instanceId !== undefined && c.instanceId !== p.instanceId)))
        return out(denied("bad-request"));
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
      const g2 = o.progress;
      const progress: ServiceOperationView["progress"] = g2.state === "admitted" ? { state: "pending", phase: "admitted" } : g2.state === "custody" ? { state: "pending", phase: g2.step }
        : g2.state === "held" ? { state: "held", reason: g2.reason, phase: g2.phase } : finalView(g2);
      return { state: "present", record: { value: { operationId: o.operationId, requestDigest: o.requestDigest, operation: o.operation,
        target: { kind: "service", endpoint: o.projection.endpoint, instanceId: o.projection.instanceId, assignmentDigest }, projection, progress, debt: o.debt.map((d) => ({ ...d })) }, revision: op.revision } };
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

  // ---- dispatch -----------------------------------------------------------------------------------

  async function handle(raw: unknown): Promise<ServiceHostResult> {
    const req = parseServiceHostRequest(raw);
    const env = { v: 1 as const, kind: "service-endpoint-host" as const, operation: req.operation, requestId: req.requestId, space, accountPublicKey };
    const out = (r: object) => ({ ...env, ...r }) as ServiceHostResult;
    // The latch comes before the ledger and every broker read. A request that could bind holds under its
    // operation coordinate, with no deny-new claim because no gate was read; a read never binds.
    if (tripped !== undefined) return out(req.operation === "decide" || req.operation === "revoke"
      ? unread(req.requestId, "readiness", "open", req.operation === "revoke" ? req.input.expectedAssignmentDigest : undefined) : denied("unavailable"));
    const authorized = req.granter.kind === "operator" || interactive(req.granter.owner);
    switch (req.operation) {
      case "decide": return out(await decide(req, authorized));
      case "revoke": return out(await revoke(req, authorized));
      case "operation-read": return out(authorized ? await operationRead(req) : denied("permission-denied"));
      case "proposal-read": return out(authorized ? await proposalRead(req) : denied("permission-denied"));
      default: return out(denied("unsupported"));
    }
  }

  return Object.freeze({
    space, accountPublicKey, register, handle,
    trip(reason: string) {
      if (tripped === undefined) tripped = reason;
      discovery.trip(tripped);
      for (const t of live) t(tripped);
    },
  });
}
