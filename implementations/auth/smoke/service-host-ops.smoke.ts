/** Owned-broker suite for the dormant service host operations. Every section runs a real
 * nats-server process through the custody fixture (its genuine plane-claim hold, account, service
 * name and fault hooks), in operator mode: discovery reads over the product discovery grant, which
 * publishes nothing, and each invocation's effect connection is the product effect credential,
 * which may publish exactly its scope's keys until its original deadline, so a write outside an
 * invocation's scope would be refused by the broker as well as by the engine. The broker confines
 * publish subjects only, not what a publish on a granted subject does; this suite shows only the
 * engine's own creates and CASes. Records a test writes directly are labelled as simulations; nothing here is
 * native, Cloud or production acceptance, and nothing proves a human decision. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import {
  VOID_SCHEMA_DIGEST, canonicalJson, contractDigest, contractRefToHex, contractStoreContext, endpointToken, epAuthBucket, epgateKey, fetchContractArtifact,
  lifecycleHeadKey, recordsBucket, serviceEndpointActor, serviceWitnessDigest, singleDocumentClosure, uidReservationKey,
  type ServiceRegistrationWitness, type ServiceUidCustodyV1,
} from "@cotal-ai/core";
import { grantActor, revokeActor } from "../src/ledger.js";
import { registryStores } from "../src/lifecycle-registry.js";
import {
  cancelServiceCustody, openServiceCustodyHost, runServiceBootstrap, sealServiceBootstrapIntent, sealServiceCancelIntent, serviceCustodyKeys,
} from "../src/service-custody.js";
import { compileServiceRegistration, serviceAuthorityEngineRequestId } from "../src/service-endpoint-authority.js";
import { parseServiceHostResult, type ServiceApprovalResult } from "../src/service-host-contract.js";
import {
  S2A_INVOCATION_MS, S3_MAX_INTENTS_PER_INSTANCE, openServiceHostOperations, parseServiceAdmissionRecord, parseServiceAssignmentRecord,
  parseServiceCapacityRecord, parseServiceHostOperationRecord, parseServiceProposalRecord, parseServiceRequestIntentIndexRecord, serviceHostOperationId,
  serviceRegisterHostRequest, type ServiceHostOperations, type ServiceHostOperationsOptions, type ServiceServeOperation, type ServiceServeRequest,
} from "../src/service-host-ops.js";
import { bytesOf, checks, openFixture, type Fixture, type WriteCall } from "./_service-custody-fixture.js";

const c = checks();
const rid = () => randomBytes(16).toString("hex");
const D = (s: string) => contractDigest({ fixture: s });
const command = { name: "lookup", clusterDigest: D("cluster"), class: "ephemeral", targeted: false, modes: [], capability: "read", inputDigest: D("in"), outputDigest: D("out"), traits: [] };
const other = `u_${"d".repeat(26)}`;
const ledgers: string[] = [];
const ledger = (...owners: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), "s2a-ledger-"));
  ledgers.push(dir);
  for (const o of owners) grantActor(dir, { owner: o, actor: "cli", scope: [], allowSubscribe: [], allowPublish: [] });
  return dir;
};

/** Every fixture of this suite is limited; the last check reads their broker refusals. */
const fixtures: Fixture[] = [];
const fixture = async (space: string) => { const f = await openFixture(space, { limited: true }); fixtures.push(f); return f; };
const discoveries = new WeakMap<Fixture, ReturnType<Fixture["discovery"]>>();
async function engine(f: Fixture, dir: string, over: Partial<ServiceHostOperationsOptions> = {}): Promise<ServiceHostOperations> {
  let d = discoveries.get(f);
  if (d === undefined) discoveries.set(f, d = f.discovery());
  return openServiceHostOperations({ discovery: (await d).registry, openEffect: (scope) => f.effect(scope.keys, scope.deadlineMs, undefined, scope.reads), hold: f.hold,
    accountPublicKey: f.accountPublicKey, ledgerDir: dir, startup: { kind: "normal" }, ...over });
}
const parsesClosed = (label: string, r: unknown) => {
  let ok = true, detail: unknown;
  try { parseServiceHostResult(r); } catch (e) { ok = false; detail = (e as Error).message; }
  c.check(`${label}: the result passes the closed result parser`, ok, detail);
};
const reg = (f: Fixture, o = f.owner, over: { instanceId?: string; requestId?: string; endpoint?: string } = {}) => ({
  v: 1, kind: "service-endpoint-host", requestId: over.requestId ?? rid(), operation: "register",
  input: { owner: o, endpoint: over.endpoint ?? f.endpoint, instanceId: over.instanceId ?? rid(), clusterDigests: [D("cluster")], commands: [command] },
  granter: { kind: "owner", owner: o },
});
const decide = (proposalId: string, rev: number, nameRev: number, decision: "approve" | "refuse", granter: object, requestId = rid()) => ({
  v: 1, kind: "service-endpoint-host", requestId, operation: "decide", granter,
  input: { proposalId, expectedProposalRevision: rev, expectedNameRevision: nameRev, decision, callerCeiling: [] },
});
const revoke = (endpoint: string, instanceId: string, digest: string, cause: string, granter: object, requestId = rid()) => ({
  v: 1, kind: "service-endpoint-host", requestId, operation: "revoke", granter, input: { endpoint, instanceId, expectedAssignmentDigest: digest, cause },
});
const ownerOf = (f: Fixture) => ({ kind: "owner", owner: f.owner });
const operator = { kind: "operator", auditId: "fixture-operator" };
const asg = (f: Fixture, instanceId: string) => `svcasg.${f.endpoint.replaceAll(".", "_")}.${instanceId}`;
/** decide has two `refused` arms: the decision's own completion and a bound operation's refusal. */
const refusal = (r: { state: string }) => (r.state === "refused" && "reason" in r ? (r as { reason: string }).reason : undefined);
const opRecord = (f: Fixture, requestId: string) => f.value(f.auth, `svcop.${serviceHostOperationId(f.space, requestId)}`);

/** A registered proposal plus its live revision. */
async function registered(f: Fixture, e: ServiceHostOperations, instanceId = rid()) {
  const r = await e.register(reg(f, f.owner, { instanceId }));
  if (r.state !== "registered") throw new Error(`fixture register failed: ${JSON.stringify(r)}`);
  return { ...r, instanceId };
}

// ---- A: register -------------------------------------------------------------------------------
{
  const f = await fixture("s2a-register");
  try {
    const dir = ledger(f.owner, other), e = await engine(f, dir);
    c.check("A0 normal startup creates admission open at epoch 1", JSON.stringify(await f.value(f.auth, "svchost.admission")) === JSON.stringify({ v: 1, kind: "service-host-admission", state: "open", epoch: 1, restoreId: null }));
    const req = reg(f), r1 = await e.register(req);
    c.check("A1 register admits a proposal (applied)", r1.state === "registered" && r1.outcome === "applied", r1);
    const pid = r1.state === "registered" ? r1.proposalId : "";
    const prop = await f.value(f.auth, `svcprop.${pid}`), cap = await f.value(f.auth, "svccap.space");
    c.check("A1 the proposal is live and proposed with the plan's lifetime", prop?.kind === "service-proposal" && (prop?.state as { state: string }).state === "proposed"
      && (prop!.expiresAtMs as number) - (prop!.createdAtMs as number) === 86_400_000, prop);
    c.check("A1 capacity holds exactly my entry", JSON.stringify((cap?.pending as unknown[]).map((x) => (x as { proposalId: string }).proposalId)) === JSON.stringify([pid]), cap);
    c.check("A1 the binding compacted to a terminal complete record", (await opRecord(f, req.requestId))?.kind === "service-host-operation-terminal");
    const r2 = await e.register(req);
    c.check("A2 a replay returns the stored result unchanged except recorded", r2.state === "registered" && r2.outcome === "recorded" && r1.state === "registered"
      && r2.proposalId === r1.proposalId && r2.revision === r1.revision && r2.expiresAtMs === r1.expiresAtMs, r2);
    const changed = { ...req, input: { ...req.input, instanceId: rid() } };
    const r3 = await e.register(changed);
    c.check("A3 (S-10) the same requestId with a changed body is a conflict", r3.state === "denied" && r3.reason === "conflict", r3);
    const sameSel = reg(f, f.owner, { instanceId: req.input.instanceId });
    const r4 = await e.register(sameSel);
    c.check("A4 (S-1) a second pending proposal for the selector is a zero-write denial", r4.state === "denied" && r4.reason === "selector-pending"
      && (await opRecord(f, sameSel.requestId)) === null, r4);
    const foreign = reg(f, other);
    const r5 = await e.register(foreign);
    c.check("A5 (S-9) a name bound to another owner refuses with no binding", r5.state === "denied" && r5.reason === "name-owned" && (await opRecord(f, foreign.requestId)) === null, r5);
    const r6 = await e.register({ ...reg(f), granter: { kind: "owner", owner: other } });
    c.check("A6 (S-30) a granter that is not the request's owner is denied", r6.state === "denied" && r6.reason === "permission-denied", r6);
    // Simulation: a capacity row written by the fixture with 32 eligible entries for the owner.
    const fill = (n: number, expiresAtMs: number, o = f.owner) => Array.from({ length: n }, (_, k) => ({ proposalId: k.toString(16).padStart(64, "0"), owner: o,
      endpoint: f.endpoint, instanceId: `fill${String(k).padStart(28, "0")}`, registerRequestId: "e".repeat(32), expiresAtMs }));
    const realCap = (await f.auth.get("svccap.space"))!;
    await f.auth.update("svccap.space", bytesOf({ v: 1, kind: "service-proposal-capacity", pending: fill(32, Date.now() + 3_600_000) }), realCap.revision);
    const full = reg(f);
    const r7 = await e.register(full);
    c.check("A7 (S-1, simulated row) 32 eligible entries for one owner refuse with zero writes", r7.state === "denied" && r7.reason === "resource-exhausted" && (await opRecord(f, full.requestId)) === null, r7);
    const capRev = (await f.auth.get("svccap.space"))!.revision;
    await f.auth.update("svccap.space", bytesOf({ v: 1, kind: "service-proposal-capacity", pending: fill(256, Date.now() - 1).map((x, k) => ({ ...x, owner: `u_${String.fromCharCode(97 + (k % 26)).repeat(26)}` })) }), capRev);
    const r8 = await e.register(reg(f));
    const pruned = await f.value(f.auth, "svccap.space");
    c.check("A8 (S-12, simulated row) an all-expired 256-entry row is pruned and admission proceeds", r8.state === "registered" && (pruned?.pending as unknown[]).length === 1, { r8, n: (pruned?.pending as unknown[])?.length });
    // A refusal at a re-decision is recorded: the fixture fills capacity right after the binding lands.
    const late = reg(f);
    const arm = f.faults.onWrite((w) => w.key === `svcop.${serviceHostOperationId(f.space, late.requestId)}` && w.kind === "create", { after: async () => {
      const cur = (await f.auth.get("svccap.space"))!;
      await f.auth.update("svccap.space", bytesOf({ v: 1, kind: "service-proposal-capacity", pending: fill(32, Date.now() + 3_600_000) }), cur.revision);
    } });
    const r9 = await e.register(late);
    const stored = await opRecord(f, late.requestId);
    c.check("A9 (S-1) a refusal at the re-decision is recorded refused{operationId} with no proposal", arm.hits === 1 && r9.state === "refused" && r9.reason === "resource-exhausted"
      && stored?.kind === "service-host-operation-terminal" && (stored?.outcome as { state: string }).state === "refused", { r9, stored });
    const r10 = await e.register(late);
    c.check("A10 that recorded refusal replays unchanged", r10.state === "refused" && r10.reason === "resource-exhausted", r10);
    for (const [label, r] of [["A1", r1], ["A3", r3], ["A9", r9]] as const) c.check(`${label}: the register result carries the envelope`, r.space === f.space && r.accountPublicKey === f.accountPublicKey);
  } finally { await f.close(); }
}

// ---- B: approve, replay, reads ------------------------------------------------------------------
{
  const f = await fixture("s2a-approve");
  try {
    const dir = ledger(f.owner, other), e = await engine(f, dir);
    const p = await registered(f, e);
    const nameRev = f.name.revision;
    const req = decide(p.proposalId, p.revision, nameRev, "approve", ownerOf(f));
    const r1 = await e.handle(req);
    parsesClosed("B1", r1);
    c.check("B1 approve completes (applied)", r1.state === "approved" && r1.outcome === "applied", r1);
    const approval = r1.state === "approved" ? r1.approval : undefined;
    const gate = approval ? await f.value(f.auth, epgateKey(f.endpoint, p.instanceId)) : null;
    const gateRev = await f.revision(f.auth, epgateKey(f.endpoint, p.instanceId));
    const sa = gate?.serviceAuthority as Record<string, unknown> | undefined;
    c.check("B1 the endpoint gate is approved with my approvalDigest and root", sa?.state === "approved" && sa?.approvalDigest === approval?.approvalDigest && sa?.rootCredentialId === approval?.rootCredentialId, sa);
    c.check("B1 approvedGateRevision is the revision my CAS wrote", approval?.approvedGateRevision === gateRev, { approval, gateRev });
    const tomb = await f.value(f.auth, `svcprop.${p.proposalId}`);
    c.check("B1 the proposal is a terminal approved tombstone naming my operation", tomb?.kind === "service-proposal-terminal" && tomb?.state === "approved"
      && tomb?.operationId === serviceHostOperationId(f.space, req.requestId) && tomb?.approvalDigest === approval?.approvalDigest, tomb);
    c.check("B1 the capacity entry is released", ((await f.value(f.auth, "svccap.space"))?.pending as unknown[]).length === 0);
    c.check("B1 the binding compacted to terminal", (await opRecord(f, req.requestId))?.kind === "service-host-operation-terminal");
    const r2 = await e.handle(req);
    c.check("B2 a replay returns the identical stored approval, recorded", r2.state === "approved" && r2.outcome === "recorded" && JSON.stringify(r2.approval) === JSON.stringify(approval), r2);
    let threw = false;
    try { await e.handle(decide(p.proposalId, p.revision, nameRev, "approve", operator)); } catch { threw = true; }
    c.check("B3 an operator approve is refused structurally (owner consent only)", threw);
    const p2 = await registered(f, e);
    const r4 = await e.handle(decide(p2.proposalId, p2.revision, nameRev, "approve", { kind: "owner", owner: other }));
    c.check("B4 (S-30) another owner's approve is denied before disclosure", r4.state === "denied" && r4.reason === "not-found", r4);
    const r5 = await e.handle(decide(p2.proposalId, p2.revision + 1, nameRev, "approve", ownerOf(f)));
    c.check("B5 a stale expected proposal revision is a zero-write conflict", r5.state === "denied" && r5.reason === "conflict", r5);
    // Revoke the approved assignment, then replay the approve: the historical result stands.
    const rv = await e.handle(revoke(f.endpoint, p.instanceId, approval!.assignment.assignmentDigest, "owner-request", ownerOf(f)));
    parsesClosed("B6", rv);
    c.check("B6 revoke of the approved assignment lands deny-new; S1 retains the stamped root (no terminal retirement)", rv.state === "pending" && rv.phase === "cancelled-nonterminal" && rv.denyNew === "landed" && rv.root === "retained-stamped", rv);
    const g2 = await f.value(f.auth, epgateKey(f.endpoint, p.instanceId));
    c.check("B6 the gate is revoked and keeps my approvalDigest", (g2?.serviceAuthority as Record<string, unknown>)?.state === "revoked"
      && (g2?.serviceAuthority as Record<string, unknown>)?.approvalDigest === approval?.approvalDigest);
    const r7 = await e.handle(req);
    c.check("B7 (S-32) after the revoke the approve replay returns the same historical result", r7.state === "approved" && JSON.stringify(r7.approval) === JSON.stringify(approval), r7);
    // Reads: owner via projection, another owner absent, operator space-wide; closed views.
    const opId = serviceHostOperationId(f.space, req.requestId);
    const read = (g: object, input: object, operation: string) => e.handle({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation, input, granter: g });
    const o1 = await read(ownerOf(f), { operationId: opId }, "operation-read"), o2 = await read({ kind: "owner", owner: other }, { operationId: opId }, "operation-read"), o3 = await read(operator, { operationId: opId }, "operation-read");
    parsesClosed("B8 owner operation-read", o1); parsesClosed("B8 operator operation-read", o3);
    c.check("B8 (S-15) operation-read: owner sees it, another owner gets absent, operator sees it", o1.state === "present" && o2.state === "absent" && o3.state === "present", { o1, o2, o3 });
    const q1 = await read(ownerOf(f), { proposalId: p.proposalId }, "proposal-read"), q2 = await read({ kind: "owner", owner: other }, { proposalId: p.proposalId }, "proposal-read");
    parsesClosed("B9 proposal-read tombstone", q1);
    c.check("B9 (S-15) proposal-read returns the closed tombstone view, without commands", q1.state === "present" && Object.hasOwn(q1.record.value, "register") && !Object.hasOwn(q1.record.value, "commands") && q2.state === "absent", q1);
    const q3 = await read(ownerOf(f), { proposalId: p2.proposalId }, "proposal-read");
    parsesClosed("B9 proposal-read live", q3);
    c.check("B9 a live proposal view carries its name binding and a null decision", q3.state === "present" && (q3.record.value as { decision: unknown }).decision === null
      && (q3.record.value as { nameBinding: { owner: string } | null }).nameBinding?.owner === f.owner, q3);
    const u = await e.handle({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "instance-read", input: { endpoint: f.endpoint, instanceId: p.instanceId }, granter: ownerOf(f) });
    c.check("B10 operations outside this slice are unsupported", u.state === "denied" && u.reason === "unsupported", u);
  } finally { await f.close(); }
}

// ---- C: revoke across partial approvals ---------------------------------------------------------
{
  const f = await fixture("s2a-revoke");
  try {
    const dir = ledger(f.owner);
    // S-22: the approver's latch trips when its assignment row lands (after A2, before B0).
    const e1 = await engine(f, dir), e2 = await engine(f, dir);
    const p = await registered(f, e2);
    const req = decide(p.proposalId, p.revision, f.name.revision, "approve", ownerOf(f));
    const sub = f.tripOnWrite("auth", asg(f, p.instanceId), 1, e1.trip);
    const a1 = await e1.handle(req);
    sub.unsubscribe();
    c.check("C1 (S-22) an approve fenced at A2 reports held under its operation", a1.state === "held" && a1.operationId === serviceHostOperationId(f.space, req.requestId), a1);
    const s0 = await lastSeqs(f), t1 = (await e1.handle(req)) as { state: string; reason?: string; phase?: string; operationId?: string; denyNew?: string }, s1 = await lastSeqs(f);
    // A tripped engine reads nothing, so a bound request holds under its operation coordinate.
    c.check("C1 the tripped engine refuses new invocations: the bound replay holds readiness under its operation, with no write", t1.state === "held"
      && t1.reason === "readiness" && t1.phase === "open" && t1.operationId === serviceHostOperationId(f.space, req.requestId) && t1.denyNew === undefined
      && s1.auth === s0.auth && s1.records === s0.records, t1);
    const digest = ((await f.value(f.auth, asg(f, p.instanceId)))?.assignmentDigest as string) ?? "";
    const rv = await e2.handle(revoke(f.endpoint, p.instanceId, digest, "owner-request", ownerOf(f)));
    parsesClosed("C1", rv);
    c.check("C1 (S-22) revoke reaches uid-unconfirmed with deny-new landed", rv.state === "pending" && rv.phase === "uid-unconfirmed" && rv.denyNew === "landed", rv);
    const tomb = await f.value(f.auth, `svcprop.${p.proposalId}`);
    c.check("C1 V4 closed the proposal refused{revoked} from the gate", tomb?.state === "refused" && tomb?.reason === "revoked", tomb);
    c.check("C1 capacity released", ((await f.value(f.auth, "svccap.space"))?.pending as unknown[]).length === 0);
    const a2 = await e2.handle(req);
    c.check("C1 the approve replay is refused{revoked}", refusal(a2) === "revoked", a2);

    // S-4: revoke between A1 and A2 creates the fence; the approver then takes R-fence.
    const e3 = await engine(f, dir), p2 = await registered(f, e2);
    const req2 = decide(p2.proposalId, p2.revision, f.name.revision, "approve", ownerOf(f));
    const sub2 = f.tripOnWrite("auth", `svcprop.${p2.proposalId}`, 1, e3.trip);
    const b1 = await e3.handle(req2);
    sub2.unsubscribe();
    const approving = await f.value(f.auth, `svcprop.${p2.proposalId}`);
    c.check("C2 (S-4) the approve stopped at A1 with the proposal approving", b1.state === "held" && (approving?.state as { state: string }).state === "approving", { b1, approving });
    const d2 = (approving?.state as { assignmentDigest: string }).assignmentDigest;
    const rv2 = await e2.handle(revoke(f.endpoint, p2.instanceId, d2, "operator-request", operator));
    c.check("C2 (S-4) revoke create-fences the absent assignment", rv2.state === "pending" && rv2.phase === "assignment-fenced" && (await f.value(f.auth, asg(f, p2.instanceId)))?.state === "fenced", rv2);
    const b2 = await e2.handle(req2);
    c.check("C2 the approve replay never approves: refused{revoked}", refusal(b2) === "revoked" && (await f.value(f.auth, epgateKey(f.endpoint, p2.instanceId))) === null, b2);

    // S-5: two concurrent revokes with different requests bind one cancel.
    const p3 = await registered(f, e2);
    const ok3 = await e2.handle(decide(p3.proposalId, p3.revision, f.name.revision, "approve", ownerOf(f)));
    const d3 = ok3.state === "approved" ? ok3.approval.assignment.assignmentDigest : "";
    const x = revoke(f.endpoint, p3.instanceId, d3, "owner-request", ownerOf(f)), y = revoke(f.endpoint, p3.instanceId, d3, "operator-request", operator);
    const [rx, ry] = await Promise.all([e2.handle(x), e2.handle(y)]);
    const cancel = (await f.value(f.auth, asg(f, p3.instanceId)))?.cancel as { operationId: string } | null;
    const ids = [serviceHostOperationId(f.space, x.requestId), serviceHostOperationId(f.space, y.requestId)];
    c.check("C3 (S-5) one svcasg.cancel, owned by one of the two revokes", cancel !== null && ids.includes(cancel.operationId), cancel);
    c.check("C3 (S-5) both revokes report pending deny-new landed", rx.state === "pending" && ry.state === "pending" && rx.denyNew === "landed" && ry.denyNew === "landed", { rx, ry });
    const bad1 = await e2.handle(revoke(f.endpoint, p3.instanceId, d3, "owner-request", operator));
    const bad2 = await e2.handle(revoke(f.endpoint, p3.instanceId, d3, "operator-request", ownerOf(f)));
    c.check("C4 causes follow the granter (owner-request only for owners)", bad1.state === "denied" && bad2.state === "denied");
    const bad3 = await e2.handle(revoke(f.endpoint, p3.instanceId, D("not-the-assignment"), "owner-request", ownerOf(f)));
    c.check("C5 an assignment digest that does not match is a zero-write conflict", bad3.state === "denied" && bad3.reason === "conflict", bad3);
  } finally { await f.close(); }
}

// ---- D: refuse ----------------------------------------------------------------------------------
{
  const f = await fixture("s2a-refuse");
  try {
    const dir = ledger(f.owner), e = await engine(f, dir), e2 = await engine(f, dir);
    const p = await registered(f, e);
    const r1 = await e.handle(decide(p.proposalId, p.revision, f.name.revision, "refuse", ownerOf(f)));
    parsesClosed("D1", r1);
    c.check("D1 an owner refuse closes the proposal refused{owner} (applied)", r1.state === "refused" && "proposal" in r1 && r1.proposal.reason === "owner" && r1.outcome === "applied", r1);
    c.check("D1 capacity released", ((await f.value(f.auth, "svccap.space"))?.pending as unknown[]).length === 0);
    const p2 = await registered(f, e);
    const sub = f.tripOnWrite("auth", `svcprop.${p2.proposalId}`, 1, e2.trip);
    const held = await e2.handle(decide(p2.proposalId, p2.revision, f.name.revision, "approve", ownerOf(f)));
    sub.unsubscribe();
    const live = await f.value(f.auth, `svcprop.${p2.proposalId}`), rev = await f.revision(f.auth, `svcprop.${p2.proposalId}`);
    const r2 = await e.handle(decide(p2.proposalId, rev, f.name.revision, "refuse", operator));
    c.check("D2 refuse of a live approving{X} is denied approval-in-progress naming X", held.state === "held" && r2.state === "denied" && r2.reason === "approval-in-progress"
      && r2.boundOperationId === (live?.state as { operationId: string }).operationId, r2);
    const p3 = await registered(f, e);
    const r3 = await e.handle(decide(p3.proposalId, p3.revision, f.name.revision, "refuse", operator));
    c.check("D3 an operator may refuse", r3.state === "refused" && "proposal" in r3 && r3.proposal.reason === "operator", r3);
  } finally { await f.close(); }
}

// ---- E: deadline settlement (simulated elapsed time) ------------------------------------------
{
  const f = await fixture("s2a-expiry");
  try {
    const dir = ledger(f.owner), e1 = await engine(f, dir), e2 = await engine(f, dir);
    const p = await registered(f, e2);
    const req = decide(p.proposalId, p.revision, f.name.revision, "approve", ownerOf(f));
    const sub = f.tripOnWrite("auth", asg(f, p.instanceId), 1, e1.trip);
    await e1.handle(req);
    sub.unsubscribe();
    // Simulation: the fixture moves the binding's original deadline into the past.
    const key = `svcop.${serviceHostOperationId(f.space, req.requestId)}`, cur = (await f.auth.get(key))!;
    await f.auth.update(key, bytesOf({ ...JSON.parse(new TextDecoder().decode(cur.value)), notAfterMs: Date.now() - 1 }), cur.revision);
    const r = await e2.handle(req);
    c.check("E1 (S-17b/S-28, simulated) an expired bound approve self-settles: refused{expired}", refusal(r) === "expired", r);
    const a = await f.value(f.auth, asg(f, p.instanceId));
    c.check("E1 the expiry cancel identity is bound with cause approval-expired", (a?.cancel as { cause: string } | null)?.cause === "approval-expired", a);
    const g = await f.value(f.auth, epgateKey(f.endpoint, p.instanceId));
    c.check("E1 deny-new landed without any approval", (g?.serviceAuthority as Record<string, unknown>)?.state === "revoked" && (g?.serviceAuthority as Record<string, unknown>)?.approvalDigest === null, g);
    c.check("E1 the proposal closed refused{expired}", (await f.value(f.auth, `svcprop.${p.proposalId}`))?.reason === "expired");
    c.check("E1 no root credential was created after the deadline", (await f.records.get(`uid.${(a?.reservation as { native: { lifecycleUid: string } }).native.lifecycleUid}`)) === null);
  } finally { await f.close(); }
}

// ---- F: construction and the shared latch -------------------------------------------------------
{
  const f = await fixture("s2a-construct");
  try {
    const dir = ledger(f.owner);
    const refuses = async (over: Partial<ServiceHostOperationsOptions>) => { try { await engine(f, dir, over); return false; } catch { return true; } };
    c.check("F1 (S-34) construction without a startup kind refuses", await refuses({ startup: undefined }));
    c.check("F1 (S-34) restore startup refuses", await refuses({ startup: { kind: "restore", restoreId: "a".repeat(32) } }));
    let opened = 0, closed = 0;
    const e = await engine(f, dir, { openEffect: async (scope) => {
      opened++;
      const effect = await f.effect(scope.keys, scope.deadlineMs);
      return { registry: effect.registry, gone: effect.gone, close: async () => { closed++; await effect.close(); } };
    } });
    const p = await registered(f, e);
    const r = await e.handle(decide(p.proposalId, p.revision, f.name.revision, "approve", ownerOf(f)));
    c.check("F2 approve over per-invocation effect connections completes", r.state === "approved", r);
    c.check("F2 every effect connection opened was closed after its awaited calls", opened >= 3 && opened === closed, { opened, closed });
    // S-33: the latch trips during the approve's native bootstrap; no write follows the trip.
    const e2 = await engine(f, dir), p2 = await registered(f, e2);
    const watch = await f.watch("auth", "*.>");
    const sub = f.tripOnWrite("auth", epgateKey(f.endpoint, p2.instanceId), 1, e2.trip);
    const h = await e2.handle(decide(p2.proposalId, p2.revision, f.name.revision, "approve", ownerOf(f)));
    sub.unsubscribe();
    await watch.stop();
    const afterGate = watch.seen.findIndex((v) => v !== null && (v as { serviceAuthority?: unknown }).serviceAuthority !== undefined);
    c.check("F3 (S-33) a latch trip during S1 bootstrap ends the approve held", h.state === "held", h);
    c.check("F3 (S-33) no S2-A or S1 write follows the tripped gate write", afterGate === watch.seen.length - 1, { afterGate, n: watch.seen.length });
    // Simulation: an operator quarantines admission; a new approve is a zero-write denial.
    const adm = (await f.auth.get("svchost.admission"))!;
    await f.auth.update("svchost.admission", bytesOf({ v: 1, kind: "service-host-admission", state: "quarantined", epoch: 1, restoreId: null }), adm.revision);
    const e3 = await engine(f, dir), p3reg = reg(f);
    const r3 = await e3.register(p3reg);
    c.check("F4 (simulated quarantine) normal startup leaves it quarantined and register refuses", r3.state === "denied" && r3.reason === "admission-closed"
      && (await f.value(f.auth, "svchost.admission"))?.state === "quarantined", r3);
  } finally { await f.close(); }
}

// ---- G: further schedules ----------------------------------------------------------------------
{
  const f = await fixture("s2a-schedules");
  try {
    const dir = ledger(f.owner);
    const fresh = () => engine(f, dir);
    const e = await fresh();
    const stopAt = async (key: string, nth: number, req: object) => { const x = await fresh(); const sub = f.tripOnWrite("auth", key, nth, x.trip); const r = await x.handle(req); sub.unsubscribe(); return r; };
    const setDeadline = async (requestId: string, notAfterMs: number) => {
      const key = `svcop.${serviceHostOperationId(f.space, requestId)}`, cur = (await f.auth.get(key))!;
      await f.auth.update(key, bytesOf({ ...JSON.parse(new TextDecoder().decode(cur.value)), notAfterMs }), cur.revision);
    };

    // S-2: the same approve request invoked twice concurrently binds once.
    {
      const p = await registered(f, e), req = decide(p.proposalId, p.revision, f.name.revision, "approve", ownerOf(f));
      const e2 = await fresh();
      // This section runs before the module's later helpers exist: cast and shape inline.
      const [x, y] = (await Promise.all([e.handle(req), e2.handle(req)])) as unknown as Loose[];
      // An invocation that lost the first use holds before custody outside its scope; its replay reports the one approval.
      const won = [x, y].find((r) => r.state === "approved"), lost = [x, y].filter((r) => r.state !== "approved");
      const replay = lost.length ? (await e.handle(req)) as unknown as Loose : undefined;
      const shape = (r: Loose) => `${r.state}/${r.reason ?? ""}/${r.phase ?? ""}`;
      const gate = await f.value(f.auth, epgateKey(f.endpoint, p.instanceId));
      c.check("G1 (S-2) concurrent identical approves: one binding, one approval, each reports it or holds scope-mismatch and its replay does",
        won !== undefined && lost.length <= 1 && lost.every((r) => r.state === "held" && r.reason === "scope-mismatch" && r.phase === "A3-bootstrap")
          && (replay === undefined || (replay.state === "approved" && replay.approval?.approvalDigest === won.approval?.approvalDigest))
          && (gate?.serviceAuthority as Record<string, unknown>)?.approvalDigest === won.approval?.approvalDigest, { x: shape(x), y: shape(y), replay: replay && shape(replay) });
    }
    // S-29: an approve that read membership loses its A1 once a refuse closed the proposal first.
    {
      const p = await registered(f, e), e2 = await fresh();
      const arm = f.faults.onWrite((w) => w.key === `svcprop.${p.proposalId}` && w.kind === "cas", { before: async () => {
        await e2.handle(decide(p.proposalId, p.revision, f.name.revision, "refuse", ownerOf(f)));
      } });
      const r = await e.handle(decide(p.proposalId, p.revision, f.name.revision, "approve", ownerOf(f)));
      c.check("G2 (S-29) the paused A1 loses at its pinned revision; the approve ends refused{owner}", arm.hits === 1 && refusal(r) === "owner"
        && (await f.value(f.auth, `svcprop.${p.proposalId}`))?.reason === "owner" && (await f.value(f.auth, asg(f, p.instanceId))) === null, r);
    }
    // S-31: an unknown capacity release is debt in the op and result, cleared only by a later read.
    {
      const p = await registered(f, e), req = decide(p.proposalId, p.revision, f.name.revision, "approve", ownerOf(f));
      const arm = f.faults.onWrite((w) => w.key === "svccap.space" && w.kind === "cas", { fault: "not-sent" }, 3);
      const r = await e.handle(req);
      const live = await opRecord(f, req.requestId);
      c.check("G3 (S-31) the approve result and the live op carry capacity-release debt", arm.hits === 3 && r.state === "approved" && r.debt?.[0]?.kind === "capacity-release"
        && live?.kind === "service-host-operation" && (live?.debt as unknown[]).length === 1, { r, live: live?.kind });
      f.faults.clear();
      const r2 = await e.handle(req);
      c.check("G3 (S-31) a replay observes the release, clears the debt and compacts", r2.state === "approved" && r2.outcome === "recorded" && r2.debt === undefined
        && (await opRecord(f, req.requestId))?.kind === "service-host-operation-terminal", r2);
    }
    // S-14: A5a lands, A5b does not; a revoke then closes the proposal truthfully; the replay stays approved.
    {
      const p = await registered(f, e), req = decide(p.proposalId, p.revision, f.name.revision, "approve", ownerOf(f));
      const r1 = await stopAt(`svcop.${serviceHostOperationId(f.space, req.requestId)}`, 3, req);
      const live = await opRecord(f, req.requestId);
      const stored = (live?.progress as { state: string; result?: { assignment: { assignmentDigest: string } } });
      c.check("G4 (S-14) the approve stopped after A5a with the proposal still approving", r1.state === "held" && stored?.state === "complete"
        && ((await f.value(f.auth, `svcprop.${p.proposalId}`))?.state as { state: string })?.state === "approving", { r1, stored: stored?.state });
      const rv = await e.handle(revoke(f.endpoint, p.instanceId, stored!.result!.assignment.assignmentDigest, "owner-request", ownerOf(f)));
      const t = await f.value(f.auth, `svcprop.${p.proposalId}`);
      c.check("G4 (S-14) V4 closes the proposal approved from the gate, never refused", rv.state === "pending" && t?.state === "approved", { rv, t });
      const r2 = await e.handle(req);
      c.check("G4 (S-14) the replay returns the stored approval, recorded", r2.state === "approved" && r2.outcome === "recorded"
        && JSON.stringify(r2.approval) === JSON.stringify(stored!.result), r2);
    }
    // S-11: the cancel binder stops after V2; a second authorized revoke reaches deny-new from svcasg alone.
    {
      const p = await registered(f, e);
      const ok = await e.handle(decide(p.proposalId, p.revision, f.name.revision, "approve", ownerOf(f)));
      const d = ok.state === "approved" ? ok.approval.assignment.assignmentDigest : "";
      const first = revoke(f.endpoint, p.instanceId, d, "owner-request", ownerOf(f));
      const h = await stopAt(asg(f, p.instanceId), 1, first);
      const bound = (await f.value(f.auth, asg(f, p.instanceId)))?.cancel as { operationId: string } | null;
      const second = await e.handle(revoke(f.endpoint, p.instanceId, d, "operator-request", operator));
      const g = await f.value(f.auth, epgateKey(f.endpoint, p.instanceId));
      c.check("G5 (S-11) the binder stopped after binding its cancel", h.state === "held" && bound?.operationId === serviceHostOperationId(f.space, first.requestId), { h, bound });
      c.check("G5 (S-11) a second revoke adopts that cancel and lands deny-new", second.state === "pending" && second.denyNew === "landed"
        && (g?.serviceAuthority as Record<string, unknown>)?.state === "revoked", second);
    }
    // S-24: native UID reservation lands after uid-unconfirmed; a later invocation reaches pending.
    {
      const p = await registered(f, e), req = decide(p.proposalId, p.revision, f.name.revision, "approve", ownerOf(f));
      await stopAt(asg(f, p.instanceId), 1, req);
      const row = await f.value(f.auth, asg(f, p.instanceId));
      const rq = revoke(f.endpoint, p.instanceId, row!.assignmentDigest as string, "owner-request", ownerOf(f));
      const r1 = await e.handle(rq);
      // Simulation of a paused B0: the fixture issues the exact reservation create native custody would.
      const res = row!.reservation as { native: { lifecycleUid: string } };
      await f.records.put(uidReservationKey(res.native.lifecycleUid), new TextEncoder().encode(canonicalJson(res)), { previousSeq: 0 });
      const r2 = await e.handle(rq);
      c.check("G6 (S-24) uid-unconfirmed, then after the late reservation the replay reaches cancelled-nonterminal",
        r1.state === "pending" && r1.phase === "uid-unconfirmed" && r2.state === "pending" && r2.phase === "cancelled-nonterminal" && r2.denyNew === "landed", { r1, r2 });
    }
    // S-8: the owner's interactive row is removed mid-approve; the replay holds; an operator revoke proceeds.
    {
      const p = await registered(f, e), req = decide(p.proposalId, p.revision, f.name.revision, "approve", ownerOf(f));
      await stopAt(asg(f, p.instanceId), 1, req);
      revokeActor(dir, f.owner, "cli");
      const r = await e.handle(req);
      c.check("G7 (S-8) a replay without the owner's current interactive row is held{permission-denied}", r.state === "held" && r.reason === "permission-denied", r);
      const d = (await f.value(f.auth, asg(f, p.instanceId)))?.assignmentDigest as string;
      const rv = await e.handle(revoke(f.endpoint, p.instanceId, d, "membership-removal", operator));
      c.check("G7 (S-8) an operator revoke still reaches deny-new", rv.state === "pending" && rv.denyNew === "landed", rv);
      grantActor(dir, { owner: f.owner, actor: "cli", scope: [], allowSubscribe: [], allowPublish: [] });
    }
    // S-27 / T5: a late A1 after the approver's expired-admitted settlement; refuse closes the stale approving{X}.
    {
      const p = await registered(f, e), req = decide(p.proposalId, p.revision, f.name.revision, "approve", ownerOf(f));
      let paused: (() => Promise<unknown>) | undefined;
      f.faults.onWrite((w) => w.key === `svcprop.${p.proposalId}` && w.kind === "cas", { fault: "deferred", deferred: (issue) => { paused = issue; } });
      f.faults.onWrite((w) => w.key === `svcprop.${p.proposalId}` && w.kind === "cas", { fault: "not-sent" }, 2);
      const r1 = await e.handle(req);
      f.faults.clear();
      await setDeadline(req.requestId, Date.now() - 1);                      // simulated elapsed time
      const r2 = await e.handle(req);
      await paused!();                                                       // the paused A1 lands late
      const stale = await f.value(f.auth, `svcprop.${p.proposalId}`), rev = await f.revision(f.auth, `svcprop.${p.proposalId}`);
      const r3 = await e.handle(decide(p.proposalId, rev, f.name.revision, "refuse", ownerOf(f)));
      c.check("G8 (S-27) the approver settles refused{expired} while its A1 is paused", r1.state === "held" && refusal(r2) === "expired", { r1, r2 });
      c.check("G8 (S-27) the late A1 leaves approving{X} with X terminal; refuse closes it and releases",
        (stale?.state as { state: string }).state === "approving" && r3.state === "refused" && "proposal" in r3 && r3.proposal.reason === "owner"
          && !((await f.value(f.auth, "svccap.space"))?.pending as Array<{ proposalId: string }>).some((x) => x.proposalId === p.proposalId), { r3 });
    }
    // S-13: a register stopped after its capacity CAS; past its bound the proposal key is fenced and a late create loses.
    {
      const x = await fresh(), rq = reg(f);
      const sub = f.tripOnWrite("auth", "svccap.space", 1, x.trip);
      const r1 = await x.register(rq);
      sub.unsubscribe();
      await setDeadline(rq.requestId, Date.now() - 1);                       // simulated elapsed time
      const r2 = await e.register(rq);
      const live = (await f.value(f.auth, "svccap.space"))?.pending as Array<{ registerRequestId: string }>;
      const opv = await opRecord(f, rq.requestId);
      const pid = (opv?.projection as { proposalId: string }).proposalId;
      let late = "landed";
      try { await f.auth.put(`svcprop.${pid}`, bytesOf({ late: true }), { previousSeq: 0 }); } catch { late = "refused"; }
      c.check("G9 (S-13) past the register bound: fence, release, refused{expired}", r1.state === "held" && r2.state === "refused" && r2.reason === "expired"
        && !live.some((y) => y.registerRequestId === rq.requestId) && (await f.value(f.auth, `svcprop.${pid}`))?.state === "expired", { r1, r2 });
      c.check("G9 (S-13) a late zero-history proposal create loses on the fenced key", late === "refused");
    }
  } finally { await f.close(); }
}

// ==== Further schedules: r3 §12 and r3a §J cells reachable in Phase A ===========================
// Stops are deterministic: the latch trips inside the fixture's own write hook, so it is set before
// the writer's post-write readiness check. "sim" marks a record or clock the fixture moved; every
// other write is the engine's or native custody's own.

type Loose = { state: string; reason?: string; phase?: string; denyNew?: string; outcome?: string; root?: string; operationId?: string;
  boundOperationId?: string; debt?: Array<{ kind: string; proposalId: string }>; proposalId?: string; revision?: number;
  approval?: ServiceApprovalResult; proposal?: { reason: string | null; state: string };
  record?: { value: Record<string, unknown>; revision: number } };
const L = (r: unknown) => r as Loose;
type Match = (w: WriteCall) => boolean;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const opKeyOf = (f: Fixture, requestId: string) => `svcop.${serviceHostOperationId(f.space, requestId)}`;
const opIdOf = (f: Fixture, r: { requestId: string }) => serviceHostOperationId(f.space, r.requestId);
const at = (key: string, kind?: WriteCall["kind"], pred: (v: Record<string, unknown>) => boolean = () => true): Match =>
  (w) => w.key === key && (kind === undefined || w.kind === kind) && w.value !== undefined && pred(w.value);
const sub = (v: Record<string, unknown>, k: string) => (v[k] as { state?: string } | null | undefined)?.state;
/** The engine's writes, by step. */
const W = {
  binding: (f: Fixture, requestId: string) => at(opKeyOf(f, requestId), "create"),
  custody: (f: Fixture, requestId: string) => at(opKeyOf(f, requestId), "cas", (v) => sub(v, "progress") === "custody"),
  approving: (pid: string) => at(`svcprop.${pid}`, "cas", (v) => sub(v, "state") === "approving"),
  closing: (pid: string) => at(`svcprop.${pid}`, "cas", (v) => v.kind === "service-proposal-terminal"),
  capacity: (requestId: string): Match => (w) => w.key === "svccap.space" && JSON.stringify(w.value?.pending ?? []).includes(requestId),
  assign: (f: Fixture, i: string) => at(asg(f, i), "create", (v) => v.state === "bound"),
  fence: (f: Fixture, i: string) => at(asg(f, i), "create", (v) => v.state === "fenced"),
  cancel: (f: Fixture, i: string) => at(asg(f, i), "cas", (v) => v.cancel !== null),
  approval: (f: Fixture, i: string) => at(epgateKey(f.endpoint, i), "cas", (v) => sub(v, "serviceAuthority") === "approved"),
  denyNew: (f: Fixture, i: string) => at(epgateKey(f.endpoint, i), undefined, (v) => sub(v, "serviceAuthority") === "revoked"),
};
/** An S2-A authority-increasing write for this selector: A1, A2 or the A4 approval. */
const authorityWrite = (f: Fixture, i: string): Match => (w) => (w.key.startsWith("svcprop.") && w.value !== undefined && sub(w.value, "state") === "approving")
  || W.assign(f, i)(w) || W.approval(f, i)(w);
const approveReq = (f: Fixture, p: { proposalId: string; revision: number }, g: object = ownerOf(f), requestId = rid()) =>
  decide(p.proposalId, p.revision, f.name.revision, "approve", g, requestId);
/** Run `go` on a fresh engine whose latch trips once the first matching write has landed. */
async function stopAfter<T>(f: Fixture, dir: string, match: Match, go: (x: ServiceHostOperations) => Promise<T>): Promise<T> {
  const x = await engine(f, dir);
  const arm = f.faults.onWrite(match, { after: async () => x.trip("fixture stop after a write") });
  try { return await go(x); } finally { arm.disarm(); }
}
/** The first matching write is held back for the fixture to issue later; the writer's two
 *  reissues are never sent, so that step ends held{unknown}. */
function paused(f: Fixture, match: Match) {
  const p: { issue?: () => Promise<unknown> } = {};
  f.faults.onWrite(match, { fault: "deferred", deferred: (issue) => { p.issue = issue; } });
  f.faults.onWrite(match, { fault: "not-sent" }, 2);
  return p;
}
const unsent = (f: Fixture, match: Match, rounds = 3) => f.faults.onWrite(match, { fault: "not-sent" }, rounds);
const unsentRelease = (f: Fixture) => unsent(f, (w) => w.key === "svccap.space" && w.kind === "cas");
/** Every write the engine and native custody issue while `go` runs; none is altered. */
async function writing<T>(f: Fixture, go: () => Promise<T>): Promise<{ r: T; writes: WriteCall[] }> {
  const writes: WriteCall[] = [];
  const spy = f.faults.onWrite((w) => { writes.push(w); return false; }, {}, Number.MAX_SAFE_INTEGER);
  try { return { r: await go(), writes }; } finally { spy.disarm(); }
}
async function patchOp(f: Fixture, requestId: string, change: (o: Record<string, unknown>) => Record<string, unknown>) {
  const key = opKeyOf(f, requestId), cur = (await f.auth.get(key))!;
  await f.auth.update(key, bytesOf(change(JSON.parse(new TextDecoder().decode(cur.value)))), cur.revision);
}
/** Simulated elapsed time: the binding's original deadline moves into the past. */
const pastDeadline = (f: Fixture, requestId: string) => patchOp(f, requestId, (o) => ({ ...o, notAfterMs: Date.now() - 1 }));
const capHas = async (f: Fixture, pid: string) => (((await f.value(f.auth, "svccap.space"))?.pending ?? []) as Array<{ proposalId: string }>).some((x) => x.proposalId === pid);
const digestAt = async (f: Fixture, pid: string) => ((await f.value(f.auth, `svcprop.${pid}`))?.state as { assignmentDigest: string }).assignmentDigest;
const gateOf = async (f: Fixture, i: string) => (await f.value(f.auth, epgateKey(f.endpoint, i)))?.serviceAuthority as { state: string; approvalDigest: string | null } | undefined;
async function lastSeqs(f: Fixture) {
  const jsm = await jetstreamManager(f.conn);
  const seq = async (bucket: string) => (await jsm.streams.info(`KV_${bucket}`)).state.last_seq;
  return { auth: await seq(epAuthBucket(f.space)), records: await seq(recordsBucket(f.space)) };
}
/** Stored writes in both buckets since `b`. A create or CAS the stream refused is never stored. */
const writesSince = async (f: Fixture, b: { auth: number; records: number }) => { const n = await lastSeqs(f); return n.auth - b.auth + n.records - b.records; };
/** Read arms that only count leader reads of `keys`. */
const countReads = (f: Fixture, keys: string[]) => { const arms = [...new Set(keys)].map((k) => f.faults.onRead("auth", k, async () => {}, Number.MAX_SAFE_INTEGER));
  return { get hits() { return arms.reduce((n, a) => n + a.hits, 0); }, disarm: () => arms.forEach((a) => a.disarm()) }; };
const shape = (r: Loose) => `${r.state}/${r.reason ?? ""}/${r.phase ?? ""}`;
/** One schedule cell: an unexpected error is a named failure, and no fault arm outlives it. */
async function cell(f: Fixture, label: string, run: () => Promise<void>) {
  try { await run(); }
  catch (err) { c.check(`${label}: ran without an unexpected error`, false, (err as Error).stack?.split("\n").slice(0, 4).join(" | ")); }
  finally { f.faults.clear(); }
}

// ---- H: register concurrency, selector collisions and requestId reuse --------------------------
{
  const f = await fixture("s2a-next-register");
  try {
    const dir = ledger(f.owner), e = await engine(f, dir), e2 = await engine(f, dir);
    await cell(f, "H1", async () => {
      const req = reg(f);
      const [x, y] = (await Promise.all([e.register(req), e2.register(req)])).map(L);
      const cap = (await f.value(f.auth, "svccap.space"))?.pending as Array<{ registerRequestId: string }>;
      c.check("H1 (S-2) the same register invoked twice concurrently: both report one proposal at one revision under one operationId",
        x.state === "registered" && y.state === "registered" && x.proposalId === y.proposalId && x.revision === y.revision
          && x.operationId === opIdOf(f, req) && y.operationId === x.operationId, { x, y });
      c.check("H1 (S-2) one invocation applied it and the other adopted the stored binding (recorded)", [x.outcome, y.outcome].sort().join() === "applied,recorded", { x: x.outcome, y: y.outcome });
      c.check("H1 (S-2) one capacity entry and one compacted binding", cap.filter((p) => p.registerRequestId === req.requestId).length === 1
        && (await opRecord(f, req.requestId))?.kind === "service-host-operation-terminal");
    });
    await cell(f, "H2", async () => {
      const i = rid(), a = reg(f, f.owner, { instanceId: i }), b = reg(f, f.owner, { instanceId: i });
      let rb: Loose | undefined;
      const arm = f.faults.onWrite(W.capacity(a.requestId), { before: async () => { rb = L(await e2.register(b)); } });
      const ra = L(await e.register(a));
      const cap = (await f.value(f.auth, "svccap.space"))?.pending as Array<{ instanceId: string }>;
      c.check("H2 (S-2) two bound register requests for one selector: the first capacity CAS registers", arm.hits === 1 && rb?.state === "registered" && rb.outcome === "applied", rb);
      c.check("H2 (S-1/S-2) the other records refused{selector-pending} at its R5 re-decision, compacted", ra.state === "refused" && ra.reason === "selector-pending"
        && ra.operationId === opIdOf(f, a) && (await opRecord(f, a.requestId))?.kind === "service-host-operation-terminal", ra);
      c.check("H2 one capacity entry for the selector, and the refusal replays recorded", cap.filter((x) => x.instanceId === i).length === 1
        && L(await e.register(a)).reason === "selector-pending");
    });
    await cell(f, "H3", async () => {
      const p = await registered(f, e), ok = L(await e.handle(approveReq(f, p)));
      const b0 = await lastSeqs(f), r = L(await e.register(reg(f, f.owner, { instanceId: p.instanceId })));
      c.check("H3 (S-9) a selector whose assignment is bound is a zero-write denial selector-bound", ok.state === "approved" && r.state === "denied" && r.reason === "selector-bound"
        && (await writesSince(f, b0)) === 0, r);
      const q = await registered(f, e), y = approveReq(f, q);
      await stopAfter(f, dir, W.approving(q.proposalId), (x) => x.handle(y));
      const fenced = L(await e.handle(revoke(f.endpoint, q.instanceId, await digestAt(f, q.proposalId), "operator-request", operator)));
      const b1 = await lastSeqs(f), r2 = L(await e.register(reg(f, f.owner, { instanceId: q.instanceId })));
      c.check("H3 (S-9) a fenced selector is selector-bound too, with zero writes", fenced.phase === "assignment-fenced" && r2.state === "denied" && r2.reason === "selector-bound"
        && (await writesSince(f, b1)) === 0, { fenced, r2 });
    });
    await cell(f, "H4", async () => {
      const rq = reg(f);
      await stopAfter(f, dir, W.binding(f, rq.requestId), (x) => x.register(rq));
      const live = await opRecord(f, rq.requestId);
      const b0 = await lastSeqs(f), r = L(await e.register({ ...rq, input: { ...rq.input, instanceId: rid() } }));
      c.check("H4 (S-10, V-ID) before compaction: a changed-body reuse of the live binding is conflict with zero writes", live?.kind === "service-host-operation"
        && r.state === "denied" && r.reason === "conflict" && (await writesSince(f, b0)) === 0, r);
      const r2 = L(await e.register(rq));
      c.check("H4 the original body then completes from its binding (applied) with one capacity entry", r2.state === "registered" && r2.outcome === "applied"
        && ((await f.value(f.auth, "svccap.space"))?.pending as Array<{ registerRequestId: string }>).filter((x) => x.registerRequestId === rq.requestId).length === 1, r2);
    });
    await cell(f, "H5", async () => {
      const pend = await registered(f, e), rq = reg(f, f.owner, { instanceId: pend.instanceId });
      const b0 = await lastSeqs(f), r1 = L(await e.register(rq)), zero = (await writesSince(f, b0)) === 0;
      const rq2 = { ...rq, input: { ...rq.input, instanceId: rid() } }, r2 = L(await e.register(rq2));
      c.check("H5 (S-10, D-A1) a zero-write R3 denial binds nothing: the same requestId with another body is then admitted", r1.state === "denied" && r1.reason === "selector-pending"
        && zero && r2.state === "registered", { r1, r2 });
      const b1 = await lastSeqs(f), r3 = L(await e.register(rq2));
      c.check("H5 (V-ID) a replay of the compacted binding writes nothing and returns the same operation and proposal", r3.state === "registered" && r3.outcome === "recorded"
        && r3.operationId === r2.operationId && r3.proposalId === r2.proposalId && (await writesSince(f, b1)) === 0, r3);
    });
  } finally { await f.close(); }
}

// ---- I: the approve table, the unknown A4 and the landing rule ---------------------------------
{
  const f = await fixture("s2a-next-approve");
  try {
    const dir = ledger(f.owner), e = await engine(f, dir), e2 = await engine(f, dir);
    const tomb = (pid: string) => f.value(f.auth, `svcprop.${pid}`);
    const asgDigest = async (i: string) => (await f.value(f.auth, asg(f, i)))!.assignmentDigest as string;
    await cell(f, "I1", async () => {
      const p = await registered(f, e), x = approveReq(f, p), y = approveReq(f, p);
      let ry: Loose | undefined;
      const arm = f.faults.onWrite(W.binding(f, x.requestId), { after: async () => { ry = L(await stopAfter(f, dir, W.approving(p.proposalId), (z) => z.handle(y))); } });
      const rx = L(await e.handle(x)), prop = await tomb(p.proposalId);
      c.check("I1 (S-3 row 9) a bound approve that finds approving{other} is superseded naming it", arm.hits === 1 && ry?.state === "held"
        && rx.state === "refused" && rx.reason === "superseded" && rx.boundOperationId === opIdOf(f, y), { rx, ry });
      c.check("I1 (S-3 row 9) the superseded approve closes and releases nothing", (prop?.state as { operationId?: string })?.operationId === opIdOf(f, y) && (await capHas(f, p.proposalId)));
      c.check("I1 the other approve then completes", L(await e.handle(y)).state === "approved");
    });
    await cell(f, "I2", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      let rv: Loose | undefined;
      const arm = f.faults.onWrite(W.assign(f, p.instanceId), { before: async () => {
        const d = await digestAt(f, p.proposalId);
        rv = L(await stopAfter(f, dir, W.fence(f, p.instanceId), (z) => z.handle(revoke(f.endpoint, p.instanceId, d, "operator-request", operator))));
      } });
      const rx = L(await e.handle(x)), t = await tomb(p.proposalId);
      c.check("I2 (S-3 row 11) A2 loses to a fence carrying my digest: R-fence, refused{revoked}", arm.hits === 1 && rv?.state === "held" && rx.state === "refused" && rx.reason === "revoked", { rx, rv });
      c.check("I2 (S-3 row 11) proposal-first: the approver closed its proposal refused{revoked} under its own operation, then released", t?.state === "refused"
        && t?.reason === "revoked" && t?.operationId === opIdOf(f, x) && !(await capHas(f, p.proposalId)), t);
    });
    await cell(f, "I3", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      await stopAfter(f, dir, W.approving(p.proposalId), (z) => z.handle(x));
      await patchOp(f, x.requestId, (o) => ({ ...o, progress: { state: "custody", step: "A3-bootstrap" } }));   // simulation: custody progress with no row
      const b0 = await lastSeqs(f), r = L(await e.handle(x));
      c.check("I3 (S-3 row 12, sim progress) custody with no assignment row is held{reference-unavailable} with zero writes", r.state === "held" && r.reason === "reference-unavailable"
        && (await writesSince(f, b0)) === 0 && (await f.value(f.auth, asg(f, p.instanceId))) === null, r);
    });
    await cell(f, "I4", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      await stopAfter(f, dir, W.approving(p.proposalId), (z) => z.handle(x));
      const key = `svcprop.${p.proposalId}`, cur = (await f.auth.get(key))!, live = JSON.parse(new TextDecoder().decode(cur.value)) as Record<string, unknown>;
      await f.auth.update(key, bytesOf({ v: 1, kind: "service-proposal-terminal", proposalId: live.proposalId, proposalDigest: live.proposalDigest, owner: live.owner,
        endpoint: live.endpoint, instanceId: live.instanceId, register: live.register, state: "approved", operationId: opIdOf(f, x), approvalDigest: D("sim-approval"),
        reason: null, atMs: Date.now() }), cur.revision);                                       // simulation: approved{me} with no landed gate
      const b0 = await lastSeqs(f), r = L(await e.handle(x));
      c.check("I4 (S-3 row 4, sim tombstone) approved{me} without my gate approval fabricates no result: held with zero writes", r.state === "held" && (await writesSince(f, b0)) === 0, r);
    });
    await cell(f, "I5", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      const arm = unsent(f, W.approval(f, p.instanceId)), r1 = L(await e.handle(x));
      f.faults.clear();
      const g1 = await gateOf(f, p.instanceId);
      c.check("I5 (S-3 A4 unknown, V-UK 3 rounds) three unsent approval CAS rounds hold unknown at A4; the gate stays pending-root", arm.hits === 3 && r1.state === "held"
        && r1.reason === "unknown" && r1.phase === "A4-approve" && g1?.state === "pending-root", { r1, g1 });
      const r2 = L(await e.handle(x)), rev = await f.revision(f.auth, epgateKey(f.endpoint, p.instanceId));
      c.check("I5 (S-3 A4 unknown) the replay re-decides from A4 and applies at its own CAS revision", r2.state === "approved" && r2.outcome === "applied" && r2.approval?.approvedGateRevision === rev, r2);
    });
    await cell(f, "I6", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      const arm = f.faults.onWrite(W.approval(f, p.instanceId), { fault: "ack-lost" });
      const r = L(await e.handle(x)), rev = await f.revision(f.auth, epgateKey(f.endpoint, p.instanceId));
      c.check("I6 (S-3 A4 unknown, §F) a lost ACK on the approval CAS is classified by readback: applied, approvedGateRevision from that read", arm.hits === 1
        && r.state === "approved" && r.outcome === "applied" && r.approval?.approvedGateRevision === rev, r);
    });
    await cell(f, "I7", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      const late = paused(f, W.approval(f, p.instanceId)), r1 = L(await e.handle(x));
      f.faults.clear();
      await pastDeadline(f, x.requestId);
      await late.issue!();                                                                    // the A4 issued in authority lands after the deadline
      const r2 = L(await e.handle(x)), row = await f.value(f.auth, asg(f, p.instanceId));
      parsesClosed("I7", r2);
      c.check("I7 (S-17a, sim deadline) an A4 CAS issued before the deadline that lands after it is a historical landing: applied", r1.state === "held" && r1.reason === "unknown"
        && r2.state === "approved" && r2.outcome === "applied" && (await tomb(p.proposalId))?.state === "approved", { r1, r2 });
      c.check("I7 (S-32) a landing seen only by a later read records approvedGateRevision null", r2.approval?.approvedGateRevision === null, r2.approval);
      c.check("I7 (S-28) row 3 precedes row 6: no expiry cancel is bound", row?.cancel === null, row);
    });
    await cell(f, "I8", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      const late = paused(f, W.approval(f, p.instanceId)), r1 = L(await e.handle(x));
      f.faults.clear();
      await pastDeadline(f, x.requestId);
      const { r, writes } = await writing(f, () => e.handle(x)), r2 = L(r);
      let lost = false;
      try { await late.issue!(); } catch { lost = true; }
      const g = await gateOf(f, p.instanceId);
      c.check("I8 (S-17b/S-28, sim deadline) pending-root with an engine-paused A4 past the deadline self-settles refused{expired}", r1.state === "held" && r2.state === "refused"
        && r2.reason === "expired" && (await tomb(p.proposalId))?.reason === "expired", { r1, r2 });
      c.check("I8 (S-28) that settlement issues no authority-increasing write", !writes.some(authorityWrite(f, p.instanceId)), writes.map((w) => w.key));
      c.check("I8 (S-17b) the released paused A4 loses: the gate stays revoked with no approval", lost && g?.state === "revoked" && g.approvalDigest === null, g);
    });
    await cell(f, "I9", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      let rv: Loose | undefined, mineRev = 0;
      const arm = f.faults.onWrite(W.approval(f, p.instanceId), { after: async () => {
        mineRev = await f.revision(f.auth, epgateKey(f.endpoint, p.instanceId));
        rv = L(await e2.handle(revoke(f.endpoint, p.instanceId, await asgDigest(p.instanceId), "operator-request", operator)));
      } });
      const rx = L(await e.handle(x)), t = await tomb(p.proposalId), g = await gateOf(f, p.instanceId);
      c.check("I9 (S-16) an approval CAS that lands before deny-new is applied", arm.hits === 1 && rx.state === "approved" && rx.outcome === "applied", rx);
      // The shared writer confirms a CAS by reading the key back. The revoke moved the gate first, so
      // the write is classified moved and the landing is then read from the gate (row 3). §F records
      // null there; it never takes the revision from the later revoked row. I5, I6 and O keep
      // the exact revision whenever the writer observes my CAS.
      c.check("I9 (§F, shared writer) an approval CAS whose key moves before the writer's confirm read is recorded with approvedGateRevision null, never a later revision",
        mineRev > 0 && rx.approval?.approvedGateRevision === null, { approvedGateRevision: rx.approval?.approvedGateRevision, mineRev });
      c.check("I9 (S-16) the revoke lands deny-new and V4 closes the proposal approved{me} from the gate", rv?.state === "pending" && rv.denyNew === "landed"
        && t?.state === "approved" && t?.operationId === opIdOf(f, x) && g?.state === "revoked" && g.approvalDigest === rx.approval?.approvalDigest, { rv, t, g });
    });
    await cell(f, "I10", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      let rv: Loose | undefined;
      const arm = f.faults.onWrite(W.approval(f, p.instanceId), { before: async () => {
        rv = L(await e2.handle(revoke(f.endpoint, p.instanceId, await asgDigest(p.instanceId), "operator-request", operator)));
      } });
      const rx = L(await e.handle(x)), t = await tomb(p.proposalId), g = await gateOf(f, p.instanceId);
      c.check("I10 (S-16) after deny-new the paused approval CAS loses at its pinned revision: refused{revoked}", arm.hits === 1 && rv?.denyNew === "landed"
        && rx.state === "refused" && rx.reason === "revoked", { rx, rv });
      c.check("I10 (S-16) the gate stays revoked with no approval and V4 closed the proposal refused{revoked}", g?.state === "revoked" && g.approvalDigest === null
        && t?.state === "refused" && t?.reason === "revoked", { g, t });
    });
    await cell(f, "I11", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      await stopAfter(f, dir, W.assign(f, p.instanceId), (z) => z.handle(x));
      const row = (await f.value(f.auth, asg(f, p.instanceId)))!, uid = (row.reservation as ServiceUidCustodyV1).native.lifecycleUid;
      let rv: Loose | undefined;
      const arm = f.faults.onWrite(W.custody(f, x.requestId), { after: async () => {
        rv = L(await e2.handle(revoke(f.endpoint, p.instanceId, row.assignmentDigest as string, "operator-request", operator)));
      } });
      const rx = L(await e.handle(x));
      c.check("I11 (S-23) the revoke's deny-new lands before the approver's open; its result is defined: pending{uid-unconfirmed, landed}", arm.hits === 1
        && rv?.state === "pending" && rv.phase === "uid-unconfirmed" && rv.denyNew === "landed", rv);
      c.check("I11 (S-23) the approver stops at open and ends refused{revoked}, with no UID reservation", rx.state === "refused" && rx.reason === "revoked"
        && (await f.records.get(uidReservationKey(uid))) === null, rx);
    });
    await cell(f, "I12", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      const late = paused(f, W.assign(f, p.instanceId)), r1 = L(await e.handle(x));
      f.faults.clear();
      await pastDeadline(f, x.requestId);
      const r2 = L(await e.handle(x)), t = await tomb(p.proposalId);
      c.check("I12 (S-25, sim deadline) an expired approve with the assignment absent settles proposal-first: refused{expired}", r1.state === "held" && r2.state === "refused"
        && r2.reason === "expired" && t?.state === "refused" && t?.reason === "expired" && !(await capHas(f, p.proposalId)), { r1, r2, t });
      const p2 = await registered(f, e, p.instanceId);
      await late.issue!();                                                                    // T4 (a): the A2 issued in authority lands late
      const row = await f.value(f.auth, asg(f, p.instanceId));
      c.check("I12 (S-26 T4 a) the late A2 leaves svcasg bound to the settled approve with a null cancel", row?.state === "bound" && row.cancel === null
        && (row.creation as { operationId: string }).operationId === opIdOf(f, x), row);
      const y2 = await writing(f, () => e.handle(approveReq(f, p2))), ry = L(y2.r), t2 = await tomb(p2.proposalId);
      const closedAt = y2.writes.findIndex(W.closing(p2.proposalId)), releasedAt = y2.writes.findIndex((w) => w.key === "svccap.space");
      c.check("I12 (S-26 T4 a, r3a §D) R-bound closes the proposal before it releases and issues no authority-increasing write", closedAt >= 0 && releasedAt > closedAt
        && !y2.writes.some(authorityWrite(f, p.instanceId)), y2.writes.map((w) => w.key));
      c.check("I12 (S-26 T4 a) a later approve of the same selector ends R-bound: op refused{conflict}", ry.state === "refused" && ry.reason === "conflict", ry);
      c.check("I12 (S-26 T4 a, r3 §5.1 R-bound) its target proposal is closed refused{selector-bound} and released", t2?.kind === "service-proposal-terminal"
        && t2?.reason === "selector-bound" && !(await capHas(f, p2.proposalId)), t2);
      const rv = L(await e.handle(revoke(f.endpoint, p.instanceId, row!.assignmentDigest as string, "operator-request", operator)));
      c.check("I12 (S-26 T4 a) the residue is revocable through the bound branch: pending{uid-unconfirmed, landed}", rv.state === "pending" && rv.phase === "uid-unconfirmed"
        && rv.denyNew === "landed", rv);
    });
    await cell(f, "I13", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      await stopAfter(f, dir, W.assign(f, p.instanceId), (z) => z.handle(x));
      const row = (await f.value(f.auth, asg(f, p.instanceId)))!, res = row.reservation as ServiceUidCustodyV1;
      await f.records.put(lifecycleHeadKey(res.assignment.owner, res.assignment.actor), bytesOf({ fixture: "colliding-head" }), { previousSeq: 0 });   // simulation
      const r = L(await e.handle(x)), t = await tomb(p.proposalId), g = await gateOf(f, p.instanceId);
      c.check("I13 (S-26 T4 b, sim collision) an S1 refusal at A3 is proposal-first: proposal refused{custody-refused}, released, op refused{custody-refused}",
        r.state === "refused" && r.reason === "custody-refused" && t?.reason === "custody-refused" && !(await capHas(f, p.proposalId)), { r, t });
      c.check("I13 (S-26 T4 b) the residue is the bound row with a null cancel beside a non-authorizing pending-root gate",
        (await f.value(f.auth, asg(f, p.instanceId)))?.cancel === null && g?.state === "pending-root", g);
      const rv = L(await e.handle(revoke(f.endpoint, p.instanceId, row.assignmentDigest as string, "operator-request", operator))), g2 = await gateOf(f, p.instanceId);
      c.check("I13 (S-26 T4 b) a revoke through the bound branch lands deny-new on that gate", rv.denyNew === "landed" && g2?.state === "revoked" && g2.approvalDigest === null, { rv, g2 });
    });
    await cell(f, "I14", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      await stopAfter(f, dir, W.assign(f, p.instanceId), (z) => z.handle(x));
      const o1 = await opRecord(f, x.requestId);
      await stopAfter(f, dir, W.custody(f, x.requestId), (z) => z.handle(x));
      const o2 = await opRecord(f, x.requestId);
      c.check("I14 (V-DL) a replay never changes the persisted notAfterMs or admittedAtMs", o1?.notAfterMs === o2?.notAfterMs && o1?.admittedAtMs === o2?.admittedAtMs
        && (o2?.progress as { state: string }).state === "custody", { o1: o1?.notAfterMs, o2: o2?.notAfterMs });
      c.check("I14 the approve then completes", L(await e.handle(x)).state === "approved");
    });
    // Last in this fixture: it leaves admission at epoch 2.
    await cell(f, "I15", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      const late = paused(f, W.approval(f, p.instanceId)), r1 = L(await e.handle(x));
      f.faults.clear();
      const adm = (await f.auth.get("svchost.admission"))!;
      await f.auth.update("svchost.admission", bytesOf({ v: 1, kind: "service-host-admission", state: "open", epoch: 2, restoreId: null }), adm.revision);   // simulation: an epoch change
      const r2 = L(await e.handle(x));
      c.check("I15 (S-6, sim epoch, no S2-Q) a bound approve across an epoch change holds admission-held before any landing", r1.reason === "unknown"
        && r2.state === "held" && r2.reason === "admission-held", { r1, r2 });
      await late.issue!();
      const r3 = L(await e.handle(x));
      c.check("I15 (S-6 a, documentation cell) without S2-Q the A4 issued at epoch 1 still lands; the replay records a historical landing", r3.state === "approved"
        && r3.outcome === "applied" && r3.approval?.approvedGateRevision === null, r3);
    });
  } finally { await f.close(); }
}

// ---- J: revoke: unknown cancel and fence writes, resumption, deny-new order, spent requests ----
{
  const f = await fixture("s2a-next-revoke");
  try {
    const dir = ledger(f.owner), e = await engine(f, dir), e2 = await engine(f, dir);
    const approved = async () => { const p = await registered(f, e), a = L(await e.handle(approveReq(f, p))); return { ...p, digest: a.approval!.assignment.assignmentDigest }; };
    const atA1 = async () => { const p = await registered(f, e), x = approveReq(f, p); await stopAfter(f, dir, W.approving(p.proposalId), (z) => z.handle(x));
      return { ...p, x, digest: await digestAt(f, p.proposalId) }; };
    const atA2 = async () => { const p = await registered(f, e), x = approveReq(f, p); await stopAfter(f, dir, W.assign(f, p.instanceId), (z) => z.handle(x));
      return { ...p, x, digest: (await f.value(f.auth, asg(f, p.instanceId)))!.assignmentDigest as string }; };
    const cancelAt = async (i: string) => (await f.value(f.auth, asg(f, i)))?.cancel as { operationId: string; cause: string } | null | undefined;
    await cell(f, "J1", async () => {
      const p = await approved(), rq = revoke(f.endpoint, p.instanceId, p.digest, "owner-request", ownerOf(f));
      const arm = unsent(f, W.cancel(f, p.instanceId)), r1 = L(await e.handle(rq));
      f.faults.clear();
      c.check("J1 (S-5 unknown cancel CAS, V-UK 3 rounds) three unsent cancel CAS rounds hold unknown at V2 with no cancel bound", arm.hits === 3 && r1.state === "held"
        && r1.reason === "unknown" && r1.phase === "V2-cancel" && (await cancelAt(p.instanceId)) === null, r1);
      const r2 = L(await e.handle(rq));
      c.check("J1 the replay binds its cancel once and lands deny-new", r2.state === "pending" && r2.denyNew === "landed" && (await cancelAt(p.instanceId))?.operationId === opIdOf(f, rq), r2);
    });
    await cell(f, "J2", async () => {
      const p = await approved();
      const x = revoke(f.endpoint, p.instanceId, p.digest, "owner-request", ownerOf(f)), y = revoke(f.endpoint, p.instanceId, p.digest, "operator-request", operator);
      const arm = f.faults.onWrite(W.cancel(f, p.instanceId), { fault: "ack-lost" });
      const rx = L(await e.handle(x)), ry = L(await e2.handle(y));
      const res = (await f.value(f.auth, asg(f, p.instanceId)))!.reservation as ServiceUidCustodyV1;
      const head = JSON.stringify(await f.value(f.records, lifecycleHeadKey(res.assignment.owner, res.assignment.actor)));
      c.check("J2 (S-5, V-UK) a lost-ACK cancel CAS is classified by readback and the binder lands deny-new", arm.hits === 1 && rx.state === "pending" && rx.denyNew === "landed", rx);
      c.check("J2 (S-5) the second revoke adopts the bound cancel; native custody carries only the binder's identity", ry.state === "pending" && ry.denyNew === "landed"
        && (await cancelAt(p.instanceId))?.operationId === opIdOf(f, x) && head.includes(opIdOf(f, x)) && !head.includes(opIdOf(f, y)), { ry, head });
    });
    await cell(f, "J3", async () => {
      const p = await atA1(), rq = revoke(f.endpoint, p.instanceId, p.digest, "operator-request", operator);
      const arm = unsent(f, W.fence(f, p.instanceId)), r1 = L(await e.handle(rq));
      f.faults.clear();
      c.check("J3 (S-5/S-4 unknown fence create, V-UK) three unsent fence creates hold unknown at V2-fence with no row", arm.hits === 3 && r1.state === "held"
        && r1.reason === "unknown" && r1.phase === "V2-fence" && (await f.value(f.auth, asg(f, p.instanceId))) === null, r1);
      const r2 = L(await e.handle(rq)), t = await f.value(f.auth, `svcprop.${p.proposalId}`);
      c.check("J3 the replay fences once; V4 closes the proposal refused{revoked} and releases", r2.state === "pending" && r2.phase === "assignment-fenced"
        && t?.state === "refused" && t?.reason === "revoked" && !(await capHas(f, p.proposalId)), { r2, t });
      c.check("J3 the fenced assignment is its own deny-new evidence: landed", r2.denyNew === "landed", r2);
      c.check("J3 (S-19) the abandoned approver's replay ends refused{revoked}", L(await e.handle(p.x)).reason === "revoked");
    });
    for (const [label, which] of [["J4", "fence"], ["J5", "binding"]] as const) await cell(f, label, async () => {
      const p = await atA1(), rq = revoke(f.endpoint, p.instanceId, p.digest, "operator-request", operator);
      let ax: Loose | undefined;
      const arm = f.faults.onWrite(which === "fence" ? W.fence(f, p.instanceId) : W.binding(f, rq.requestId), { before: async () => { ax = L(await e2.handle(p.x)); } });
      const rv = L(await e.handle(rq));
      c.check(`${label} (S-18) a revoke that read svcasg absent, paused at its ${which} write while the approve completed, re-reads bound and holds before cancelling outside its scope`,
        arm.hits === 1 && ax?.state === "approved" && rv.state === "held" && rv.reason === "scope-mismatch" && rv.phase === "V3-cancel"
          && (await gateOf(f, p.instanceId))?.state === "approved", { ax, rv });
      const rv2 = L(await e.handle(rq)), g = await gateOf(f, p.instanceId);
      c.check(`${label} (S-18) its replay discovers the bound assignment and cancels`, rv2.state === "pending" && rv2.phase === "cancelled-nonterminal" && rv2.denyNew === "landed", rv2);
      c.check(`${label} (S-18) never not-found: the gate is revoked and keeps the approval`, g?.state === "revoked" && g.approvalDigest === ax?.approval?.approvalDigest, g);
    });
    await cell(f, "J6", async () => {
      const p = await atA2(), rq = revoke(f.endpoint, p.instanceId, p.digest, "operator-request", operator);
      const rv1 = L(await stopAfter(f, dir, W.denyNew(f, p.instanceId), (z) => z.handle(rq)));
      const t0 = await f.value(f.auth, `svcprop.${p.proposalId}`);
      c.check("J6 (S-25) a revoke stopped right after deny-new landed, before its V4: held, the proposal still approving", rv1.state === "held"
        && (await gateOf(f, p.instanceId))?.state === "revoked" && (t0?.state as { state: string }).state === "approving", { rv1, t0: t0?.state });
      const ra = L(await e.handle(p.x)), t1 = await f.value(f.auth, `svcprop.${p.proposalId}`);
      c.check("J6 (S-25) the approver replayed before that V4 ends R-revoked proposal-first: refused{revoked}, released", ra.state === "refused" && ra.reason === "revoked"
        && t1?.reason === "revoked" && t1?.operationId === opIdOf(f, p.x) && !(await capHas(f, p.proposalId)), { ra, t1 });
      const rv2 = L(await e.handle(rq));
      c.check("J6 (S-25) the revoke's replay re-runs S1 cancel to a defined pending with deny-new landed", rv2.state === "pending" && rv2.denyNew === "landed", rv2);
    });
    await cell(f, "J7", async () => {
      const p = await atA2(), rq = revoke(f.endpoint, p.instanceId, p.digest, "operator-request", operator);
      await stopAfter(f, dir, W.denyNew(f, p.instanceId), (z) => z.handle(rq));
      await pastDeadline(f, p.x.requestId);
      const ra = L(await e.handle(p.x));
      c.check("J7 (S-25/S-28, sim deadline) deny-new landed before the approver's deadline; its replay after it ends refused{revoked}, the cause's reason", ra.state === "refused"
        && ra.reason === "revoked" && (await cancelAt(p.instanceId))?.cause === "operator-request", ra);
    });
    await cell(f, "J8", async () => {
      const p = await atA2(), rv = L(await e.handle(revoke(f.endpoint, p.instanceId, p.digest, "owner-request", ownerOf(f))));
      await pastDeadline(f, p.x.requestId);
      const ra = L(await e.handle(p.x));
      c.check("J8 (S-25, sim deadline) replayed after that revoke's V4 and past its deadline, the approver ends refused{revoked} from the tombstone", rv.state === "pending"
        && ra.state === "refused" && ra.reason === "revoked", { rv, ra });
    });
    await cell(f, "J9", async () => {
      const p = await atA1(), expire = Date.now() - 1;                                        // simulation: the canonical expiry has passed
      const capE = (await f.auth.get("svccap.space"))!, cap = JSON.parse(new TextDecoder().decode(capE.value)) as { pending: Array<{ proposalId: string }> };
      await f.auth.update("svccap.space", bytesOf({ ...cap, pending: cap.pending.map((x) => (x.proposalId === p.proposalId ? { ...x, expiresAtMs: expire } : x)) }), capE.revision);
      const pe = (await f.auth.get(`svcprop.${p.proposalId}`))!;
      await f.auth.update(`svcprop.${p.proposalId}`, bytesOf({ ...JSON.parse(new TextDecoder().decode(pe.value)), expiresAtMs: expire }), pe.revision);
      await patchOp(f, p.x.requestId, (o) => ({ ...o, notAfterMs: expire }));
      const b0 = await lastSeqs(f), rv = L(await e.handle(revoke(f.endpoint, p.instanceId, p.digest, "operator-request", operator)));
      c.check("J9 (S-27 T5, sim expiry) a revoke after the entry expires finds no eligible approving proposal: not-found with zero writes", rv.state === "denied"
        && rv.reason === "not-found" && (await writesSince(f, b0)) === 0, rv);
      const pr = L(await e.handle({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "proposal-read", input: { proposalId: p.proposalId }, granter: ownerOf(f) }));
      c.check("J9 (S-27) proposal-read shows the approving proposal with its past expiresAt", pr.state === "present" && pr.record?.value.state === "approving"
        && (pr.record.value.expiresAt as number) * 1000 <= Date.now(), pr);
      const ra = L(await e.handle(p.x));
      c.check("J9 (S-27/S-25) the approver's own settlement closes it refused{expired}", ra.state === "refused" && ra.reason === "expired"
        && (await f.value(f.auth, `svcprop.${p.proposalId}`))?.reason === "expired", ra);
    });
    await cell(f, "J10", async () => {
      const p = await approved(), rq = revoke(f.endpoint, p.instanceId, p.digest, "owner-request", ownerOf(f));
      await stopAfter(f, dir, W.cancel(f, p.instanceId), (z) => z.handle(rq));
      await pastDeadline(f, rq.requestId);
      const r1 = L(await e.handle(rq));
      c.check("J10 (V-DL, sim deadline) a revoke past its own deadline is spent: held{expired, spent} with no native step", r1.state === "held" && r1.reason === "expired"
        && r1.phase === "spent" && r1.denyNew === "not-landed" && (await gateOf(f, p.instanceId))?.state === "approved", r1);
      const r2 = L(await e.handle(revoke(f.endpoint, p.instanceId, p.digest, "operator-request", operator)));
      c.check("J10 (V-DL, S-11) a new revoke request adopts the bound cancel and lands deny-new", r2.state === "pending" && r2.denyNew === "landed"
        && (await cancelAt(p.instanceId))?.operationId === opIdOf(f, rq), r2);
    });
    // Simulation: the endpoint gate is rewritten to the same row bound to another immutable assignment (a foreign gate), still
    // approved or revoked. Both revoke paths read it as no evidence about this assignment's deny-new.
    const foreignGate = async (i: string, revoked: boolean) => {
      const key = epgateKey(f.endpoint, i), cur = (await f.auth.get(key))!, row = JSON.parse(new TextDecoder().decode(cur.value));
      let next = { ...row, serviceAuthority: { ...row.serviceAuthority, assignmentDigest: D(`foreign-${i}`) } };
      if (revoked) next = next.state === "open" ? { ...next, state: "frozen", op: { opId: serviceHostOperationId(f.space, rid()), kind: "retirement" },
        serviceAuthority: { ...next.serviceAuthority, state: "revoked" } } : { ...next, serviceAuthority: { ...next.serviceAuthority, state: "revoked" } };
      const bytes = bytesOf(next);
      await f.auth.update(key, bytes, cur.revision);
      return async () => { const g = await f.auth.get(key); return !!g && Buffer.from(g.value).equals(Buffer.from(bytes)); };
    };
    for (const revoked of [false, true]) {
      const tag = revoked ? "a revoked foreign gate" : "an approved foreign gate";
      await cell(f, "J11", async () => {
        const p = await approved(), rq = revoke(f.endpoint, p.instanceId, p.digest, "owner-request", ownerOf(f));
        await stopAfter(f, dir, W.cancel(f, p.instanceId), (z) => z.handle(rq));
        await pastDeadline(f, rq.requestId);
        const unchanged = await foreignGate(p.instanceId, revoked), { r, writes } = await writing(f, () => e.handle(rq)), r1 = L(r);
        parsesClosed(`J11 spent over ${tag}`, r);
        c.check(`J11 (I-3, sim gate and deadline) a spent revoke over ${tag} reports deny-new unknown, with zero writes and the gate unchanged`, r1.state === "held"
          && r1.reason === "expired" && r1.phase === "spent" && r1.denyNew === "unknown" && writes.length === 0 && (await unchanged()), { r1, writes: writes.map((w) => w.key) });
      });
      await cell(f, "J12", async () => {
        const p = await approved(), rq = revoke(f.endpoint, p.instanceId, p.digest, "owner-request", ownerOf(f));
        await stopAfter(f, dir, W.cancel(f, p.instanceId), (z) => z.handle(rq));
        const unchanged = await foreignGate(p.instanceId, revoked), { r, writes } = await writing(f, () => e.handle(rq)), r1 = L(r);
        parsesClosed(`J12 native cancel over ${tag}`, r);
        c.check(`J12 (I-3, sim gate) native cancel over ${tag} holds foreign-assignment with deny-new unknown, zero writes and the gate unchanged`, r1.state === "held"
          && r1.reason === "foreign-assignment" && r1.phase === "L1-endpoint" && r1.denyNew === "unknown" && writes.length === 0 && (await unchanged()), { r1, writes: writes.map((w) => w.key) });
      });
    }
  } finally { await f.close(); }
}

// ---- K: refuse, stale approving and late writes --------------------------------------------------
{
  const f = await fixture("s2a-next-refuse");
  try {
    const dir = ledger(f.owner), e = await engine(f, dir);
    const tomb = (pid: string) => f.value(f.auth, `svcprop.${pid}`);
    const refuseReq = (p: { proposalId: string }, rev: number, g: object = ownerOf(f)) => decide(p.proposalId, rev, f.name.revision, "refuse", g);
    await cell(f, "K1", async () => {
      const p = await registered(f, e), rf = refuseReq(p, p.revision), x = approveReq(f, p);
      const arm = f.faults.onWrite(W.binding(f, rf.requestId), { after: async () => { await stopAfter(f, dir, W.approving(p.proposalId), (z) => z.handle(x)); } });
      const r = L(await e.handle(rf)), t = await tomb(p.proposalId);
      c.check("K1 (S-7) a refuse admitted at revision R and overtaken by an A1 records refused{conflict} and closes nothing", arm.hits === 1 && r.state === "refused"
        && r.reason === "conflict" && (t?.state as { state: string }).state === "approving", { r, t: t?.state });
      c.check("K1 the overtaking approve then completes", L(await e.handle(x)).state === "approved");
    });
    await cell(f, "K2", async () => {
      const p = await registered(f, e), rf = refuseReq(p, p.revision);
      await stopAfter(f, dir, W.binding(f, rf.requestId), (z) => z.handle(rf));
      await pastDeadline(f, rf.requestId);
      const r = L(await e.handle(rf)), t = await tomb(p.proposalId);
      c.check("K2 (V-DL, sim deadline) a bound refuse past its deadline records refused{expired}; the proposal stays proposed with its entry", r.state === "refused"
        && r.reason === "expired" && (t?.state as { state: string }).state === "proposed" && (await capHas(f, p.proposalId)), { r, t: t?.state });
    });
    await cell(f, "K3", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      const late = paused(f, W.approving(p.proposalId));
      await e.handle(x);
      f.faults.clear();
      await pastDeadline(f, x.requestId);
      const { r, writes } = await writing(f, () => e.handle(x)), settled = L(r);
      c.check("K3 (S-28, sim deadline) an expired-admitted replay records refused{expired} and writes only its own operation record", settled.state === "refused"
        && settled.reason === "expired" && writes.length > 0 && writes.every((w) => w.key === opKeyOf(f, x.requestId)), writes.map((w) => w.key));
      await late.issue!();                                                                    // T5: the paused A1 lands late
      const stale = (await f.auth.get(`svcprop.${p.proposalId}`))!;
      const b0 = await lastSeqs(f), y = L(await e.handle(approveReq(f, { proposalId: p.proposalId, revision: stale.revision })));
      c.check("K3 (S-27 T5) a new approve on the stale approving{X} is a zero-write denial approval-in-progress naming X", y.state === "denied"
        && y.reason === "approval-in-progress" && y.boundOperationId === opIdOf(f, x) && (await writesSince(f, b0)) === 0, y);
      const rr = L(await e.handle(refuseReq(p, stale.revision, operator))), t = await tomb(p.proposalId);
      c.check("K3 (S-27 T5) an operator refuse closes the stale approving{X} refused{operator} and releases", rr.state === "refused" && rr.proposal?.reason === "operator"
        && t?.reason === "operator" && !(await capHas(f, p.proposalId)), { rr, t });
    });
    await cell(f, "K4", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      const late = paused(f, W.approving(p.proposalId)), r1 = L(await e.handle(x));
      f.faults.clear();
      const rf = L(await e.handle(refuseReq(p, p.revision)));
      let lost = false;
      try { await late.issue!(); } catch { lost = true; }
      const t = await tomb(p.proposalId), rx = L(await e.handle(x));
      c.check("K4 (S-7) an A1 CAS released after the refuse closed the proposal loses; the refused tombstone stands", r1.reason === "unknown" && rf.state === "refused" && lost
        && t?.state === "refused" && t?.reason === "owner", { r1, rf, t });
      c.check("K4 (S-7) the approver's replay ends refused{owner} from the tombstone", rx.state === "refused" && rx.reason === "owner", rx);
    });
    await cell(f, "K5", async () => {
      const rq = reg(f);
      const create: Match = (w) => w.key.startsWith("svcprop.") && w.kind === "create" && (w.value?.register as { requestId?: string } | undefined)?.requestId === rq.requestId;
      const late = paused(f, create), r1 = L(await e.register(rq));
      f.faults.clear();
      await pastDeadline(f, rq.requestId);
      const r2 = L(await e.register(rq)), pid = ((await opRecord(f, rq.requestId))?.projection as { proposalId: string }).proposalId;
      let lost = false;
      try { await late.issue!(); } catch { lost = true; }
      c.check("K5 (S-7/S-13, sim deadline) a register whose proposal create stayed unknown is fenced past its bound: refused{expired}, released", r1.state === "held"
        && r1.reason === "unknown" && r1.phase === "R6-proposal" && r2.state === "refused" && r2.reason === "expired" && !(await capHas(f, pid)), { r1, r2 });
      c.check("K5 (S-7) the engine's own deferred proposal create then loses on the fenced key", lost && (await tomb(pid))?.state === "expired");
    });
    await cell(f, "K6", async () => {
      const p = await registered(f, e), capE = (await f.auth.get("svccap.space"))!;
      const cap = JSON.parse(new TextDecoder().decode(capE.value)) as { pending: Array<{ proposalId: string }> };
      await f.auth.update("svccap.space", bytesOf({ ...cap, pending: cap.pending.filter((x) => x.proposalId !== p.proposalId) }), capE.revision);   // simulation: no entry
      const b0 = await lastSeqs(f), r = L(await e.handle(approveReq(f, p)));
      c.check("K6 (S-13 N5, sim capacity row) approve without the proposal's eligible entry is a zero-write denial expired", r.state === "denied" && r.reason === "expired"
        && (await writesSince(f, b0)) === 0, r);
    });
  } finally { await f.close(); }
}

// ---- L: S-31, an unknown capacity release in each refusal branch ----------------------------------
{
  const f = await fixture("s2a-next-debt");
  try {
    const dir = ledger(f.owner), e = await engine(f, dir);
    const debtAt = async (requestId: string) => ((await opRecord(f, requestId))?.debt ?? null) as Array<{ kind: string }> | null;
    const owes = (label: string, arm: { hits: number }, r: Loose, requestId: string) => async (extra: boolean) =>
      c.check(`${label} with capacity-release debt in the result and the live op`, arm.hits === 3 && extra && r.debt?.[0]?.kind === "capacity-release"
        && (await debtAt(requestId))?.length === 1, r);
    const clears = async (label: string, r: Loose, requestId: string, pid: string) =>
      c.check(`${label} a replay observes the release, clears the debt and compacts`, r.debt === undefined && (await opRecord(f, requestId))?.kind === "service-host-operation-terminal"
        && !(await capHas(f, pid)), r);
    await cell(f, "L1", async () => {
      const p = await registered(f, e), rf = decide(p.proposalId, p.revision, f.name.revision, "refuse", ownerOf(f));
      const arm = unsentRelease(f), r = L(await e.handle(rf));
      f.faults.clear();
      await owes("L1 (S-31 refuse) an unknown release after the refuse tombstone: applied", arm, r, rf.requestId)(r.state === "refused" && r.outcome === "applied");
      await clears("L1", L(await e.handle(rf)), rf.requestId, p.proposalId);
    });
    await cell(f, "L2", async () => {
      const rq = reg(f);
      await stopAfter(f, dir, W.capacity(rq.requestId), (z) => z.register(rq));
      await pastDeadline(f, rq.requestId);
      const arm = unsentRelease(f), r = L(await e.register(rq));
      f.faults.clear();
      const pid = ((await opRecord(f, rq.requestId))?.projection as { proposalId: string }).proposalId;
      await owes("L2 (S-31 register bound, sim deadline) an unknown release after the fence: refused{expired}", arm, r, rq.requestId)(r.state === "refused" && r.reason === "expired");
      await clears("L2", L(await e.register(rq)), rq.requestId, pid);
    });
    await cell(f, "L3", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      await stopAfter(f, dir, W.approving(p.proposalId), (z) => z.handle(x));
      const d = await digestAt(f, p.proposalId);
      await stopAfter(f, dir, W.fence(f, p.instanceId), (z) => z.handle(revoke(f.endpoint, p.instanceId, d, "operator-request", operator)));
      const arm = unsentRelease(f), r = L(await e.handle(x));
      f.faults.clear();
      await owes("L3 (S-31 R-fence) an unknown release after the approver's R-fence close: refused{revoked}", arm, r, x.requestId)(r.state === "refused" && r.reason === "revoked");
      await clears("L3", L(await e.handle(x)), x.requestId, p.proposalId);
    });
    await cell(f, "L4", async () => {
      const p = await registered(f, e), x = approveReq(f, p), rf = decide(p.proposalId, p.revision, f.name.revision, "refuse", ownerOf(f));
      await stopAfter(f, dir, W.binding(f, x.requestId), (z) => z.handle(x));
      await stopAfter(f, dir, W.closing(p.proposalId), (z) => z.handle(rf));
      const arm = unsentRelease(f), r = L(await e.handle(x));
      f.faults.clear();
      await owes("L4 (S-31 row 5) an unknown release by an approver that finds the proposal refused: refused{owner}", arm, r, x.requestId)(r.state === "refused" && r.reason === "owner");
      await clears("L4", L(await e.handle(x)), x.requestId, p.proposalId);
      const rr = L(await e.handle(rf));
      c.check("L4 the stopped refuse then completes from its tombstone", rr.state === "refused" && rr.proposal?.reason === "owner", rr);
    });
    await cell(f, "L5", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      await stopAfter(f, dir, W.approving(p.proposalId), (z) => z.handle(x));
      const rq = revoke(f.endpoint, p.instanceId, await digestAt(f, p.proposalId), "operator-request", operator);
      const arm = unsentRelease(f), r = L(await e.handle(rq));
      f.faults.clear();
      const d1 = await debtAt(rq.requestId);
      c.check("L5 (S-31 V4) an unknown V4 release is retained as capacity-release debt in the revoke op", arm.hits === 3 && r.state === "pending"
        && r.phase === "assignment-fenced" && d1?.[0]?.kind === "capacity-release", { r, d1 });
      c.check("L5 (S-31 V4, r3a §D) the revoke result carries that debt", r.debt?.[0]?.kind === "capacity-release", r);
      parsesClosed("L5 pending with debt", r);
      const r2 = L(await e.handle(rq)), d2 = await debtAt(rq.requestId);
      c.check("L5 (S-31 V4, r3a §D) a replay that observes the release clears the revoke op's debt", r2.state === "pending" && !(await capHas(f, p.proposalId))
        && d2?.length === 0, { r2, d2 });
      c.check("L5 (S-31 V4) that replay's result no longer carries debt", r2.debt === undefined, r2);
    });
  } finally { await f.close(); }
}

// ---- M: S-30, another owner's granter on mutations and replays -------------------------------------
{
  const f = await fixture("s2a-next-owners");
  try {
    const third = `u_${"e".repeat(26)}`;                                                      // an owner with no interactive row
    const dir = ledger(f.owner, other), e = await engine(f, dir), them = { kind: "owner", owner: other }, outsider = { kind: "owner", owner: third };
    const sealed = ["accountPublicKey", "kind", "operation", "reason", "requestId", "space", "state", "v"].join();
    const denial = async (label: string, run: () => Promise<unknown>, reasons: readonly string[]) => {
      const b0 = await lastSeqs(f), raw = await run(), r = L(raw);
      c.check(`M (S-30) ${label}: denied ${reasons.join(" or ")} before disclosure or effect, zero writes`, r.state === "denied" && reasons.includes(r.reason ?? "")
        && Object.keys(raw as object).sort().join() === sealed && (await writesSince(f, b0)) === 0, r);
    };
    const read = (g: object, operation: string, input: object) => e.handle({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation, input, granter: g });
    const pA = await registered(f, e), pL = await registered(f, e), pR = await registered(f, e), pX = await registered(f, e);
    const ax = approveReq(f, pA), dA = L(await e.handle(ax)).approval!.assignment.assignmentDigest;
    const rfO = decide(pR.proposalId, pR.revision, f.name.revision, "refuse", ownerOf(f));
    const rvO = revoke(f.endpoint, pA.instanceId, dA, "owner-request", ownerOf(f));
    const xX = approveReq(f, pX), rq = reg(f);
    await e.handle(rfO); await e.handle(rvO); await e.register(rq);
    await stopAfter(f, dir, W.approving(pX.proposalId), (z) => z.handle(xX));
    const dX = await digestAt(f, pX.proposalId);
    await cell(f, "M1", async () => {
      await denial("their refuse of my live proposal", () => e.handle(decide(pL.proposalId, pL.revision, f.name.revision, "refuse", them)), ["not-found"]);
      await denial("their revoke of my bound assignment, knowing its digest", () => e.handle(revoke(f.endpoint, pA.instanceId, dA, "owner-request", them)), ["not-found"]);
      await denial("their revoke of my approving proposal (the absent-row branch)", () => e.handle(revoke(f.endpoint, pX.instanceId, dX, "owner-request", them)), ["not-found"]);
    });
    await cell(f, "M2", async () => {
      // A requestId is one space-wide namespace: a colliding reuse can only be refused. It must not reveal stored content or act.
      await denial("their reuse of my approve requestId", () => e.handle({ ...ax, granter: them }), ["conflict", "not-found", "permission-denied"]);
      await denial("their reuse of my refuse requestId", () => e.handle({ ...rfO, granter: them }), ["conflict", "not-found", "permission-denied"]);
      await denial("their reuse of my revoke requestId", () => e.handle({ ...rvO, granter: them }), ["conflict", "not-found", "permission-denied"]);
      await denial("their reuse of my register requestId as granter of my body", () => e.register({ ...rq, granter: them }), ["permission-denied"]);
    });
    await cell(f, "M3", async () => {
      // Authorization runs before any request-key read, with one held answer whether or not the request is bound,
      // so the refusal discloses no binding.
      const refusedFirst = async (label: string, r0: { requestId: string }, run: () => Promise<unknown>) => {
        const reads = countReads(f, [opKeyOf(f, r0.requestId)]), b0 = await lastSeqs(f), r = L(await run());
        reads.disarm();
        c.check(`M (S-30, §E) ${label}: held{permission-denied, authorize} under the request's coordinate before any read, zero writes`, r.state === "held"
          && r.reason === "permission-denied" && r.phase === "authorize" && r.operationId === opIdOf(f, r0) && reads.hits === 0 && (await writesSince(f, b0)) === 0, r);
      };
      await refusedFirst("an owner with no current interactive row reusing a bound approve requestId", ax, () => e.handle({ ...ax, granter: outsider }));
      await refusedFirst("an owner with no current interactive row reusing a bound revoke requestId", rvO, () => e.handle({ ...rvO, granter: outsider }));
      await refusedFirst("an owner with no current interactive row reusing a bound register requestId", rq, () => e.register({ ...rq, granter: outsider, input: { ...rq.input, owner: third } }));
      await denial("my own reuse of my bound approve requestId with another body", () => e.handle({ ...ax, input: { ...ax.input, expectedProposalRevision: ax.input.expectedProposalRevision + 1 } }), ["conflict"]);
      await denial("my own reuse of my bound revoke requestId with another body", () => e.handle({ ...rvO, input: { ...rvO.input, expectedAssignmentDigest: D("another") } }), ["conflict"]);
    });
    await cell(f, "M4", async () => {
      const rvX = revoke(f.endpoint, pX.instanceId, dX, "operator-request", operator);
      await e.handle(rvX);
      const mine = L(await read(ownerOf(f), "operation-read", { operationId: opIdOf(f, rvX) })), theirs = L(await read(them, "operation-read", { operationId: opIdOf(f, rvX) }));
      c.check("M4 (S-30, S-15) an operator's revoke of my assignment: I read it through the projection; another owner reads absent", mine.state === "present" && theirs.state === "absent", { mine: mine.state, theirs });
      const t1 = L(await read(them, "operation-read", { operationId: opIdOf(f, rvO) })), t2 = L(await read(them, "proposal-read", { proposalId: pL.proposalId }));
      c.check("M4 (S-30) another owner's reads of my revoke and my live proposal are absent", t1.state === "absent" && t2.state === "absent", { t1, t2 });
    });
    await cell(f, "M5", async () => {
      revokeActor(dir, f.owner, "cli");
      try {
        const b0 = await lastSeqs(f);
        const r1 = L(await e.handle(rfO)), r2 = L(await e.handle(rvO)), r3 = L(await read(ownerOf(f), "operation-read", { operationId: opIdOf(f, rvO) }));
        c.check("M5 (S-30, §E) without my current interactive row: refuse and revoke replays hold permission-denied, reads are denied, zero writes",
          r1.state === "held" && r1.reason === "permission-denied" && r2.state === "held" && r2.reason === "permission-denied" && r3.state === "denied"
            && r3.reason === "permission-denied" && (await writesSince(f, b0)) === 0, { r1, r2, r3 });
      } finally { grantActor(dir, { owner: f.owner, actor: "cli", scope: [], allowSubscribe: [], allowPublish: [] }); }
    });
  } finally { await f.close(); }
}

// ---- N: the latch during S2-A steps, timeout versus latch, decision bounds, markers ---------------
{
  const f = await fixture("s2a-next-latch");
  try {
    const dir = ledger(f.owner), e = await engine(f, dir);
    await registered(f, e);                                                                   // the capacity row exists
    const approvedRevoke = async () => { const p = await registered(f, e), a = L(await e.handle(approveReq(f, p)));
      return { p, rq: revoke(f.endpoint, p.instanceId, a.approval!.assignment.assignmentDigest, "owner-request", ownerOf(f)) }; };
    type Stop = { match: Match; go: (x: ServiceHostOperations) => Promise<unknown>; op: string; done: () => Promise<boolean> };
    const points: Array<[string, () => Promise<Stop>]> = [
      ["register R4 binding create", async () => { const rq = reg(f);
        return { match: W.binding(f, rq.requestId), go: (x) => x.register(rq), op: opIdOf(f, rq), done: async () => L(await e.register(rq)).state === "registered" }; }],
      ["register R5 capacity CAS", async () => { const rq = reg(f);
        return { match: W.capacity(rq.requestId), go: (x) => x.register(rq), op: opIdOf(f, rq), done: async () => L(await e.register(rq)).state === "registered" }; }],
      ["approve binding create", async () => { const p = await registered(f, e), x = approveReq(f, p);
        return { match: W.binding(f, x.requestId), go: (z) => z.handle(x), op: opIdOf(f, x), done: async () => L(await e.handle(x)).state === "approved" }; }],
      ["approve A1 CAS", async () => { const p = await registered(f, e), x = approveReq(f, p);
        return { match: W.approving(p.proposalId), go: (z) => z.handle(x), op: opIdOf(f, x), done: async () => L(await e.handle(x)).state === "approved" }; }],
      ["approve A5b proposal close", async () => { const p = await registered(f, e), x = approveReq(f, p);
        return { match: W.closing(p.proposalId), go: (z) => z.handle(x), op: opIdOf(f, x), done: async () => L(await e.handle(x)).state === "approved" }; }],
      ["refuse proposal close", async () => { const p = await registered(f, e), rf = decide(p.proposalId, p.revision, f.name.revision, "refuse", ownerOf(f));
        return { match: W.closing(p.proposalId), go: (z) => z.handle(rf), op: opIdOf(f, rf), done: async () => L(await e.handle(rf)).state === "refused" }; }],
      ["revoke V1 binding create", async () => { const { rq } = await approvedRevoke();
        return { match: W.binding(f, rq.requestId), go: (z) => z.handle(rq), op: opIdOf(f, rq), done: async () => L(await e.handle(rq)).state === "pending" }; }],
      ["revoke V2 cancel CAS", async () => { const { p, rq } = await approvedRevoke();
        return { match: W.cancel(f, p.instanceId), go: (z) => z.handle(rq), op: opIdOf(f, rq), done: async () => L(await e.handle(rq)).state === "pending" }; }],
    ];
    for (const [label, prep] of points) await cell(f, `N1 ${label}`, async () => {
      const s = await prep(), x = await engine(f, dir);
      let landed: { auth: number; records: number } | undefined;
      const arm = f.faults.onWrite(s.match, { after: async () => { x.trip("fixture: latch during an S2-A step"); landed = await lastSeqs(f); } });
      const r = L(await s.go(x));
      arm.disarm();
      const quiet = landed !== undefined && (await writesSince(f, landed)) === 0;
      c.check(`N1 (S-21/S-33) a latch trip at the ${label} ends held under its operation, with no later write`, arm.hits === 1 && r.state === "held" && r.operationId === s.op && quiet, { r, quiet });
      if (label.startsWith("revoke") || label.startsWith("approve") || label.startsWith("refuse")) parsesClosed(`N1 ${label}`, r);
      c.check(`N1 after the trip at the ${label}, a fresh engine completes the request`, await s.done());
    });
    await cell(f, "N2", async () => {
      const pa = await registered(f, e), pb = await registered(f, e), x = await engine(f, dir);
      let go!: () => void;
      const tripped = new Promise<void>((r) => { go = r; });
      const paused = f.faults.onRead("auth", epgateKey(f.endpoint, pb.instanceId), async () => { await tripped; });
      const rb = x.handle(approveReq(f, pb));
      for (let n = 0; paused.hits === 0 && n < 200; n++) await pause(10);
      f.faults.onWrite(W.approving(pa.proposalId), { after: async () => { x.trip("fixture: latch tripped from another invocation"); go(); } });
      const ra = L(await x.handle(approveReq(f, pa))), rbv = L(await rb), tb = await f.value(f.auth, `svcprop.${pb.proposalId}`);
      c.check("N2 (S-33) one engine trip stops every live invocation: the other, paused mid-table, holds readiness at its next write", paused.hits === 1
        && ra.state === "held" && rbv.state === "held" && rbv.reason === "readiness" && (tb?.state as { state: string }).state === "proposed", { ra, rbv });
    });
    await cell(f, "N3", async () => {
      const realNow = Date.now;
      let off = 0;
      const shiftAfter = (match: Match, ms: number) => f.faults.onWrite(match, { after: async () => { off = ms; } });
      const clocked = async <T>(go: () => Promise<T>) => { Date.now = () => realNow() + off; try { return await go(); } finally { Date.now = realNow; off = 0; } };
      const p = await registered(f, e), x = approveReq(f, p);
      const armA = shiftAfter(W.approving(p.proposalId), S2A_INVOCATION_MS + 1_000), ra = L(await clocked(() => e.handle(x)));
      c.check("N3 (S-33, sim clock) the invocation bound passing at A1 ends held{reconcile-pending}", armA.hits === 1 && ra.state === "held" && ra.reason === "reconcile-pending"
        && ra.phase === "A1-approving", ra);
      c.check("N3 a later replay gets a new invocation bound and completes from the landed A1", L(await e.handle(x)).state === "approved");
      const q = await registered(f, e), y = approveReq(f, q);
      await stopAfter(f, dir, W.binding(f, y.requestId), (z) => z.handle(y));
      await patchOp(f, y.requestId, (o) => ({ ...o, notAfterMs: Date.now() + 20_000 }));       // simulation: an original deadline inside the invocation bound
      const armB = shiftAfter(W.approving(q.proposalId), 30_000), rb = L(await clocked(() => e.handle(y)));
      c.check("N3 (S-33, sim clock and deadline) the original deadline passing at A1 inside the invocation bound ends held{deadline}", armB.hits === 1 && rb.state === "held"
        && rb.reason === "deadline" && rb.phase === "A1-approving", rb);
      const s = await registered(f, e), z2 = approveReq(f, s), rc = L(await stopAfter(f, dir, W.approving(s.proposalId), (z) => z.handle(z2)));
      c.check("N3 (S-33) a latch trip at the same step ends held{post-write-readiness}: three distinct reasons", rc.state === "held" && rc.reason === "post-write-readiness"
        && rc.phase === "A1-approving", rc);
    });
    await cell(f, "N4", async () => {
      const rq = reg(f);
      const arm = f.faults.onWrite(W.capacity(rq.requestId), { before: async () => { await f.touch(f.auth, "svccap.space"); } }, 100);
      const r = L(await e.register(rq));
      arm.disarm();
      c.check("N4 (V-UK 4-decision bound) a capacity CAS that loses on every fresh decision holds contention after four decisions", arm.hits === 4 && r.state === "held"
        && r.reason === "contention" && r.phase === "R5-capacity", { hits: arm.hits, r });
      c.check("N4 a replay without contention registers", L(await e.register(rq)).state === "registered");
    });
    await cell(f, "N5", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      await stopAfter(f, dir, W.assign(f, p.instanceId), (z) => z.handle(x));
      await f.auth.delete(asg(f, p.instanceId));                                              // simulation: a deletion marker on a create-once key
      const b0 = await lastSeqs(f), r = L(await e.handle(x));
      c.check("N5 (V-UK, sim marker) a DEL marker on svcasg holds assignment-tombstone under the operation with zero writes; never recreated", r.state === "held"
        && r.reason === "assignment-tombstone" && r.operationId === opIdOf(f, x) && (await writesSince(f, b0)) === 0, r);
      const q = await registered(f, e), y = approveReq(f, q);
      await stopAfter(f, dir, W.approving(q.proposalId), (z) => z.handle(y));
      const cur = (await f.auth.get(`svcprop.${q.proposalId}`))!;
      await f.auth.update(`svcprop.${q.proposalId}`, new TextEncoder().encode("{not json"), cur.revision);   // simulation: a malformed record
      const b1 = await lastSeqs(f), r2 = L(await e.handle(y));
      c.check("N5 (V-UK, sim malformed) a non-JSON proposal under a bound approve holds proposal-malformed under the operation with zero writes", r2.state === "held"
        && r2.reason === "proposal-malformed" && r2.operationId === opIdOf(f, y) && (await writesSince(f, b1)) === 0, r2);
      const { p: pv, rq } = await approvedRevoke();
      await stopAfter(f, dir, W.binding(f, rq.requestId), (z) => z.handle(rq));
      await f.auth.delete(asg(f, pv.instanceId));                                             // simulation: a deletion marker under a bound revoke
      const b2 = await lastSeqs(f), r3 = L(await e.handle(rq));
      parsesClosed("N5 revoke discovery", r3);
      c.check("N5 (V-UK, sim marker) a DEL marker read by a bound revoke's discovery holds assignment-tombstone under the operation with zero writes", r3.state === "held"
        && r3.reason === "assignment-tombstone" && r3.operationId === opIdOf(f, rq) && (await writesSince(f, b2)) === 0, r3);
    });
    await cell(f, "N7", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      await stopAfter(f, dir, W.assign(f, p.instanceId), (z) => z.handle(x));
      const z = await engine(f, dir);
      const arm = f.faults.onRead("auth", `svcprop.${p.proposalId}`, async () => z.trip("fixture: latch between discovery and the invocation"));
      const r = L(await z.handle(x));
      c.check("N7 (S-33) a latch trip between a bound replay's discovery and its invocation holds under the operation, never a zero-write denial", arm.hits === 1
        && r.state === "held" && r.operationId === opIdOf(f, x), r);
    });
  } finally { await f.close(); }
}
{
  const f = await fixture("s2a-next-admission");
  try {
    const dir = ledger(f.owner);
    await cell(f, "N6", async () => {
      const arm = unsent(f, at("svchost.admission", "create"));
      let failed = false;
      try { await engine(f, dir); } catch { failed = true; }
      f.faults.clear();
      c.check("N6 (S-34) an unknown admission create fails construction closed; admission stays absent", arm.hits === 3 && failed && (await f.value(f.auth, "svchost.admission")) === null);
      const arm2 = f.faults.onWrite(at("svchost.admission", "create"), { fault: "ack-lost" });
      const e = await engine(f, dir), adm = await f.value(f.auth, "svchost.admission");
      c.check("N6 (S-34, V-UK) a lost-ACK admission create is classified by readback: constructed, open at epoch 1", arm2.hits === 1 && adm?.state === "open"
        && adm?.epoch === 1 && L(await e.register(reg(f))).state === "registered", adm);
    });
  } finally { await f.close(); }
}

// ---- O: V-UK, each fault at every write of one flow ---------------------------------------------
{
  type Out = { ok: boolean; got: unknown };
  const flows: Array<[string, (f: Fixture, e: ServiceHostOperations) => Promise<() => Promise<Out>>]> = [
    ["register", async (f, e) => { const rq = reg(f);
      return async () => { const r = L(await e.register(rq)); return { ok: r.state === "registered" && r.outcome === "applied", got: r }; }; }],
    ["approve", async (f, e) => { const p = await registered(f, e), x = approveReq(f, p);
      return async () => { const r = L(await e.handle(x)), rev = await f.revision(f.auth, epgateKey(f.endpoint, p.instanceId));
        return { ok: r.state === "approved" && r.outcome === "applied" && r.approval?.approvedGateRevision === rev, got: r }; }; }],
    ["refuse", async (f, e) => { const p = await registered(f, e), rf = decide(p.proposalId, p.revision, f.name.revision, "refuse", ownerOf(f));
      return async () => { const r = L(await e.handle(rf));
        return { ok: r.state === "refused" && r.outcome === "applied" && r.proposal?.reason === "owner" && !(await capHas(f, p.proposalId)), got: r }; }; }],
    ["revoke", async (f, e) => { const p = await registered(f, e), a = L(await e.handle(approveReq(f, p)));
      const rq = revoke(f.endpoint, p.instanceId, a.approval!.assignment.assignmentDigest, "owner-request", ownerOf(f));
      return async () => { const r = L(await e.handle(rq));
        return { ok: r.state === "pending" && r.phase === "cancelled-nonterminal" && r.denyNew === "landed" && r.root === "retained-stamped", got: r }; }; }],
  ];
  for (const [name, setup] of flows) {
    const f = await fixture(`s2a-sweep-${name}`);
    try {
      const dir = ledger(f.owner), e = await engine(f, dir);
      await cell(f, `O ${name}`, async () => {
        const run0 = await setup(f, e), b0 = await lastSeqs(f);
        const { r: o0, writes } = await writing(f, run0), n0 = await writesSince(f, b0);
        const steps = writes.map((w) => `${w.bucket}:${w.key.split(".")[0]}:${w.kind}`);
        c.check(`O0 (V-UK) ${name}: the unfaulted flow completes with ${steps.length} stored writes`, o0.ok && n0 === steps.length, { o0, n0 });
        console.log(`INFO O ${name} writes: ${steps.join(" ")}`);
        for (const fault of ["ack-lost", "not-sent", "deferred"] as const) {
          const bad: unknown[] = [];
          for (let k = 1; k <= steps.length; k++) {
            const run = await setup(f, e);
            let n = 0, late: (() => Promise<unknown>) | undefined;
            const arm = f.faults.onWrite(() => ++n === k, fault === "deferred" ? { fault, deferred: (issue) => { late = issue; } } : { fault });
            const b = await lastSeqs(f);
            let o: Out;
            try { o = await run(); } catch (err) { o = { ok: false, got: (err as Error).message }; }
            f.faults.clear();
            const stored = await writesSince(f, b);
            let lateLanded = false;
            if (late) { try { await late(); lateLanded = true; } catch { /* the original loses */ } }
            if (arm.hits !== 1 || !o.ok || stored !== steps.length || lateLanded) bad.push({ k, write: steps[k - 1], hits: arm.hits, stored, lateLanded, got: o.got });
          }
          c.check(`O (V-UK) ${name}: ${fault} at each of its ${steps.length} writes completes as unfaulted with exactly ${steps.length} stored writes`
            + (fault === "deferred" ? "; every deferred original loses" : ""), bad.length === 0, bad);
        }
      });
    } finally { await f.close(); }
  }
}

// ---- P: V-SH, closed shapes over every record these flows store -------------------------------------
{
  const f = await fixture("s2a-next-shapes");
  try {
    const dir = ledger(f.owner), seen = await f.watch("auth", "*.>"), e = await engine(f, dir);
    await cell(f, "P", async () => {
      const pA = await registered(f, e), a = L(await e.handle(approveReq(f, pA)));
      await e.handle(revoke(f.endpoint, pA.instanceId, a.approval!.assignment.assignmentDigest, "owner-request", ownerOf(f)));
      const pR = await registered(f, e);
      await e.handle(decide(pR.proposalId, pR.revision, f.name.revision, "refuse", operator));
      const pF = await registered(f, e), xF = approveReq(f, pF);
      await stopAfter(f, dir, W.approving(pF.proposalId), (z) => z.handle(xF));
      await e.handle(revoke(f.endpoint, pF.instanceId, await digestAt(f, pF.proposalId), "operator-request", operator));
      await e.handle(xF);
      const pS = await registered(f, e), xS = approveReq(f, pS), yS = approveReq(f, pS);
      f.faults.onWrite(W.binding(f, xS.requestId), { after: async () => { await stopAfter(f, dir, W.approving(pS.proposalId), (z) => z.handle(yS)); } });
      await e.handle(xS);
      f.faults.clear();
      await seen.stop();
      const parsers: Record<string, (v: unknown) => unknown> = {
        "service-host-operation": parseServiceHostOperationRecord, "service-host-operation-terminal": parseServiceHostOperationRecord,
        "service-proposal": parseServiceProposalRecord, "service-proposal-terminal": parseServiceProposalRecord, "service-proposal-capacity": parseServiceCapacityRecord,
        "service-assignment": parseServiceAssignmentRecord, "service-host-admission": parseServiceAdmissionRecord };
      const records = seen.seen.filter((v): v is Record<string, unknown> => v !== null && typeof v.kind === "string" && Object.hasOwn(parsers, v.kind));
      const bad = records.filter((v) => { try { return canonicalJson(parsers[v.kind as string](v)) !== canonicalJson(v); } catch { return true; } });
      const kinds = [...new Set(records.map((v) => v.kind as string))].sort();
      c.check(`P1 (V-SH) every S2-A record these flows stored (${records.length}) parses closed and round-trips canonically`, records.length > 0 && bad.length === 0
        && kinds.length === 7, { bad: bad.slice(0, 2), kinds });
      const first = (pred: (v: Record<string, unknown>) => boolean) => structuredClone(records.find(pred)!);
      const opLive = first((v) => v.kind === "service-host-operation" && (v.plan as { kind: string }).kind === "approve"), opTerm = first((v) => v.kind === "service-host-operation-terminal");
      const propLive = first((v) => v.kind === "service-proposal"), propTerm = first((v) => v.kind === "service-proposal-terminal" && v.state === "approved");
      const asgBound = first((v) => v.kind === "service-assignment" && v.state === "bound"), asgFenced = first((v) => v.kind === "service-assignment" && v.state === "fenced");
      const adm = first((v) => v.kind === "service-host-admission");
      const ownerTok = (k: number) => `u_${String.fromCharCode(97 + (k % 26)).repeat(26)}`;
      const capOf = (n: number, o: (k: number) => string = ownerTok) => ({ v: 1, kind: "service-proposal-capacity", pending: Array.from({ length: n }, (_, k) => ({
        proposalId: k.toString(16).padStart(64, "0"), owner: o(k), endpoint: f.endpoint, instanceId: `fill${String(k).padStart(28, "0")}`, registerRequestId: "e".repeat(32),
        expiresAtMs: Date.now() + 3_600_000 })) });
      const omit = (o: Record<string, unknown>, k: string) => { const x = { ...o }; delete x[k]; return x; };
      const throws = (parse: (v: unknown) => unknown, v: unknown) => { try { parse(v); return false; } catch { return true; } };
      const OP = parseServiceHostOperationRecord, PR = parseServiceProposalRecord, CA = parseServiceCapacityRecord, AS = parseServiceAssignmentRecord, AD = parseServiceAdmissionRecord;
      const cases: Array<[string, (v: unknown) => unknown, unknown]> = [
        ["an operation with an extra field", OP, { ...opLive, extra: 1 }],
        ["an operation with a missing field", OP, omit(opLive, "debt")],
        ["an operation at version 2", OP, { ...opLive, v: 2 }],
        ["an operation of an unknown kind", OP, { ...opLive, kind: "service-host-operation-draft" }],
        ["an operation that is not a plain object", OP, Object.assign(Object.create({ inherited: true }), opLive)],
        ["an operation with a bad operationId grammar", OP, { ...opLive, operationId: "ZZ" }],
        ["an operation whose plan belongs to another operation", OP, { ...opLive, operation: "revoke" }],
        ["an operation with three debts", OP, { ...opLive, debt: Array.from({ length: 3 }, () => ({ kind: "capacity-release", proposalId: "a".repeat(64) })) }],
        ["an operation with an unknown progress state", OP, { ...opLive, progress: { state: "running" } }],
        ["a terminal operation with an unknown refusal reason", OP, { ...opTerm, outcome: { state: "refused", reason: "because" } }],
        ["a proposal approving without its operation", PR, { ...propLive, state: { state: "approving" } }],
        ["a proposal with duplicate cluster digests", PR, { ...propLive, clusterDigests: [D("cluster"), D("cluster")] }],
        ["an approved tombstone without an approvalDigest", PR, { ...propTerm, approvalDigest: null }],
        ["an approved tombstone with a close reason", PR, { ...propTerm, reason: "owner" }],
        ["a capacity row of 257 entries", CA, capOf(257)],
        ["a capacity row out of order", CA, { ...capOf(2), pending: capOf(2).pending.reverse() }],
        ["a bound assignment whose reservation does not match its digest", AS, { ...asgBound, assignmentDigest: D("another") }],
        ["a fenced assignment without a cancel", AS, { ...asgFenced, cancel: null }],
        ["an assignment with an unknown cancel cause", AS, { ...asgFenced, cancel: { ...(asgFenced.cancel as object), cause: "because" } }],
        ["an admission at epoch 0", AD, { ...adm, epoch: 0 }],
        ["an admission in an unknown state", AD, { ...adm, state: "restoring" }],
      ];
      for (const [label, parse, v] of cases) c.check(`P2 (V-SH) the closed parser refuses ${label}`, throws(parse, v));
      c.check("P2 (V-SH) the capacity parser accepts 32 entries for one owner", !throws(CA, capOf(32, () => f.owner)));
      c.check("P3 (V-SH bound, r1 V-SH row) the capacity parser refuses 33 entries for one owner", throws(CA, capOf(33, () => f.owner)));
      const big = reg(f);
      (big.input as { commands: unknown[] }).commands = Array.from({ length: 128 }, (_, k) => ({ ...command, name: `c${String(k).padStart(3, "0")}`,
        traits: Array.from({ length: 32 }, (_, t) => `t${t}`.padEnd(200, "x")) }));
      const b0 = await lastSeqs(f), rb = L(await e.register(big));
      c.check("P4 (V-SH) a proposal over 256 KiB is refused at R1 with zero writes", rb.state === "denied" && rb.reason === "bad-request" && (await writesSince(f, b0)) === 0, rb);
    });
  } finally { await f.close(); }
}

// ---- Q: a tripped engine's entry, failed binding reads, and R-bound against a concurrent A1 ------
{
  const f = await fixture("s2a-next-tripped");
  try {
    const dir = ledger(f.owner), e = await engine(f, dir);
    await registered(f, e);                                                                   // the capacity row exists
    type Bound = { go: (x: ServiceHostOperations) => Promise<unknown>; requestId: string; keys: string[]; done: () => Promise<boolean> };
    /** A request whose binding create landed and stays live: the latch trips right after that create. */
    const bound: Array<[string, () => Promise<Bound>]> = [
      ["register", async () => { const rq = reg(f); await stopAfter(f, dir, W.binding(f, rq.requestId), (x) => x.register(rq));
        return { go: (x) => x.register(rq), requestId: rq.requestId, keys: [], done: async () => L(await e.register(rq)).state === "registered" }; }],
      ["approve", async () => { const p = await registered(f, e), x = approveReq(f, p); await stopAfter(f, dir, W.binding(f, x.requestId), (z) => z.handle(x));
        return { go: (z) => z.handle(x), requestId: x.requestId, keys: [`svcprop.${p.proposalId}`], done: async () => L(await e.handle(x)).state === "approved" }; }],
      ["revoke", async () => { const p = await registered(f, e), a = L(await e.handle(approveReq(f, p)));
        const rq = revoke(f.endpoint, p.instanceId, a.approval!.assignment.assignmentDigest, "owner-request", ownerOf(f));
        await stopAfter(f, dir, W.binding(f, rq.requestId), (z) => z.handle(rq));
        return { go: (z) => z.handle(rq), requestId: rq.requestId, keys: [asg(f, p.instanceId)], done: async () => L(await e.handle(rq)).state === "pending" }; }],
    ];
    const tripped = async () => { const x = await engine(f, dir); x.trip("fixture: the engine latch tripped before the request arrived"); return x; };
    /** Simulation: the nth leader read of `key` fails after the broker answered it. */
    const failRead = (key: string, nth: number) => { let n = 0;
      return f.faults.onRead("auth", key, async () => { if (++n === nth) throw new Error("fixture: simulated leader read failure"); }, nth); };
    const counting = (keys: string[]) => countReads(f, keys);
    for (const [label, prep] of bound) await cell(f, `Q1 ${label}`, async () => {
      const s = await prep(), live = await opRecord(f, s.requestId), x = await tripped();
      const reads = counting([opKeyOf(f, s.requestId), ...s.keys]), b0 = await lastSeqs(f), r = L(await s.go(x));
      reads.disarm();
      if (label !== "register") parsesClosed(`Q1 ${label}`, r);
      c.check(`Q1 (F-1 residual, latch) a tripped engine reads none of a bound ${label}'s keys and writes nothing`, live?.kind === "service-host-operation" && reads.hits === 0
        && (await writesSince(f, b0)) === 0, { live: live?.kind, reads: reads.hits });
      c.check(`Q1 (F-1 residual, contract denied) a bound ${label} on a tripped engine is never a zero-write denial: held under its operation`, r.state === "held"
        && r.operationId === opIdOf(f, s), r);
      c.check(`Q1 after the trip, a fresh engine completes the bound ${label}`, await s.done());
    });
    await cell(f, "Q1 uniform", async () => {
      const p = await registered(f, e), xb = approveReq(f, p);
      await stopAfter(f, dir, W.binding(f, xb.requestId), (z) => z.handle(xb));
      const q = await registered(f, e), x = await tripped();
      const rs = [L(await x.handle(xb)), L(await x.handle(approveReq(f, q))), L(await x.handle(approveReq(f, q, { kind: "owner", owner: other }))),
        L(await x.register(reg(f))), L(await x.register(reg(f, other)))];
      c.check("Q1 (F-1 residual) the tripped answer is one arm for bound and unbound requests and for authorized and unauthorized granters: it implies neither binding nor authorization",
        new Set(rs.map(shape)).size === 1, rs.map(shape));
      const reads = counting([opKeyOf(f, xb.requestId)]);
      const ro = L(await x.handle({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "operation-read", granter: ownerOf(f), input: { operationId: opIdOf(f, xb) } }));
      reads.disarm();
      c.check("Q1 (latch) an operation read on a tripped engine stays a zero-write denial and reads nothing", ro.state === "denied" && ro.reason === "unavailable" && reads.hits === 0, ro);
    });
    const q2: Record<string, Loose> = {};
    for (const [label, prep] of bound) await cell(f, `Q2 ${label}`, async () => {
      const s = await prep(), y = await engine(f, dir);
      const nth = label === "register" ? 1 : 2;                                                // decide and revoke discovery read the binding first
      const arm = failRead(opKeyOf(f, s.requestId), nth), b0 = await lastSeqs(f), r = q2[label] = L(await s.go(y));
      c.check(`Q2 (F-1 family, sim read failure) a bound ${label} whose binding read fails inside its invocation holds under its operation, never a zero-write denial`,
        arm.hits === nth && r.state === "held" && r.operationId === opIdOf(f, s) && (await writesSince(f, b0)) === 0, r);
      c.check(`Q2 after the failed read, a fresh engine completes the bound ${label}`, await s.done());
    });
    await cell(f, "Q2 uniform", async () => {
      const rq = reg(f), arm = failRead(opKeyOf(f, rq.requestId), 1), r = L(await e.register(rq));
      c.check("Q2 (F-1 family, sim read failure) a never-bound register whose binding read fails gets the same arm as a bound one: the failure discloses no binding",
        arm.hits === 1 && q2.register !== undefined && shape(r) === shape(q2.register), { r: shape(r), bound: q2.register && shape(q2.register) });
    });
    await cell(f, "Q3", async () => {
      const tomb = (pid: string) => f.value(f.auth, `svcprop.${pid}`);
      const p = await registered(f, e), x0 = approveReq(f, p);
      const late = paused(f, W.assign(f, p.instanceId));
      await e.handle(x0);                                                                     // x0 holds unknown at A2; the fixture keeps its original
      f.faults.clear();
      await pastDeadline(f, x0.requestId);
      await e.handle(x0);                                                                     // x0 settles refused{expired}, proposal-first
      const p2 = await registered(f, e, p.instanceId), y = approveReq(f, p2), xr = approveReq(f, p2), xOp = opIdOf(f, xr), yOp = opIdOf(f, y);
      let atClose!: () => void, a1Landed!: () => void, xRun: Promise<Loose> | undefined, yA1!: { hits: number }, xClose!: { hits: number };
      const xAtClose = new Promise<void>((r) => { atClose = r; }), yLanded = new Promise<void>((r) => { a1Landed = r; });
      const run = await writing(f, async () => {
        // Y has read the selector free when its A1 is issued. Before that A1 goes out, the late A2 lands and X, admitted at the same
        // proposal revision, runs into R-bound; X's pinned target close is issued only after Y's A1 has landed at that revision.
        yA1 = f.faults.onWrite(W.approving(p2.proposalId), {
          before: async () => { await late.issue!(); xRun = e.handle(xr).then(L); await Promise.race([xAtClose, xRun]); },
          after: async () => { a1Landed(); } });
        xClose = f.faults.onWrite((w) => W.closing(p2.proposalId)(w) && w.value?.operationId === xOp, { before: async () => { atClose(); await Promise.race([yLanded, pause(10_000)]); } });
        const ry = L(await e.handle(y));
        return { ry, rx: await xRun };
      });
      const { ry, rx } = run.r, w = run.writes, t = await tomb(p2.proposalId);
      const closedAt = w.findIndex((v) => W.closing(p2.proposalId)(v) && v.value?.operationId === yOp);
      const releasedAt = w.findIndex((v) => v.key === "svccap.space" && !JSON.stringify(v.value?.pending ?? []).includes(p2.proposalId));
      c.check("Q3 (D-B race) the R-bound target close pinned to the admitted revision is issued after a concurrent A1 landed at that revision, and loses",
        yA1.hits === 1 && xClose.hits === 1 && t?.kind === "service-proposal-terminal" && t?.operationId === yOp, { t, hits: [yA1.hits, xClose.hits] });
      c.check("Q3 (D-B race) the losing approver records refused{conflict} and issues no authority-increasing write", rx?.state === "refused" && rx.reason === "conflict"
        && !w.some((v) => authorityWrite(f, p.instanceId)(v) && JSON.stringify(v.value).includes(xOp)), { rx, keys: w.map((v) => v.key) });
      c.check("Q3 (D-B race) the A1 winner then meets R-bound itself: it closes the proposal refused{selector-bound} before the release and ends refused{conflict}",
        ry.state === "refused" && ry.reason === "conflict" && t?.reason === "selector-bound" && closedAt >= 0 && releasedAt > closedAt && !(await capHas(f, p2.proposalId)),
        { ry, t, closedAt, releasedAt });
      const outcome = (o: Record<string, unknown> | null) => (o?.kind === "service-host-operation-terminal" ? o.outcome : o?.progress) as { state: string; reason?: string } | undefined;
      const ox = outcome(await opRecord(f, xr.requestId)), oy = outcome(await opRecord(f, y.requestId));
      c.check("Q3 (D-B race) no approving proposal is left behind and both bindings record refused{conflict}", ox?.state === "refused" && ox.reason === "conflict"
        && oy?.state === "refused" && oy.reason === "conflict", { ox, oy });
    });
    await cell(f, "Q4", async () => {
      const d4 = ledger(f.owner), e4 = await engine(f, d4), rq = reg(f), fresh = reg(f);
      await stopAfter(f, d4, W.binding(f, rq.requestId), (x) => x.register(rq));
      revokeActor(d4, f.owner, "cli");
      const b0 = await lastSeqs(f), r = L(await e4.register(rq));
      c.check("Q4 (F-2 family, r3a §E) a bound register replayed after its owner lost the interactive row holds permission-denied under its operation, as decide and revoke do",
        r.state === "held" && r.reason === "permission-denied" && r.operationId === opIdOf(f, rq) && (await writesSince(f, b0)) === 0, r);
      const rf = L(await e4.register(fresh));
      // The unbound request gets the bound one's answer, so the refusal is no existence oracle.
      c.check("Q4 (§E) an unbound register from that owner gets the same held{permission-denied, authorize} answer under its own coordinate, and stays unbound",
        rf.state === "held" && shape(rf) === shape(r) && rf.operationId === opIdOf(f, fresh) && (await opRecord(f, fresh.requestId)) === null, rf);
      grantActor(d4, { owner: f.owner, actor: "cli", scope: [], allowSubscribe: [], allowPublish: [] });
      c.check("Q4 once the row is back, the bound register completes", L(await e4.register(rq)).state === "registered");
    });
  } finally { await f.close(); }
}

// ---- U: a granter without a current interactive row is refused before any request-key read (r3a §E)
{
  const f = await fixture("s2a-next-authorize");
  try {
    const dir = ledger(f.owner), e = await engine(f, dir);
    const p1 = await registered(f, e), p2 = await registered(f, e), p3 = await registered(f, e);
    const ax = approveReq(f, p1), d1 = L(await e.handle(ax)).approval!.assignment.assignmentDigest;
    const d3 = L(await e.handle(approveReq(f, p3))).approval!.assignment.assignmentDigest;
    const rv = revoke(f.endpoint, p1.instanceId, d1, "owner-request", ownerOf(f)), rq = reg(f);
    await e.handle(rv); await e.register(rq);
    revokeActor(dir, f.owner, "cli");
    // Each kind: the bound request, a fresh one, and the bound requestId with another body.
    const kinds: Array<[string, Array<{ requestId: string; input: object }>, (r: { input: object }) => string[]]> = [
      ["register", [rq, reg(f), { ...rq, input: { ...rq.input, instanceId: rid() } }], (r) => [asg(f, (r.input as { instanceId: string }).instanceId), "svccap.space"]],
      ["decide", [ax, approveReq(f, p2), { ...ax, input: { ...ax.input, expectedProposalRevision: ax.input.expectedProposalRevision + 1 } }],
        (r) => [`svcprop.${(r.input as { proposalId: string }).proposalId}`]],
      ["revoke", [rv, revoke(f.endpoint, p3.instanceId, d3, "owner-request", ownerOf(f)), { ...rv, input: { ...rv.input, expectedAssignmentDigest: D("another") } }],
        (r) => [asg(f, (r.input as { instanceId: string }).instanceId), "svccap.space"]],
    ];
    for (const [kind, rqs, keysOf] of kinds) await cell(f, `U ${kind}`, async () => {
      const reads = countReads(f, rqs.flatMap((r) => [opKeyOf(f, r.requestId), ...keysOf(r)])), b0 = await lastSeqs(f), raws: unknown[] = [];
      for (const r of rqs) raws.push(kind === "register" ? await e.register(r) : await e.handle(r));
      reads.disarm();
      const rs = raws.map(L), names = ["bound", "unbound", "alternate-body"];
      if (kind !== "register") raws.forEach((r, k) => parsesClosed(`U ${kind} ${names[k]}`, r));
      c.check(`U (§E) one answer, field for field, for a bound, an unbound and an alternate-body ${kind} whose granter has no interactive row`,
        new Set(rs.map(shape)).size === 1 && new Set(raws.map((r) => Object.keys(r as object).sort().join())).size === 1, rs.map(shape));
      c.check(`U (§E) that ${kind} answer is held{permission-denied, authorize} under each request's own operation coordinate`, rs.every((r, k) => r.state === "held"
        && r.reason === "permission-denied" && r.phase === "authorize" && r.operationId === opIdOf(f, rqs[k])), rs);
      c.check(`U (§E) the ${kind} refusals read none of the requests' keys and write nothing`, reads.hits === 0 && (await writesSince(f, b0)) === 0, { reads: reads.hits });
    });
    await cell(f, "U structural", async () => {
      const b0 = await lastSeqs(f);
      const r1 = L(await e.register({ ...reg(f), granter: { kind: "owner", owner: other } }));
      const r2 = L(await e.handle(revoke(f.endpoint, p3.instanceId, d3, "operator-request", ownerOf(f))));
      c.check("U (structural) a request that can never bind (granter not the input owner; an owner granter on an operator cause) stays a zero-write permission-denied denial",
        r1.state === "denied" && r1.reason === "permission-denied" && r2.state === "denied" && r2.reason === "permission-denied" && (await writesSince(f, b0)) === 0, { r1, r2 });
    });
    await cell(f, "U restored", async () => {
      grantActor(dir, { owner: f.owner, actor: "cli", scope: [], allowSubscribe: [], allowPublish: [] });
      const ra = L(await e.handle(ax)), rg = L(await e.register(rq));
      c.check("U once the row is back, the bound requests replay their stored results", ra.state === "approved" && ra.outcome === "recorded"
        && rg.state === "registered" && rg.outcome === "recorded", { ra, rg });
    });
  } finally { await f.close(); }
}

// ---- S: write scope: the broker grant, concurrent first use, a discovery race, a wrong scope ---
{
  const f = await fixture("s2a-scope");
  try {
    const dir = ledger(f.owner), e = await engine(f, dir);
    const uidOf = (requestId: string) => async () => ((await opRecord(f, requestId))?.plan as { reservation: ServiceUidCustodyV1 }).reservation.native.lifecycleUid;
    const custodyWrites = (writes: WriteCall[]) => writes.filter((w) => w.bucket === "records" || /^(gate|cred|epgate)\./.test(w.key));
    await cell(f, "S1", async () => {
      const probe = await f.effect({ records: [], auth: ["probe.in"], authFamilies: [] }), kv = registryStores(probe.registry).authKv, before = f.violations.length;
      let inScope = false, outside = "";
      try {
        await kv.put("probe.in", bytesOf({ probe: 1 })); inScope = true;
        try { await kv.put("probe.out", bytesOf({ probe: 2 })); outside = "landed"; } catch (err) { outside = (err as Error).name; }
      } finally { await probe.close(); }
      const refusals = f.violations.splice(before);
      c.check("S1 (broker grant) an effect connection publishes its scope's key, and the broker refuses one outside it", inScope && outside !== "landed"
        && (await f.value(f.auth, "probe.in")) !== null && (await f.value(f.auth, "probe.out")) === null && refusals.some((v) => v.includes("probe.out")), { outside, refusals });
    });
    await cell(f, "S2", async () => {
      const p = await registered(f, e), req = approveReq(f, p);
      let winner: Loose | undefined;
      // The first use is lost: right before this invocation's binding create, the same request binds under its own fresh reservation and stops.
      f.faults.onWrite(W.binding(f, req.requestId), { before: async () => { winner = L(await stopAfter(f, dir, W.binding(f, req.requestId), (z) => z.handle(req))); } });
      const { r, writes } = await writing(f, () => e.handle(req)), lost = L(r), u = await uidOf(req.requestId)();
      c.check("S2 (I-7 first use) an approve that lost its concurrent first use holds scope-mismatch before custody, after only in-scope writes", winner?.state === "held"
        && lost.state === "held" && lost.reason === "scope-mismatch" && lost.phase === "A3-bootstrap" && lost.operationId === opIdOf(f, req)
        && custodyWrites(writes).length === 0 && (await f.value(f.records, uidReservationKey(u))) === null, { winner, lost, custody: custodyWrites(writes).map((w) => w.key) });
      c.check("S2 the stored operation records no custody step", ((await opRecord(f, req.requestId))?.progress as { state: string }).state === "admitted");
      const again = L(await e.handle(req)), gate = await gateOf(f, p.instanceId);
      c.check("S2 (D1) its replay discovers the stored reservation, scopes it and completes the one approval", again.state === "approved" && again.outcome === "applied"
        && again.approval?.assignment.lifecycleUid === u && gate?.approvalDigest === again.approval?.approvalDigest, { again: shape(again), gate });
    });
    await cell(f, "S3", async () => {
      const p = await registered(f, e), x = approveReq(f, p);
      await stopAfter(f, dir, W.approving(p.proposalId), (z) => z.handle(x));
      const digest = await digestAt(f, p.proposalId), rq = revoke(f.endpoint, p.instanceId, digest, "operator-request", operator);
      let ax: Loose | undefined;
      // The revoke's discovery finds no assignment; the approve completes right after that discovery's last read. Only the revoke's own writes are recorded.
      const writes: WriteCall[] = [];
      let mine = false;
      const spy = f.faults.onWrite((w) => { if (mine) writes.push(w); return false; }, {}, Number.MAX_SAFE_INTEGER);
      f.faults.onRead("auth", "svccap.space", async () => { ax = L(await e.handle(x)); mine = true; });
      const rv = L(await e.handle(rq));
      spy.disarm();
      c.check("S3 (I-7 discovery race) a revoke whose assignment landed after its discovery holds scope-mismatch before native cancel", ax?.state === "approved"
        && rv.state === "held" && rv.reason === "scope-mismatch" && rv.phase === "V3-cancel" && writes.length > 0 && custodyWrites(writes).length === 0
        && (await gateOf(f, p.instanceId))?.state === "approved", { ax: ax && shape(ax), rv, writes: writes.map((w) => w.key) });
      const again = L(await e.handle(rq));
      c.check("S3 (D1) its replay discovers the bound assignment and lands deny-new", again.state === "pending" && again.denyNew === "landed"
        && (await gateOf(f, p.instanceId))?.state === "revoked", again);
    });
    await cell(f, "S4", async () => {
      // Two reservations of one selector with different UIDs: a host scoped to one cannot bootstrap the other.
      const r = f.reservation(), other = f.reservation({ instanceId: r.assignment.instanceId });
      const keys = serviceCustodyKeys({ owner: f.owner, actor: other.assignment.actor, endpoint: other.assignment.endpoint, instanceId: other.assignment.instanceId,
        lifecycleUid: other.native.lifecycleUid }, "bootstrap");
      const eff = await f.effect(keys);
      try {
        const { host } = openServiceCustodyHost({ registry: eff.registry, hold: f.hold, accountPublicKey: f.accountPublicKey, writes: keys });
        const { r: boot, writes } = await writing(f, () => runServiceBootstrap(sealServiceBootstrapIntent(host, { reservation: r, notAfterMs: Date.now() + 60_000 })));
        c.check("S4 (wrong UID) a host scoped to another UID of the same selector holds scope-mismatch with no S1 write", boot.kind === "held"
          && boot.reason === "scope-mismatch" && writes.length === 0 && (await f.value(f.records, uidReservationKey(r.native.lifecycleUid))) === null, { boot, writes: writes.map((w) => w.key) });
      } finally { await eff.close(); }
    });
    await cell(f, "S5", async () => {
      const seen: Array<{ operation: string; records: readonly string[]; auth: readonly string[]; authFamilies: readonly string[]; frozen: boolean; ahead: number }> = [];
      const x = await engine(f, dir, { openEffect: (scope) => {
        seen.push({ operation: scope.operation, ...scope.keys, frozen: Object.isFrozen(scope) && Object.isFrozen(scope.keys) && Object.isFrozen(scope.keys.auth),
          ahead: scope.deadlineMs - Date.now() });
        return f.effect(scope.keys, scope.deadlineMs);
      } });
      const p = await registered(f, x), rq = approveReq(f, p), a = L(await x.handle(rq)), u = a.approval!.assignment.lifecycleUid;
      const rv = revoke(f.endpoint, p.instanceId, a.approval!.assignment.assignmentDigest, "owner-request", ownerOf(f)), v = L(await x.handle(rv));
      const q = await registered(f, x), rf = decide(q.proposalId, q.revision, f.name.revision, "refuse", ownerOf(f)), fr = L(await x.handle(rf));
      const head = lifecycleHeadKey(f.owner, serviceEndpointActor({ accountPublicKey: f.accountPublicKey, space: f.space, owner: f.owner, endpoint: f.endpoint, instanceId: p.instanceId }));
      const sel = (i: string) => [`svcasg.${f.endpoint.replaceAll(".", "_")}.${i}`, epgateKey(f.endpoint, i)];
      const same = (a1: readonly string[], b: string[]) => JSON.stringify([...a1].sort()) === JSON.stringify([...b].sort());
      const by = (op: string) => seen.filter((s) => s.operation === op);
      const [startup] = by("startup"), regs = by("register"), [dec, refuse] = by("decide"), [rev] = by("revoke");
      c.check("S5 every scope reached the effect frozen", seen.length > 0 && seen.every((s) => s.frozen), seen.length);
      c.check("S5 every scope carries its invocation's original deadline, at most the invocation limit ahead",
        seen.every((s) => s.ahead > 0 && s.ahead <= S2A_INVOCATION_MS), seen.map((s) => s.ahead));
      c.check("S5 startup's scope is the admission key alone", startup !== undefined && same(startup.auth, ["svchost.admission"]) && !startup.records.length && !startup.authFamilies.length, startup);
      const r0 = regs[0];
      c.check("S5 a register's scope is its operation, its proposal and the capacity row", regs.length === 2 && r0 !== undefined && r0.auth.length === 3
        && r0.auth.some((k) => /^svcop\.[0-9a-f]{32}$/.test(k)) && r0.auth.includes(`svcprop.${p.proposalId}`) && r0.auth.includes("svccap.space")
        && !r0.records.length && !r0.authFamilies.length, r0);
      c.check("S5 an approve's scope adds its selector and the bootstrap keys of its reservation", a.state === "approved" && dec !== undefined
        && same(dec.auth, [`svcop.${opIdOf(f, rq)}`, `svcprop.${p.proposalId}`, "svccap.space", ...sel(p.instanceId), `gate.${u}`])
        && same(dec.records, [uidReservationKey(u), head]) && same(dec.authFamilies, [`cred.${u}.`]), dec);
      c.check("S5 a revoke's scope has the cancel keys only: never the UID reservation", v.state === "pending" && rev !== undefined
        && same(rev.auth, [`svcop.${opIdOf(f, rv)}`, ...sel(p.instanceId), "svccap.space", `svcprop.${p.proposalId}`, `gate.${u}`])
        && same(rev.records, [head]) && same(rev.authFamilies, [`cred.${u}.`]), rev);
      c.check("S5 a refuse's scope is its operation, its proposal and the capacity row", fr.state === "refused" && refuse !== undefined
        && same(refuse.auth, [`svcop.${opIdOf(f, rf)}`, `svcprop.${q.proposalId}`, "svccap.space"]) && !refuse.records.length && !refuse.authFamilies.length, refuse);
    });
  } finally { await f.close(); }
}

// ---- V: an approval's caller ceiling pins its instance and admits only declared targets ----------
{
  const f = await fixture("s2a-ceiling");
  try {
    const dir = ledger(f.owner), e = await engine(f, dir);
    const poll = { ...command, name: "poll", targeted: true, modes: ["self"] };
    const base = reg(f), instanceId = base.input.instanceId;
    const p = await e.register({ ...base, input: { ...base.input, commands: [command, poll] } });
    if (p.state !== "registered") throw new Error(`fixture register failed: ${JSON.stringify(p)}`);
    const approve = (callerCeiling: unknown[]) => {
      const d = decide(p.proposalId, p.revision, f.name.revision, "approve", ownerOf(f));
      return { ...d, input: { ...d.input, callerCeiling } };
    };
    const pin = { endpoint: f.endpoint, instanceId, instanceOnly: true };
    for (const [label, entry] of [
      ["an entry without an instance", { endpoint: f.endpoint, command: "lookup" }],
      ["an entry pinned to another instance", { ...pin, instanceId: rid(), command: "lookup" }],
      ["an entry on this instance with class routes", { endpoint: f.endpoint, instanceId, command: "lookup" }],
      ["a target on an untargeted command", { ...pin, command: "lookup", target: { mode: "self" } }],
      ["no target on a targeted command", { ...pin, command: "poll" }],
      ["an owner-mode entry on a self-only command", { ...pin, command: "poll", target: { mode: "owner", tOwner: f.owner } }],
      ["an any entry", { ...pin, command: "poll", target: { mode: "any", tOwner: "*" } }],
      ["an undeclared command", { ...pin, command: "other" }],
    ] as const) {
      const d = approve([entry]), r = await e.handle(d);
      c.check(`V1 ${label} is refused bad-request before binding`, r.state === "denied" && r.reason === "bad-request" && (await opRecord(f, d.requestId)) === null, r);
    }
    const ok = approve([{ ...pin, command: "lookup" }, { ...pin, command: "poll", target: { mode: "self" } }]), r = await e.handle(ok);
    c.check("V2 instance-only entries pinned to this instance, in admitted modes, are approved", r.state === "approved" && r.outcome === "applied", r);
  } finally { await f.close(); }
}

// ---- W: serving: request reuse and the per-instance intent bound -----------------------------------
// The whole serving path through `serve`: the door's compiled registration, the approval, the native
// registration, activation and renew. No material is minted here (the door does that over `current`),
// so what these cells show is the engine: a reused request settles from its intent record every time
// and takes no index slot; only fresh request ids fill the 64-entry index.
{
  const f = await fixture("s2a-serve-intents");
  try {
    const dir = ledger(f.owner), store = await contractStoreContext(f.conn, f.space);
    const readContractArtifact = async (digest: string): Promise<unknown> => {
      const bytes = await fetchContractArtifact(store, contractRefToHex(digest));
      if (!bytes) throw new Error(`fixture: the contract artifact ${digest} is not readable`);
      return JSON.parse(new TextDecoder().decode(bytes));
    };
    const e = await engine(f, dir, { serving: { readContractArtifact } });
    // One self-contained cluster document, its closure, and the surface compiled as the door compiles it.
    const document = { urn: f.endpoint, revision: 1, attributes: [], events: [],
      commands: [{ name: "lookup", class: "ephemeral", targeted: false, capability: "read", inputDigest: VOID_SCHEMA_DIGEST, outputDigest: VOID_SCHEMA_DIGEST }] };
    const { manifest, closureDigest } = singleDocumentClosure(document);
    const compiled = compileServiceRegistration({ clusterDigests: [closureDigest], contractArtifacts: [manifest, document] });
    const instanceId = rid(), sel = { owner: f.owner, endpoint: f.endpoint, instanceId };
    const door = { space: f.space, accountPublicKey: f.accountPublicKey };
    const engineId = (operation: ServiceServeOperation, requestId: string) => serviceAuthorityEngineRequestId(door, f.owner, sel, operation, requestId);
    const indexOf = async () => {
      const raw = await f.value(f.auth, `svcintx.${endpointToken(f.endpoint)}.${instanceId}`);
      return raw === null ? [] : parseServiceRequestIntentIndexRecord(raw).intents;
    };
    const serve = (operation: ServiceServeOperation, requestId: string, witness: ServiceRegistrationWitness | null, extra: Partial<ServiceServeRequest> = {}) =>
      e.serve({ operation, caller: operation === "renew" || operation === "ready" ? "service" : "owner", ...sel, requestId, requestDigest: D(`serve ${operation} ${requestId}`),
        engineRequestId: engineId(operation, requestId), witness, ...extra });
    // The proposal phase and the registration share one public request, as the door sends them.
    const registerId = rid(), registerDigest = D(`serve register ${registerId}`);
    const proposal = L(await e.register(serviceRegisterHostRequest({ ...sel, engineRequestId: engineId("register", registerId), requestId: registerId, requestDigest: registerDigest, ...compiled })));
    const approval = L(await e.handle(approveReq(f, { proposalId: proposal.proposalId!, revision: proposal.revision! })));
    if (proposal.state !== "registered" || approval.state !== "approved") throw new Error(`fixture approval failed: ${JSON.stringify({ proposal, approval })}`);
    const registered = await serve("register", registerId, null, { register: { ...compiled, artifacts: [manifest, document] } });
    const w = registered.state === "registered" ? registered.witness : undefined;
    c.check("W0 the approved register replayed through serve registers natively and answers the witness", w !== undefined && w.registrationRequestId === registerId, registered);
    if (w === undefined) throw new Error("fixture registration failed");
    const activateId = rid(), activated = await serve("activate", activateId, w);
    c.check("W0 activate lands the activation CAS and answers current with the root and approval bounds",
      activated.state === "current" && serviceWitnessDigest(activated.witness) === serviceWitnessDigest(w) && activated.rootExpiresAt > Math.floor(Date.now() / 1000), activated);
    const digestOf = (r: { state: string; witness?: ServiceRegistrationWitness }) => (r.witness ? serviceWitnessDigest(r.witness) : undefined);
    const current = (r: { state: string; witness?: ServiceRegistrationWitness }) => r.state === "current" && digestOf(r) === serviceWitnessDigest(w);

    await cell(f, "W1", async () => {
      // One renew request, as a serving client keeps it: the same requestId and body, replayed on every refresh.
      const renewId = rid(), renew = () => serve("renew", renewId, w);
      const replies: string[] = [];
      for (let n = 0; n < 80; n++) { const r = await renew(); replies.push(current(r) ? "current" : JSON.stringify(r)); }
      const idx = await indexOf(), ids = new Set(idx.map((x) => x.operationId));
      const expected = [["register", registerId], ["activate", activateId], ["renew", renewId]] as const;
      c.check("W1 (serve) one renew request replayed 80 times answers current with the current witness every time", replies.every((r) => r === "current"),
        replies.filter((r) => r !== "current").slice(0, 3));
      c.check("W1 after 80 replays the instance index lists exactly the register, activate and renew ids: a reused request takes no slot",
        idx.length === 3 && expected.every(([op, id]) => ids.has(serviceHostOperationId(f.space, engineId(op, id)))), idx);
      // ready is reused the same way: the same request settles from its intent and writes the status again.
      const readyId = rid(), ready = () => serve("ready", readyId, w);
      const readies: string[] = [];
      for (let n = 0; n < 10; n++) { const r = await ready(); readies.push(r.state === "ready" && digestOf(r) === serviceWitnessDigest(w) ? "ready" : JSON.stringify(r)); }
      c.check("W1 one ready request replayed 10 times answers ready every time and adds one index entry", readies.every((r) => r === "ready") && (await indexOf()).length === 4,
        { readies: readies.filter((r) => r !== "ready").slice(0, 3), n: (await indexOf()).length });
    });

    await cell(f, "W2", async () => {
      // A client that draws a fresh requestId per refresh: every one takes a slot until the bound.
      const fresh: string[] = [];
      let count = (await indexOf()).length, last: unknown;
      while (count < S3_MAX_INTENTS_PER_INSTANCE) {
        const id = rid(), r = await serve("renew", id, w);
        if (!current(r)) { last = r; break; }
        fresh.push(id); count = (await indexOf()).length;
      }
      const b0 = await lastSeqs(f), overId = rid(), over = L(await serve("renew", overId, w));
      const overIntent = await f.value(f.auth, `svcint.${serviceHostOperationId(f.space, engineId("renew", overId))}`);
      c.check("W2 (serve) distinct renew requests fill the index to 64, each answering current", count === S3_MAX_INTENTS_PER_INSTANCE && last === undefined, { count, last });
      c.check("W2 the 65th distinct request is denied resource-exhausted with zero writes: no intent and no effect", over.state === "denied" && over.reason === "resource-exhausted"
        && (await writesSince(f, b0)) === 0 && overIntent === null && (await indexOf()).length === S3_MAX_INTENTS_PER_INSTANCE, over);
      const listed = await serve("renew", fresh[0]!, w), reused = await serve("renew", fresh[fresh.length - 1]!, w);
      c.check("W2 a listed request still replays from its intent record at the bound", current(listed) && current(reused) && (await indexOf()).length === S3_MAX_INTENTS_PER_INSTANCE,
        { listed: listed.state, reused: reused.state });
    });
  } finally { await f.close(); }
}

c.check("S (broker grants) no effect or discovery connection of this suite was refused a publish", fixtures.every((f) => f.violations.length === 0),
  fixtures.flatMap((f) => f.violations));
for (const d of ledgers) rmSync(d, { recursive: true, force: true });
console.log(`service-host-ops: ${c.passed} passed, ${c.failed} failed (owned-broker fixture evidence only)`);
c.finish();
if (c.failed) process.exitCode = 1;
