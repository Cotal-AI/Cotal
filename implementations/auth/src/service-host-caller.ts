/** The service host's caller policy: caller grants (G1-G6), caller revocation (K0-K3) and the policy
 *  reads. openServiceHostOperations builds them once over its closure. */
import { EpEnvelopeError, canonicalJson, contractDigest, endpointCapabilitiesWithin, parseEndpointCapabilities, serviceGateApprovalLive, type EpCapability, type ServicePrincipal } from "@cotal-ai/core";
import { callerParentRefs } from "./service-caller-ancestry.js";
import { findActorUnified } from "./ledger.js";
import { registryMaxPayload, registryServerId, registryStores } from "./lifecycle-registry.js";
import { genuinePlaneHold, readPlaneClaim } from "./plane-claim.js";
import { SERVICE_CALLER_PAYLOAD_KEY, parseServiceCallerPayloadRecord, serviceCallerPayloadCheck, serviceCallerWriteFits, type ServiceCallerPayloadLimits, type ServiceCallerPayloadRecord } from "./service-caller-payload.js";
import { callerAppendStep, callerBeginStep, callerCutoffStep, immutableGrantView, parseNativeServiceCallerPolicy, servicePolicyKey, type NativeServiceCallerPolicy } from "./service-caller-policy.js";
import { encodeRoundTrip } from "./service-custody-shapes.js";
import { serviceAssignmentGate } from "./service-custody.js";
import type { ServiceCallerGrant, ServiceCallerPolicyView, ServiceHostRequest, ServiceOperationRefusal, ServiceSelector } from "./service-host-contract.js";
import { Held, S1_REQUEST_TIMEOUT_MS, bounded, endpoint, held, leader, type Ctx } from "./service-write.js";
import { withStatus, parseServiceHostOperationRecord, parseServiceCallerIndexRecord, byEntry, parseServiceCutoffMarkerRecord, serviceMarkerCeilSeconds, SERVICE_CUTOFF_MARGIN_S, requestDigestOf, S3_MAX_CALLER_GRANTS_PER_INSTANCE, type Rec, type GrantBody, type CallerGrantPlan, type CallerRevokePlan, type GrantResult, type OpResult, type Final, type Progress, type OpLive, type Op, type CallerIndex, type CutoffMarker } from "./service-host-records.js";
import { S2A_OPERATION_TTL_MS, S2A_INVOCATION_MS, S2A_MAX_REDECIDE, opKey, callerIndexKey, cutoffKey, seconds, serviceHostOperationId, callerGrantId, type Read, read, readOp, readAssignment, readAdmission, put, nameOf, isFinal, updateOp, settle, outcomeOf, debtOf, type Arms, type Inv, denied, finalArm, type Live, badRequest } from "./service-host-kernel.js";
import type { ServiceHostOperationsOptions, ServiceHostScopeTarget } from "./service-host-ops.js";
import type { ServiceHostDecisionsDeps, serviceHostDecisions } from "./service-host-decisions.js";

/** What serviceHostCaller reads from the service host closure. Each is a closure constant
 *  bound once at construction, never reassigned, so a destructured copy is the same binding's value. */
export interface ServiceHostCallerDeps {
  space: string;
  accountPublicKey: string;
  opts: ServiceHostOperationsOptions;
  invoke: ServiceHostDecisionsDeps["invoke"];
  readCtx: ServiceHostDecisionsDeps["readCtx"];
  heldArm: ServiceHostDecisionsDeps["heldArm"];
  unread: ServiceHostDecisionsDeps["unread"];
  discoveryCtx: ServiceHostDecisionsDeps["discoveryCtx"];
  discoveryHeld: ServiceHostDecisionsDeps["discoveryHeld"];
  authorityCtx: ServiceHostDecisionsDeps["authorityCtx"];
  interactive: (o: string) => boolean;
  view: ReturnType<typeof serviceHostDecisions>["view"];
}

/** The caller policy over one service host's closure. Bodies read their deps by the closure's names. */
export function serviceHostCaller(deps: ServiceHostCallerDeps) {
  const { space, accountPublicKey, opts, invoke, readCtx, heldArm, unread, discoveryCtx, discoveryHeld, authorityCtx, interactive, view } = deps;

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
    if (check.holds && rec.state === "value" && rec.row.state === "asserted" && rec.row.broker) {
      const broker = rec.row.broker, proof = genuinePlaneHold(opts.hold);
      if (!proof || broker.serverId !== registryServerId(ctx.h.registry)) return false;
      const observed = await bounded(ctx, () => readPlaneClaim(registryStores(ctx.h.registry).authKv, space));
      if (!observed.ok || !observed.value || observed.value.state !== "held" || observed.value.claimId !== broker.claimId || observed.value.generation !== broker.claimGeneration) return false;
      const held = await bounded(ctx, () => proof.assertHeld("after"));
      if (!held.ok) return false;
    }
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

  /** caller-grant (G1-G6): an interactive owner grants a current exact-lifecycle grantee rights on
   *  its own approved instance, within the approval's ceiling and covering managed ancestry. A grant
   *  records policy only; the separately composed callout establishes effective authority. */
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
      if (row.kind === "interactive" && row.parent !== undefined) return out(denied("unsupported"));
      if (row.kind === "managed-agent" && row.parent === undefined) return out(denied("unsupported"));
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
      let parentRefs: ServiceCallerGrant["parentRefs"];
      try {
        parentRefs = await callerParentRefs({ space, ledgerDir: opts.ledgerDir, grantee, capabilities, service,
          readPolicy: async (p) => { const read = await readPolicy(ctx, p.lifecycleUid); if (read.state === "absent") return undefined;
            if (!boundTo(read.row, p)) throw new EpEnvelopeError("permission-denied", "parent policy has another exact principal"); return read.row; } });
      } catch (e) { if (e instanceof EpEnvelopeError) return out(denied("permission-denied")); throw e; }
      const policy = await readPolicy(ctx, grantee.lifecycleUid);
      if (policy.state === "value" && !boundTo(policy.row, grantee)) return out(denied("conflict"));
      if ((policy.state === "value" ? policy.revision : 0) !== expectedPolicyRevision) return out(denied("conflict"));
      const body: GrantBody = { grantId: callerGrantId(space, operationId), endpoint: service.endpoint, instanceId: service.instanceId,
        serviceApprovalDigest: service.approvalDigest, capabilities,
        source: { kind: "service-owner", owner: granterOwner, approvalDigest: service.approvalDigest, nameAuthorityRevision: gate.row.nameAuthorityRevision }, parentRefs };
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
      try {
        const refs = await callerParentRefs({ space, ledgerDir: opts.ledgerDir, grantee: p.grantee, capabilities: p.grant.capabilities, expectedRefs: p.grant.parentRefs,
          service: { endpoint: p.grant.endpoint, instanceId: p.grant.instanceId, approvalDigest: p.approvalDigest },
          readPolicy: async (parent) => { const read = await readPolicy(ctx, parent.lifecycleUid); if (read.state === "absent") return undefined;
            if (!boundTo(read.row, parent)) throw new EpEnvelopeError("permission-denied", "parent policy binding changed"); return read.row; } });
        if (canonicalJson(refs) !== canonicalJson(p.grant.parentRefs)) return refuse("revoked");
      } catch (e) { if (e instanceof EpEnvelopeError) return refuse("revoked"); throw e; }
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

  return { callerGrant, callerRevoke, callerPolicyRead, callerPolicyList };
}
