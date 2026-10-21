/** Owned-broker suite for the dormant service host operations. Every section runs a real
 * nats-server process through the custody fixture (its genuine plane-claim hold, account, service
 * name and fault hooks). Records a test writes directly are labelled as simulations; nothing here is
 * native, Cloud or production acceptance, and nothing proves a human decision. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { canonicalJson, contractDigest, epgateKey, uidReservationKey } from "@cotal-ai/core";
import { grantActor, revokeActor } from "../src/ledger.js";
import { openLifecycleRegistry } from "../src/lifecycle-registry.js";
import { parseServiceHostResult } from "../src/service-host-contract.js";
import { openServiceHostOperations, serviceHostOperationId, type ServiceHostOperations, type ServiceHostOperationsOptions } from "../src/service-host-ops.js";
import { bytesOf, checks, openFixture, type Fixture } from "./_service-custody-fixture.js";

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

async function engine(f: Fixture, dir: string, over: Partial<ServiceHostOperationsOptions> = {}): Promise<ServiceHostOperations> {
  return openServiceHostOperations({ discovery: f.reg, openEffect: async () => ({ registry: f.reg, close: async () => {} }), hold: f.hold,
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
  const f = await openFixture("s2a-register");
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
    await f.auth.update("svccap.space", bytesOf({ v: 1, kind: "service-proposal-capacity", pending: fill(256, Date.now() - 1, other) }), capRev);
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
  const f = await openFixture("s2a-approve");
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
  const f = await openFixture("s2a-revoke");
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
    c.check("C1 the tripped engine refuses new invocations", (await e1.handle(req)).state === "denied");
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
  const f = await openFixture("s2a-refuse");
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
  const f = await openFixture("s2a-expiry");
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
  const f = await openFixture("s2a-construct");
  try {
    const dir = ledger(f.owner);
    const refuses = async (over: Partial<ServiceHostOperationsOptions>) => { try { await engine(f, dir, over); return false; } catch { return true; } };
    c.check("F1 (S-34) construction without a startup kind refuses", await refuses({ startup: undefined }));
    c.check("F1 (S-34) restore startup refuses", await refuses({ startup: { kind: "restore", restoreId: "a".repeat(32) } }));
    let opened = 0, closed = 0;
    const e = await engine(f, dir, { openEffect: async () => {
      opened++;
      const nc = await connect({ servers: f.conn.getServer(), reconnect: false, name: "s2a-effect" });
      const registry = await openLifecycleRegistry(nc, f.space);
      return { registry, close: async () => { closed++; await nc.close(); } };
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
  const f = await openFixture("s2a-schedules");
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
      const [x, y] = await Promise.all([e.handle(req), e2.handle(req)]);
      const gate = await f.value(f.auth, epgateKey(f.endpoint, p.instanceId));
      c.check("G1 (S-2) concurrent identical approves: one binding, one approval, both report it",
        x.state === "approved" && y.state === "approved" && x.approval.approvalDigest === y.approval.approvalDigest
          && (gate?.serviceAuthority as Record<string, unknown>)?.approvalDigest === x.approval.approvalDigest, { x: x.state, y: y.state });
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

for (const d of ledgers) rmSync(d, { recursive: true, force: true });
console.log(`service-host-ops: ${c.passed} passed, ${c.failed} failed (owned-broker fixture evidence only)`);
if (c.failed) process.exitCode = 1;
