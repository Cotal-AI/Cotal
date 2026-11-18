/** Closed service host record grammar and immutable bounds. Internal to the auth package. */
import { assertBoundedOwner, assertDerivedOwnerToken, assertLifecycleToken, canonicalJson, contractDigest, endpointToken, isContractDigest, parseEndpointCapabilities, parseNativeUidCustody, type EpCapability, type EpCommandAuthority, type ServicePrincipal, type ServiceUidCustodyV1 } from "@cotal-ai/core";
import { parseServiceCallerGrant } from "./service-caller-policy.js";
import { parseServiceHostRequest, parseServiceProposalClusters, parseServiceProposalCommands, type ServiceApprovalResult, type ServiceCallerGrant, type ServiceHostDebt, type ServiceHostGranter, type ServiceHostInputs, type ServiceOperationKind, type ServiceOperationProjection, type ServiceOperationRefusal, type ServiceProposalCloseReason, type ServiceProposalTombstoneView } from "./service-host-contract.js";
import { message } from "./service-write.js";

const S2A_MAX_PENDING = 256;

const S2A_MAX_PENDING_PER_OWNER = 32;

/** Serving request intents one instance keeps (SPEC 13.1): never pruned or reused in this cut. */
export const S3_MAX_INTENTS_PER_INSTANCE = 64;

/** Index entries one service instance may ever hold: every caller grant written for it, active,
 *  revoking or orphaned by a grant attempt refused after its index write. Nothing is pruned. */
const S3_MAX_CALLER_GRANTS_PER_INSTANCE = 256;

const enc = new TextEncoder();

const requestDigestOf = (r: { v: 1; kind: string; requestId: string; operation: string; input: unknown; granter: unknown }) =>
  contractDigest({ v: r.v, kind: r.kind, requestId: r.requestId, operation: r.operation, input: r.input, granter: r.granter });


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
      if (src.kind !== "service-owner" || src.approvalDigest !== p.approvalDigest || src.nameAuthorityRevision !== p.nameAuthorityRevision
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

function parseServiceCallerIndexRecord(raw: unknown): CallerIndex {
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

function parseServiceCutoffMarkerRecord(raw: unknown): CutoffMarker {
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
const SERVICE_CUTOFF_MARGIN_S = 71;

export { bad, closed, hexN, digest, pick, owner, endpointName, token, ceilingEntryAdmitted, withStatus, parseServiceCallerIndexRecord, byEntry, parseServiceCutoffMarkerRecord, SERVICE_CUTOFF_MARGIN_S, enc, requestDigestOf, S2A_MAX_PENDING, S2A_MAX_PENDING_PER_OWNER, S3_MAX_CALLER_GRANTS_PER_INSTANCE };
export type { Rec, RegisterPlan, ApprovePlan, RefusePlan, GrantBody, CallerGrantPlan, CallerRevokePlan, RegisterResult, RefuseResult, GrantResult, OpResult, Final, Progress, OpLive, OpTerminal, Op, Command, ProposalLive, ProposalTerminal, Proposal, CapEntry, Capacity, Cancel, Assignment, Admission, Intent, IntentIndex, CallerIndex, CutoffMarker };
