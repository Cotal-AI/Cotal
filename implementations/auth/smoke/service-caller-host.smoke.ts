/** Owned-broker suite for caller policy through the service host: caller-grant, caller-revoke up to
 * deny-new and its cutoff marker, the two policy reads and the payload precondition. Every section
 * runs a real nats-server through the custody fixture in operator mode, with the product discovery
 * and effect credentials. Stock builds no operator assertion pass, so each asserted precondition
 * record here is a simulation, labelled as such, like every other record a test writes directly.
 * Nothing here is native, Cloud or production acceptance, and nothing proves a human decision. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jetstreamManager } from "@nats-io/jetstream";
import { headers } from "@nats-io/transport-node";
import { SERVICE_AUTHORITY_MAX_BYTES, contractDigest, epAuthBucket } from "@cotal-ai/core";
import { findInteractiveActor, grantActor } from "../src/ledger.js";
import { SERVICE_CALLER_PAYLOAD_FLOOR, SERVICE_CALLER_PAYLOAD_OVERHEAD } from "../src/service-caller-payload.js";
import { parseServiceHostResult } from "../src/service-host-contract.js";
import { openServiceHostOperations, serviceHostOperationId, serviceMarkerCeilSeconds, type ServiceHostOperations } from "../src/service-host-ops.js";
import { bytesOf, checks, openFixture, type Fixture } from "./_service-custody-fixture.js";

const c = checks();
const rid = () => randomBytes(16).toString("hex");
const D = (s: string) => contractDigest({ fixture: s });
const lookup = { name: "lookup", clusterDigest: D("cluster"), class: "ephemeral", targeted: false, modes: [], capability: "read", inputDigest: D("in"), outputDigest: D("out"), traits: [] };
const poll = { ...lookup, name: "poll", targeted: true, modes: ["self"] };
const other = `u_${"d".repeat(26)}`, third = `u_${"e".repeat(26)}`, stranger = `u_${"f".repeat(26)}`;
const operator = { kind: "operator", auditId: "fixture-operator" };
const ownerOf = (o: string) => ({ kind: "owner", owner: o });
type R = { state: string; reason?: string; operationId?: string; phase?: string; notBefore?: number; denyNew?: string; revision?: number;
  grant?: { grantId: string; status: Record<string, unknown>; source: { kind: string; owner?: string }; parentRefs: unknown[] };
  record?: { value: { grants: Array<{ grantId: string }>; service: unknown; target?: unknown; operation?: string }; revision: number };
  records?: Array<{ value: { grantee: { lifecycleUid: string }; grants: unknown[] } }>; nextCursor?: string | null };

const ledgers: string[] = [];
const ledger = (...owners: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), "s3a-ledger-"));
  ledgers.push(dir);
  for (const o of owners) grantActor(dir, { owner: o, actor: "cli", scope: [], allowSubscribe: [], allowPublish: [] });
  return dir;
};
const principal = (dir: string, owner: string, actor = "cli") => {
  if (findInteractiveActor(dir, owner, actor) === undefined) grantActor(dir, { owner, actor, scope: [], allowSubscribe: [], allowPublish: [] });
  return { owner, actor, lifecycleUid: findInteractiveActor(dir, owner, actor)!.lifecycleUid! };
};
const fixtures: Fixture[] = [];
const fixture = async (space: string, maxPayload?: number) => {
  const f = await openFixture(space, { limited: true, ...(maxPayload === undefined ? {} : { maxPayload }) }); fixtures.push(f); return f;
};
async function engine(f: Fixture, dir: string): Promise<ServiceHostOperations> {
  const d = await f.discovery();
  return openServiceHostOperations({ discovery: d.registry, openEffect: (scope) => f.effect(scope.keys, scope.deadlineMs), hold: f.hold,
    accountPublicKey: f.accountPublicKey, ledgerDir: dir, startup: { kind: "normal" } });
}
const handle = async (e: ServiceHostOperations, req: object) => (await e.handle(req)) as unknown as R;
const parsesClosed = (label: string, r: unknown) => {
  let ok = true, detail: unknown;
  try { parseServiceHostResult(r); } catch (err) { ok = false; detail = (err as Error).message; }
  c.check(`${label}: the result passes the closed result parser`, ok, detail);
};
const opRecord = (f: Fixture, requestId: string) => f.value(f.auth, `svcop.${serviceHostOperationId(f.space, requestId)}`);
const policyOf = (f: Fixture, uid: string) => f.value(f.auth, `servicepolicy.${uid}`);
const indexOf = (f: Fixture, instanceId: string) => f.value(f.auth, `svcpolx.${f.endpoint.replaceAll(".", "_")}.${instanceId}`);

/** Simulation: the operator's cluster-wide assertion pass, which stock does not build, records the precondition. */
async function assertPrecondition(f: Fixture) {
  const row = { v: 1, kind: "service-caller-payload", state: "asserted", floor: SERVICE_CALLER_PAYLOAD_FLOOR, assertedAtMs: Date.now(), evidenceDigest: D("varz") };
  const cur = await f.auth.get("svchost.payload");
  if (cur && cur.operation === "PUT") await f.auth.update("svchost.payload", bytesOf(row), cur.revision);
  else await f.auth.create("svchost.payload", bytesOf(row));
}
/** Simulation: another writer withdrew the precondition. */
async function withdrawPrecondition(f: Fixture) {
  const cur = (await f.auth.get("svchost.payload"))!;
  await f.auth.update("svchost.payload", bytesOf({ v: 1, kind: "service-caller-payload", state: "withdrawn", reason: "live-check", operationId: null, atMs: Date.now() }), cur.revision);
}
/** Simulation: rewrite one field set of a stored live operation record. */
async function rewriteOp(f: Fixture, requestId: string, patch: Record<string, unknown>) {
  const key = `svcop.${serviceHostOperationId(f.space, requestId)}`, cur = (await f.auth.get(key))!;
  await f.auth.update(key, bytesOf({ ...JSON.parse(new TextDecoder().decode(cur.value)), ...patch }), cur.revision);
}

/** One registered and approved instance of the fixture's endpoint, with a ceiling pinned to it. */
async function approved(f: Fixture, e: ServiceHostOperations) {
  const instanceId = rid();
  const p = await e.register({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "register", granter: ownerOf(f.owner),
    input: { owner: f.owner, endpoint: f.endpoint, instanceId, clusterDigests: [D("cluster")], commands: [lookup, poll] } });
  if (p.state !== "registered") throw new Error(`fixture register failed: ${JSON.stringify(p)}`);
  const pinned = { endpoint: f.endpoint, instanceId, instanceOnly: true };
  const a = await handle(e, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "decide", granter: ownerOf(f.owner),
    input: { proposalId: p.proposalId, expectedProposalRevision: p.revision, expectedNameRevision: f.name.revision, decision: "approve",
      callerCeiling: [{ ...pinned, command: "lookup" }, { ...pinned, command: "poll", target: { mode: "self" } }] } }) as R & { approval?: { approvalDigest: string } };
  if (a.state !== "approved") throw new Error(`fixture approve failed: ${JSON.stringify(a)}`);
  return { selector: { endpoint: f.endpoint, instanceId }, service: { endpoint: f.endpoint, instanceId, approvalDigest: a.approval!.approvalDigest } };
}
const pin = (sel: { endpoint: string; instanceId: string }, command: string, target?: object) =>
  ({ endpoint: sel.endpoint, command, instanceId: sel.instanceId, instanceOnly: true, ...(target ? { target } : {}) });
const grantReq = (service: object, grantee: object, capabilities: unknown[], expectedPolicyRevision: number, granter: object, requestId = rid()) =>
  ({ v: 1, kind: "service-endpoint-host", requestId, operation: "caller-grant", granter, input: { grantee, service, capabilities, expectedPolicyRevision } });
const revokeReq = (grantee: object, grantId: string, expectedPolicyRevision: number, granter: object, requestId = rid()) =>
  ({ v: 1, kind: "service-endpoint-host", requestId, operation: "caller-revoke", granter, input: { grantee, grantId, expectedPolicyRevision } });
const readReq = (grantee: object, service: object | null, granter: object) =>
  ({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "caller-policy-read", granter, input: { grantee, service } });
const listReq = (service: object | null, granter: object, over: { owner?: string | null; cursor?: string | null; limit?: number } = {}) =>
  ({ v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "caller-policy-list", granter,
    input: { owner: over.owner ?? null, cursor: over.cursor ?? null, limit: over.limit ?? 50, service } });
const revisionOf = async (f: Fixture, key: string) => (await f.auth.get(key))?.revision ?? 0;

// ---- T: the marker time grammar (pure) -------------------------------------------------------------
{
  const at = (s: string) => serviceMarkerCeilSeconds(s);
  c.check("T1 one nanosecond past a whole second rounds up", at("2026-01-01T00:00:00.000000001Z") === 1_767_225_601);
  c.check("T1 a whole second and an all-zero fraction stay", at("2026-01-01T00:00:00Z") === 1_767_225_600 && at("2026-01-01T00:00:00.000Z") === 1_767_225_600);
  for (const [label, s] of [["an offset", "2026-01-01T00:00:00+01:00"], ["ten fractional digits", "2026-01-01T00:00:00.0000000001Z"],
    ["a 30 February", "2026-02-30T00:00:00Z"], ["a leap second", "2026-12-31T23:59:60Z"], ["a lowercase zone", "2026-01-01T00:00:00z"],
    ["a two-digit year", "0050-01-01T00:00:00Z"], ["no zone", "2026-01-01T00:00:00"]] as const)
    c.check(`T2 ${label} is not a readable marker time`, at(s) === undefined, s);
}

// ---- P: the payload precondition on a broker at the default max_payload ----------------------------
{
  const f = await fixture("s3a-payload");
  try {
    const dir = ledger(f.owner, other), e = await engine(f, dir), svc = await approved(f, e), g = principal(dir, other);
    const h = headers(); h.set("Nats-Expected-Last-Subject-Sequence", String(Number.MAX_SAFE_INTEGER));
    const hdr = (h as unknown as { encode(): Uint8Array }).encode().length;
    c.check("P0 the measured header block of a policy create or CAS, at the largest revision, is within O", hdr > 0 && hdr <= SERVICE_CALLER_PAYLOAD_OVERHEAD, hdr);
    c.check("P0 the floor is the row bound plus O", SERVICE_CALLER_PAYLOAD_FLOOR === SERVICE_AUTHORITY_MAX_BYTES + SERVICE_CALLER_PAYLOAD_OVERHEAD);
    c.check("P0 this owned broker runs at the default max_payload of 1 MiB, below the floor", f.conn.info?.max_payload === 1_048_576, f.conn.info?.max_payload);
    const r1 = grantReq(svc.service, g, [pin(svc.selector, "lookup")], 0, ownerOf(f.owner)), a1 = await handle(e, r1);
    c.check("P1-1 with no precondition record, caller-grant is denied unsupported with zero writes", a1.state === "denied" && a1.reason === "unsupported"
      && (await opRecord(f, r1.requestId)) === null && (await policyOf(f, g.lifecycleUid)) === null && (await indexOf(f, svc.selector.instanceId)) === null, a1);
    await assertPrecondition(f);
    const r2 = grantReq(svc.service, g, [pin(svc.selector, "lookup")], 0, ownerOf(f.owner)), a2 = await handle(e, r2);
    const rec = await f.value(f.auth, "svchost.payload");
    c.check("P1-3 (simulated assertion) a live check below the floor denies unsupported and withdraws the record durably", a2.state === "denied" && a2.reason === "unsupported"
      && rec?.state === "withdrawn" && rec?.reason === "live-check" && (await opRecord(f, r2.requestId)) === null, { a2, rec });
    const rd = await handle(e, readReq(g, null, ownerOf(other)));
    c.check("P1-1 policy reads stay available while the precondition fails", rd.state === "absent", rd);
    for (const [label, r] of [["P1-1", a1], ["P1-3", a2], ["P1-1 read", rd]] as const) parsesClosed(label, r);
  } finally { await f.close(); }
}

// ---- G, R, Q: grants, revokes and reads on a broker above the floor --------------------------------
{
  const f = await fixture("s3a-grant", 4 * 1024 * 1024);
  try {
    const dir = ledger(f.owner, other, third), e = await engine(f, dir), svc = await approved(f, e);
    await assertPrecondition(f);
    const g = principal(dir, other), mine = principal(dir, f.owner, "reader");
    c.check("G0 this owned broker admits the floor", (f.conn.info?.max_payload ?? 0) >= SERVICE_CALLER_PAYLOAD_FLOOR, f.conn.info?.max_payload);

    const r1 = grantReq(svc.service, g, [pin(svc.selector, "lookup"), pin(svc.selector, "poll", { mode: "self" })], 0, ownerOf(f.owner));
    const a1 = await handle(e, r1), grantId = a1.grant?.grantId ?? "";
    const row1 = await policyOf(f, g.lifecycleUid), idx1 = await indexOf(f, svc.selector.instanceId);
    c.check("G-1 an interactive owner grants an interactive grantee within the ceiling", a1.state === "granted" && a1.grant?.status.state === "active"
      && a1.grant.source.kind === "service-owner" && a1.grant.source.owner === f.owner && a1.grant.parentRefs.length === 0, a1);
    c.check("G-1 the row holds the grant and the instance index its entry", (row1?.grants as unknown[])?.length === 1
      && JSON.stringify(idx1?.entries) === JSON.stringify([{ granteeUid: g.lifecycleUid, grantId }]), { row1, idx1 });
    c.check("G-1 the grant operation compacted to a terminal complete record", (await opRecord(f, r1.requestId))?.kind === "service-host-operation-terminal");
    const a1b = await handle(e, r1);
    c.check("G-1 a replay returns the stored grant and revision", JSON.stringify(a1b) === JSON.stringify(a1), a1b);
    let rev = a1.revision ?? 0;

    const denials: Array<[string, object, string]> = [
      ["G-2 an owner that does not hold the assignment", grantReq(svc.service, g, [pin(svc.selector, "lookup")], rev, ownerOf(third)), "not-found"],
      ["G-3 an approval digest that is not the gate's", grantReq({ ...svc.service, approvalDigest: D("other-approval") }, g, [pin(svc.selector, "lookup")], rev, ownerOf(f.owner)), "conflict"],
      ["G-4 a mode outside the ceiling", grantReq(svc.service, g, [pin(svc.selector, "poll", { mode: "owner", tOwner: other })], rev, ownerOf(f.owner)), "permission-denied"],
      ["G-4 an any target", grantReq(svc.service, g, [pin(svc.selector, "poll", { mode: "any", tOwner: "*" })], rev, ownerOf(f.owner)), "permission-denied"],
      ["G-4 journal access", grantReq(svc.service, g, [{ ...pin(svc.selector, "lookup"), journal: true }], rev, ownerOf(f.owner)), "unsupported"],
      ["G-4 class routes", grantReq(svc.service, g, [{ endpoint: f.endpoint, command: "lookup", instanceId: svc.selector.instanceId }], rev, ownerOf(f.owner)), "bad-request"],
      ["G-4 another instance", grantReq(svc.service, g, [pin({ ...svc.selector, instanceId: rid() }, "lookup")], rev, ownerOf(f.owner)), "bad-request"],
      ["G-4 an empty capability list", grantReq(svc.service, g, [], rev, ownerOf(f.owner)), "bad-request"],
      ["G-5 a grantee uid that is not the ledger row's", grantReq(svc.service, { ...g, lifecycleUid: principal(dir, third).lifecycleUid }, [pin(svc.selector, "lookup")], rev, ownerOf(f.owner)), "not-found"],
      ["G-5 a grantee with no ledger row", grantReq(svc.service, { ...g, actor: "nobody" }, [pin(svc.selector, "lookup")], rev, ownerOf(f.owner)), "not-found"],
      ["G-6 a stale expected policy revision", grantReq(svc.service, g, [pin(svc.selector, "lookup")], 0, ownerOf(f.owner)), "conflict"],
      ["G-6 the bound request id with another body", { ...r1, input: { ...r1.input, capabilities: [pin(svc.selector, "lookup")] } }, "conflict"],
    ];
    for (const [label, req, reason] of denials) {
      const r = await handle(e, req), same = (req as { requestId: string }).requestId === r1.requestId;
      c.check(`${label} is denied ${reason} with no binding`, r.state === "denied" && r.reason === reason && (same || (await opRecord(f, (req as { requestId: string }).requestId)) === null), r);
      parsesClosed(label, r);
    }
    const unauth = grantReq(svc.service, g, [pin(svc.selector, "lookup")], rev, ownerOf(stranger)), u = await handle(e, unauth);
    c.check("G-2 a granter with no interactive row holds permission-denied at authorize, under the request's coordinate", u.state === "held" && u.reason === "permission-denied"
      && u.phase === "authorize" && u.operationId === serviceHostOperationId(f.space, unauth.requestId) && (await opRecord(f, unauth.requestId)) === null, u);
    c.check("G-6 the denials wrote nothing to the row", (await revisionOf(f, `servicepolicy.${g.lifecycleUid}`)) === rev);

    // I-10: the precondition withdrawn after binding holds the bound grant before G4; nothing is issued.
    const r3 = grantReq(svc.service, mine, [pin(svc.selector, "lookup")], 0, ownerOf(f.owner));
    const arm3 = f.faults.onWrite((w) => w.key === `svcop.${serviceHostOperationId(f.space, r3.requestId)}` && w.kind === "create", { after: async () => withdrawPrecondition(f) });
    const a3 = await handle(e, r3);
    c.check("I-10 (simulated withdrawal) a bound grant holds payload-precondition before G4, with no index or policy write", arm3.hits === 1 && a3.state === "held"
      && a3.reason === "payload-precondition" && (await policyOf(f, mine.lifecycleUid)) === null && (await indexOf(f, svc.selector.instanceId))?.entries instanceof Array
      && ((await indexOf(f, svc.selector.instanceId))!.entries as unknown[]).length === 1, a3);
    parsesClosed("I-10", a3);
    await assertPrecondition(f);
    const a3b = await handle(e, r3);
    c.check("I-10 once the precondition is asserted again, the same attempt replays to granted", a3b.state === "granted", a3b);

    // E2-5: past notAfterMs with nothing issued, a replay settles refused expired without a positive write.
    const late = principal(dir, f.owner, "late"), r4 = grantReq(svc.service, late, [pin(svc.selector, "lookup")], 0, ownerOf(f.owner));
    const arm4 = f.faults.onWrite((w) => w.key === `svcop.${serviceHostOperationId(f.space, r4.requestId)}` && w.kind === "create", { after: async () => withdrawPrecondition(f) });
    const a4 = await handle(e, r4);
    const admitted = ((await opRecord(f, r4.requestId))?.admittedAtMs as number) ?? 0;
    await rewriteOp(f, r4.requestId, { notAfterMs: admitted });   // simulation: the operation's window has passed
    await assertPrecondition(f);
    const idxBefore = ((await indexOf(f, svc.selector.instanceId))!.entries as unknown[]).length;
    const a4b = await handle(e, r4);
    c.check("E2-5 (simulated window) with no write issued and the grant absent, a replay past notAfterMs settles refused expired", arm4.hits === 1 && a4.state === "held"
      && a4b.state === "refused" && a4b.reason === "expired" && (await policyOf(f, late.lifecycleUid)) === null
      && ((await indexOf(f, svc.selector.instanceId))!.entries as unknown[]).length === idxBefore, { a4, a4b });

    // P2-1: an open issued append stays unknown until its key moves; then it settles as did not land.
    const open5 = principal(dir, f.owner, "open"), r5 = grantReq(svc.service, open5, [pin(svc.selector, "lookup")], 0, ownerOf(f.owner));
    const arm5 = f.faults.onWrite((w) => w.key === `svcop.${serviceHostOperationId(f.space, r5.requestId)}` && w.kind === "create", { after: async () => withdrawPrecondition(f) });
    await handle(e, r5);
    await rewriteOp(f, r5.requestId, { progress: { state: "issued", step: "G5-append", key: `servicepolicy.${open5.lifecycleUid}`, atRevision: 0 } });   // simulation
    await assertPrecondition(f);
    const a5 = await handle(e, r5);
    c.check("E2-2 (simulated record) an open issued append with its key unmoved holds outcome-unknown, never expired or granted", arm5.hits === 1 && a5.state === "held"
      && a5.reason === "outcome-unknown" && (await policyOf(f, open5.lifecycleUid)) === null, a5);
    const r6 = grantReq(svc.service, open5, [pin(svc.selector, "lookup")], 0, ownerOf(f.owner)), a6 = await handle(e, r6);
    const a5b = await handle(e, r5);
    c.check("P2-1 once another grant moves the key, the open append settles as did not land and the attempt refuses conflict", a6.state === "granted"
      && a5b.state === "refused" && a5b.reason === "conflict", { a6, a5b });

    // R-1: the source owner revokes.
    rev = await revisionOf(f, `servicepolicy.${g.lifecycleUid}`);
    const k1 = revokeReq(g, grantId, rev, ownerOf(f.owner)), y = serviceHostOperationId(f.space, k1.requestId);
    const ka = await handle(e, k1);
    const jsm = await jetstreamManager(f.conn), bucket = epAuthBucket(f.space);
    const sm = await jsm.streams.getMessage(`KV_${bucket}`, { last_by_subj: `$KV.${bucket}.svccut.${y}` });
    const t = serviceMarkerCeilSeconds(sm?.timestamp);
    const status1 = ((await policyOf(f, g.lifecycleUid))?.grants as Array<{ grantId: string; status: unknown }>).find((x) => x.grantId === grantId)?.status;
    c.check("R-1 the source owner's revoke answers pending cutoff-wait with deny-new landed, under its own op", ka.state === "pending" && ka.phase === "cutoff-wait"
      && ka.denyNew === "landed" && ka.operationId === y, ka);
    c.check("R-1 notBefore is ceil(T) + 71 from the marker's stored server time", t !== undefined && ka.notBefore === t + 71, { t, ts: sm?.timestamp, ka });
    c.check("R-1 the grant records the op-bound marker and its deadline", JSON.stringify(status1) === JSON.stringify({ state: "revoking", operationId: y, markerKey: `svccut.${y}`,
      markerRevision: sm?.seq, notBefore: ka.notBefore }), status1);
    const kb = await handle(e, k1);
    c.check("R-1 a replay keeps the same deadline", kb.state === "pending" && kb.notBefore === ka.notBefore, kb);
    parsesClosed("R-1", ka);
    let refusedArm = false;
    try { parseServiceHostResult({ v: 1, kind: "service-endpoint-host", operation: "caller-revoke", requestId: rid(), space: f.space, accountPublicKey: f.accountPublicKey,
      state: "revoked", grantId, operationId: y, revision: 1 }); } catch { refusedArm = true; }
    c.check("R-2 the stock result parser refuses a caller-revoke revoked arm", refusedArm);
    const opv = await handle(e, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "operation-read", granter: ownerOf(f.owner), input: { operationId: y } });
    c.check("R-1 operation-read shows the caller target and a pending phase", opv.state === "present" && JSON.stringify(opv.record?.value.target) === JSON.stringify({ kind: "caller", grantee: g }), opv);
    parsesClosed("R-1 operation-read", opv);

    // R-4: a fresh revoke adopts the bound operation's marker.
    const k2 = revokeReq(g, grantId, 0, operator), kc = await handle(e, k2), y2 = serviceHostOperationId(f.space, k2.requestId);
    c.check("R-4 a second revoke adopts: pending under its own op with the same deadline, and no second marker", kc.state === "pending" && kc.operationId === y2
      && kc.notBefore === ka.notBefore && (await f.value(f.auth, `svccut.${y2}`)) === null, kc);
    const k3 = await handle(e, revokeReq(g, grantId, 0, ownerOf(third)));
    c.check("R-3 an owner that is neither the source nor the grantee owner gets not-found", k3.state === "denied" && k3.reason === "not-found", k3);

    // E-1: the grantee owner relinquishes a grant it holds.
    rev = await revisionOf(f, `servicepolicy.${g.lifecycleUid}`);
    const a7 = await handle(e, grantReq(svc.service, g, [pin(svc.selector, "lookup")], rev, ownerOf(f.owner)));
    const k4 = revokeReq(g, a7.grant?.grantId ?? "", a7.revision ?? 0, ownerOf(other)), kd = await handle(e, k4);
    c.check("E-1 the grantee owner's relinquishment is admitted and lands deny-new", a7.state === "granted" && kd.state === "pending" && kd.denyNew === "landed", { a7, kd });
    const own = await handle(e, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "operation-read", granter: ownerOf(other),
      input: { operationId: serviceHostOperationId(f.space, k4.requestId) } });
    c.check("E-1 the relinquishing granter reads its own operation", own.state === "present", own);

    // CO-1: Y discovers the grant active; X lands deny-new first; Y reopens once for X's marker.
    rev = await revisionOf(f, `servicepolicy.${g.lifecycleUid}`);
    const a8 = await handle(e, grantReq(svc.service, g, [pin(svc.selector, "lookup")], rev, ownerOf(f.owner)));
    const g8 = a8.grant?.grantId ?? "", rev8 = a8.revision ?? 0;
    const yReq = revokeReq(g, g8, rev8, ownerOf(f.owner)), xReq = revokeReq(g, g8, rev8, operator);
    const yOp = serviceHostOperationId(f.space, yReq.requestId), xOp = serviceHostOperationId(f.space, xReq.requestId);
    let xa: R | undefined;
    const arm8 = f.faults.onWrite((w) => w.key === `svcop.${yOp}` && w.kind === "create", { after: async () => { xa = await handle(e, xReq); } });
    const ya = await handle(e, yReq);
    const status8 = ((await policyOf(f, g.lifecycleUid))?.grants as Array<{ grantId: string; status: { operationId?: string } }>).find((x) => x.grantId === g8)?.status;
    c.check("CO-1 Y reopens once for X's marker and answers pending under its own op, with X's deadline", arm8.hits === 1 && xa?.state === "pending" && ya.state === "pending"
      && ya.operationId === yOp && ya.notBefore === xa?.notBefore && status8?.operationId === xOp && (await f.value(f.auth, `svccut.${yOp}`)) === null, { xa, ya, status8 });

    // R-6: a foreign value at the marker key holds and is never overwritten.
    rev = await revisionOf(f, `servicepolicy.${g.lifecycleUid}`);
    const a9 = await handle(e, grantReq(svc.service, g, [pin(svc.selector, "lookup")], rev, ownerOf(f.owner)));
    const zReq = revokeReq(g, a9.grant?.grantId ?? "", a9.revision ?? 0, ownerOf(f.owner)), zOp = serviceHostOperationId(f.space, zReq.requestId);
    await f.auth.create(`svccut.${zOp}`, bytesOf({ fixture: "foreign marker" }));   // simulation
    const za = await handle(e, zReq);
    const status9 = ((await policyOf(f, g.lifecycleUid))?.grants as Array<{ grantId: string; status: unknown }>).find((x) => x.grantId === a9.grant?.grantId)?.status;
    c.check("R-6 a foreign marker holds marker-conflict; deny-new still landed and the marker is untouched", za.state === "held" && za.reason === "marker-conflict"
      && JSON.stringify(status9) === JSON.stringify({ state: "revoking", operationId: zOp, phase: "cutoff-required" })
      && JSON.stringify(await f.value(f.auth, `svccut.${zOp}`)) === JSON.stringify({ fixture: "foreign marker" }), { za, status9 });

    // Q-1: reads.
    const full = await handle(e, readReq(g, null, ownerOf(other)));
    const filtered = await handle(e, readReq(g, svc.selector, ownerOf(f.owner)));
    const hidden = await handle(e, readReq(g, null, ownerOf(f.owner)));
    const foreign = await handle(e, readReq(g, svc.selector, ownerOf(third)));
    const op = await handle(e, readReq(g, null, operator));
    const rowRev = await revisionOf(f, `servicepolicy.${g.lifecycleUid}`);
    c.check("Q-1 the grantee owner reads its full row at the whole-row revision", full.state === "present" && full.record?.value.service === null
      && full.record?.value.grants.length === 4 && full.record?.revision === rowRev, full);
    c.check("Q-1 the service owner reads another owner's grantee filtered to its service", filtered.state === "present" && filtered.record?.revision === rowRev
      && JSON.stringify(filtered.record?.value.service) === JSON.stringify(svc.selector), filtered);
    c.check("Q-1 the service owner's unfiltered read of another owner's grantee, and a foreign owner's filtered read, are absent", hidden.state === "absent" && foreign.state === "absent", { hidden, foreign });
    c.check("Q-1 an operator reads any grantee", op.state === "present" && op.record?.value.grants.length === 4, op);
    for (const [label, r] of [["Q-1 full", full], ["Q-1 filtered", filtered], ["Q-1 hidden", hidden]] as const) parsesClosed(label, r);

    // Q-2: list.
    const all = await handle(e, listReq(svc.selector, ownerOf(f.owner)));
    const uids = (all.records ?? []).map((x) => x.value.grantee.lifecycleUid);
    c.check("Q-2 the service owner lists its grantees in uid order, skipping orphan entries", all.state === "page" && all.nextCursor === null
      && JSON.stringify(uids) === JSON.stringify([...uids].sort()) && uids.includes(g.lifecycleUid) && !uids.includes(late.lifecycleUid), all);
    const first = await handle(e, listReq(svc.selector, ownerOf(f.owner), { limit: 1 }));
    const next = await handle(e, listReq(svc.selector, ownerOf(f.owner), { limit: 1, cursor: first.nextCursor ?? null }));
    c.check("Q-2 a one-grantee page carries a cursor to the next grantee", first.records?.length === 1 && typeof first.nextCursor === "string"
      && next.records?.length === 1 && next.records[0]!.value.grantee.lifecycleUid !== first.records[0]!.value.grantee.lifecycleUid, { first, next });
    const rebound = await handle(e, listReq(svc.selector, ownerOf(f.owner), { limit: 1, cursor: first.nextCursor ?? null, owner: other }));
    const byOwner = await handle(e, listReq(svc.selector, ownerOf(f.owner), { owner: other }));
    const none = await handle(e, listReq(null, ownerOf(f.owner)));
    const strangerPage = await handle(e, listReq(svc.selector, ownerOf(third)));
    c.check("Q-2 a cursor bound to another filter is bad-request", rebound.state === "denied" && rebound.reason === "bad-request", rebound);
    c.check("Q-2 the owner filter keeps only that owner's grantees", byOwner.state === "page" && byOwner.records?.length === 1, byOwner);
    c.check("Q-2 a space-wide list is unsupported and a foreign service lists empty", none.state === "denied" && none.reason === "unsupported"
      && strangerPage.state === "page" && strangerPage.records?.length === 0, { none, strangerPage });
    for (const [label, r] of [["Q-2 page", all], ["Q-2 cursor", first], ["Q-2 none", none]] as const) parsesClosed(label, r);
    const grantOp = await handle(e, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "operation-read", granter: ownerOf(f.owner),
      input: { operationId: serviceHostOperationId(f.space, r1.requestId) } });
    c.check("G-1 operation-read of the grant shows a terminal grant operation", grantOp.state === "present" && grantOp.record?.value.operation === "grant", grantOp);
    parsesClosed("G-1 operation-read", grantOp);
  } finally { await f.close(); }
}

// ---- F, L: the instance bound and a finite auth-stream limit ---------------------------------------
{
  const f = await fixture("s3a-limits", 4 * 1024 * 1024);
  try {
    const dir = ledger(f.owner, other), e = await engine(f, dir), svc = await approved(f, e), full = await approved(f, e);
    await assertPrecondition(f);
    const g = principal(dir, other);
    // Simulation: an index already at its bound of 256 entries for the second instance.
    const entries = Array.from({ length: 256 }, (_, k) => ({ granteeUid: `u${String(k).padStart(25, "0")}`, grantId: "a".repeat(32) }));
    await f.auth.create(`svcpolx.${f.endpoint.replaceAll(".", "_")}.${full.selector.instanceId}`, bytesOf({ v: 1, kind: "service-caller-grant-index", entries }));
    const rf = grantReq(full.service, g, [pin(full.selector, "lookup")], 0, ownerOf(f.owner)), af = await handle(e, rf);
    c.check("F-1 (simulated index) a full instance index denies resource-exhausted with zero writes", af.state === "denied" && af.reason === "resource-exhausted"
      && (await opRecord(f, rf.requestId)) === null && (await policyOf(f, g.lifecycleUid)) === null, af);

    let rev = 0;
    for (let n = 0; n < 6; n++) {
      const a = await handle(e, grantReq(svc.service, g, [pin(svc.selector, "lookup")], rev, ownerOf(f.owner)));
      if (a.state !== "granted") throw new Error(`fixture grant failed: ${JSON.stringify(a)}`);
      rev = a.revision!;
    }
    const rowBytes = (await f.auth.get(`servicepolicy.${g.lifecycleUid}`))!.value.length;
    const target = ((await policyOf(f, g.lifecycleUid))!.grants as Array<{ grantId: string }>)[0]!.grantId;
    // Simulation on the owned broker: the auth stream gains a finite per-message limit the row cannot meet with O.
    const jsm = await jetstreamManager(f.conn), stream = `KV_${epAuthBucket(f.space)}`, cfg = (await jsm.streams.info(stream)).config;
    await jsm.streams.update(stream, { ...cfg, max_msg_size: rowBytes + 256 });
    const k = revokeReq(g, target, rev, ownerOf(f.owner)), ka = await handle(e, k);
    const rec = await f.value(f.auth, "svchost.payload");
    const status = ((await policyOf(f, g.lifecycleUid))!.grants as Array<{ grantId: string; status: { state: string } }>)[0]!.status;
    c.check("P1-2/L-10 (simulated stream limit) a deny-new row that would not fit is not issued: held payload-precondition, grant still active",
      ka.state === "held" && ka.reason === "payload-precondition" && status.state === "active" && (await revisionOf(f, `servicepolicy.${g.lifecycleUid}`)) === rev, { ka, status, rowBytes });
    c.check("P1-2 the precondition is withdrawn durably by the revoke that could not write", rec?.state === "withdrawn" && rec?.reason === "payload-precondition"
      && rec?.operationId === serviceHostOperationId(f.space, k.requestId), rec);
    await assertPrecondition(f);
    const ag = await handle(e, grantReq(svc.service, g, [pin(svc.selector, "lookup")], rev, ownerOf(f.owner)));
    c.check("L-10 with a finite auth-stream limit the precondition fails its live check, so a new grant is denied unsupported", ag.state === "denied" && ag.reason === "unsupported", ag);
    parsesClosed("P1-2", ka);
  } finally { await f.close(); }
}

c.check("S (broker grants) no effect or discovery connection of this suite was refused a publish", fixtures.every((f) => f.violations.length === 0),
  fixtures.flatMap((f) => f.violations));
for (const d of ledgers) rmSync(d, { recursive: true, force: true });
console.log(`service-caller-host: ${c.passed} passed, ${c.failed} failed (owned-broker fixture evidence only)`);
c.finish();
if (c.failed) process.exitCode = 1;
