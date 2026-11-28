/** The service host's decisions: the shared proposal closes, decide (approve and refuse, A1-A5) and
 *  revoke (V0-V5). openServiceHostOperations builds them once over its closure. */
import { EpEnvelopeError, SERVICE_ACCESS_TTL_SECONDS, mintLifecycleUid, parseEndpointCapabilities, principalKey, serviceEndpointActor, type EvictionResult, type ServiceUidCustodyV1 } from "@cotal-ai/core";
import { DELIVERY_ADMIN_REQUEST_TIMEOUT_MS } from "./delivery-admin.js";
import { approvedServiceGateRow, assertApprovableServiceGate } from "./native-service-gate.js";
import { cancelServiceCustody, runServiceBootstrap, sealServiceBootstrapIntent, sealServiceCancelIntent, serviceAssignmentGate, type ServiceCancelResult } from "./service-custody.js";
import type { ServiceApprovalResult, ServiceDenyNew, ServiceHostDebt, ServiceHostOutcome, ServiceHostRequest, ServiceOperationRefusal, ServiceProposalCloseReason, ServiceProposalTombstoneView } from "./service-host-contract.js";
import { readRegistryServiceRoot } from "./service-root-reader.js";
import { Held, S1_REQUEST_TIMEOUT_MS, bounded, endpoint, held, message, readyAfter, readyBefore, write, type Ctx, type EndpointClass } from "./service-write.js";
import { ceilingEntryAdmitted, parseServiceHostOperationRecord, parseServiceProposalRecord, parseServiceAssignmentRecord, enc, requestDigestOf, serviceMarkerCeilSeconds, type ApprovePlan, type RefusePlan, type RefuseResult, type Final, type OpLive, type Op, type ProposalLive, type ProposalTerminal, type Proposal, type Cancel, type Assignment } from "./service-host-records.js";
import { S2A_OPERATION_TTL_MS, S2A_MAX_REDECIDE, opKey, proposalKey, assignmentKey, seconds, serviceHostOperationId, expiryOperationId, expiryRequestDigest, approvalDigestOf, type Read, readOp, readProposal, readCapacity, readAssignment, readAdmission, put, isEntry, eligible, nameOf, release, isFinal, sameDebt, updateOp, settle, outcomeOf, debtOf, retryDebt, type Arms, type Inv, denied, finalArm, type Live } from "./service-host-kernel.js";
import type { ServiceHostScopeTarget } from "./service-host-ops.js";
import { CLOCK_TOLERANCE_SEC } from "./token.js";

/** Whole-second rounding margin beyond `ceil(T)`: `admittedAt`, NATS JWT `exp` and
 *  `seconds(Date.now())` are floored whole seconds, so 1 s ensures the entire `exp` second has
 *  elapsed even when `T` carries no fractional second (`ceil(T) === T`). */
export const SERVICE_EVICTION_HOLD_ROUNDING_S = 1;

/** Seconds past `ceil(T)` (from the terminal `revoked` endpoint gate's stored broker timestamp
 *  `T`) after which no serving connection admitted before deny-new can remain live: the serving
 *  credential's maximum lifetime (`SERVICE_ACCESS_TTL_SECONDS`), two-sided clock tolerance
 *  (`2 * CLOCK_TOLERANCE_SEC`), and {@link SERVICE_EVICTION_HOLD_ROUNDING_S}. */
export const SERVICE_EVICTION_HOLD_MARGIN_S = SERVICE_ACCESS_TTL_SECONDS + 2 * CLOCK_TOLERANCE_SEC + SERVICE_EVICTION_HOLD_ROUNDING_S;

/** Outer `V5-evict` budget: the inner `DELIVERY_ADMIN_REQUEST_TIMEOUT_MS` (15 s) delivery-admin
 *  request plus one `S1_REQUEST_TIMEOUT_MS` (5 s) allowance for `withDeliveryAdminEndpoint`
 *  connect and stop, clipped to the remaining invocation deadline by `bounded()`. */
export const SERVICE_EVICTION_BOUNDED_TIMEOUT_MS = DELIVERY_ADMIN_REQUEST_TIMEOUT_MS + S1_REQUEST_TIMEOUT_MS;

/** What serviceHostDecisions reads from the service host closure. Each is a closure constant
 *  bound once at construction, never reassigned, so a destructured copy is the same binding's value. */
export interface ServiceHostDecisionsDeps {
  space: string;
  accountPublicKey: string;
  invoke: <T>(target: ServiceHostScopeTarget, run: (inv: Inv) => Promise<T>, deadlineMs?: number) => Promise<T>;
  readCtx: (inv: Inv, step: string) => Ctx;
  heldArm: (inv: Inv, e: Held) => Arms;
  unread: (requestId: string, reason: string, phase: string, assignmentDigest?: string) => Arms;
  discoveryCtx: (step: string) => Ctx;
  discoveryHeld: (operationId: string, requestDigest: string, found: Read<Op> | undefined, e: Held, assignmentDigest?: string) => Arms;
  authorityCtx: (inv: Inv, notAfterMs: number, step: string) => Ctx;
  coverCustody: (inv: Inv, ctx: Ctx, reservation: ServiceUidCustodyV1, run: "bootstrap" | "cancel") => void;
  /** Verified-gone connection eviction for a revoked assignment's serving principal; when omitted,
   *  V5 eviction is skipped and `cancelled-nonterminal` is confirmed from deny-new alone. */
  evictPrincipal?: (principal: string) => Promise<EvictionResult>;
}

/** V5: once deny-new has landed, evict any open serving connection for the assignment's
 *  principal until it is verified gone before cancellation reports nonterminal completion. A
 *  serving connection cannot outlive its `SERVICE_ACCESS_TTL_SECONDS` credential and none is
 *  minted after deny-new lands, so once `SERVICE_EVICTION_HOLD_MARGIN_S` past `ceil(T)` from the
 *  revoked endpoint gate's stored broker timestamp `T` has elapsed, a replay completes without
 *  an eviction answer. */
async function verifyAssignmentEvicted(
  ctx: Ctx, operationId: string, assignmentDigest: string, owed: ServiceHostDebt[],
  asg: Extract<Assignment, { state: "bound" }>, gate: EndpointClass | undefined,
  evictPrincipal: ServiceHostDecisionsDeps["evictPrincipal"],
): Promise<Arms | undefined> {
  if (evictPrincipal === undefined) return undefined;
  const deniedAt = gate?.kind === "revoked" ? serviceMarkerCeilSeconds(gate.timestamp) : undefined;
  const cutoffElapsed = () => deniedAt !== undefined && seconds(Date.now()) >= deniedAt + SERVICE_EVICTION_HOLD_MARGIN_S;
  if (cutoffElapsed()) return undefined;
  try {
    ctx.step = "V5-evict";
    await readyBefore(ctx);
    const principal = principalKey(asg.owner, serviceEndpointActor({ accountPublicKey: ctx.h.accountPublicKey, space: ctx.h.space, owner: asg.owner, endpoint: asg.endpoint, instanceId: asg.instanceId })).key;
    const r = await bounded(ctx, () => evictPrincipal(principal), SERVICE_EVICTION_BOUNDED_TIMEOUT_MS);
    await readyAfter(ctx);
    if (r.ok && r.value.principal === principal && r.value.verifiedGone && r.value.scanComplete && r.value.remaining === 0) return undefined;
    if (cutoffElapsed()) return undefined;
    if (!r.ok) held("eviction-unverified", ctx.step, "timedOut" in r ? "endpoint connection eviction timed out" : message(r.error));
    held("eviction-unverified", ctx.step, r.value.note ?? "endpoint connection eviction could not be verified");
  } catch (err) {
    if (!(err instanceof Held)) throw err;
    const reason = err.reason === "deadline" ? "reconcile-pending" : err.reason;
    return { state: "held", operationId, reason, phase: err.step, assignmentDigest, denyNew: "landed", ...(owed.length ? { debt: owed } : {}) };
  }
}

/** The decisions over one service host's closure. Bodies read their deps by the closure's names. */
export function serviceHostDecisions(deps: ServiceHostDecisionsDeps) {
  const { space, accountPublicKey, invoke, readCtx, heldArm, unread, discoveryCtx, discoveryHeld, authorityCtx, coverCustody, evictPrincipal } = deps;

  // ---- shared closes ------------------------------------------------------------------------------

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
          const evictHeld = await verifyAssignmentEvicted(ctx, operationId, a, owed, row, run.gate, evictPrincipal);
          if (evictHeld !== undefined) return evictHeld;
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

  return { decide, revoke, denyNewOf, view };
}
