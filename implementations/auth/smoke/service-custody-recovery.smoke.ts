/** Recovery, contention and classification cells for the dormant service custody writer, on an
 * owned loopback broker with fixture fault injection (see `_service-custody-fixture.ts`). Labels
 * carry the r4 §9 / r4a §4 cell they cover. Fixture material is original material supplied by the
 * fixture; no cell exercises S2 durable host authentication, and none is native acceptance. Faults
 * are simulated: a lost ACK is an ambiguous error reported over a real landed write, a deferred
 * original is issued later by the fixture, and an interruption is a latch trip followed by a
 * resealed invocation on a fresh host. No process exits. */
import { createAccount } from "@nats-io/nkeys";
import { contractDigest, endpointRegistrationBarrier, isCasLoss, mintLifecycleUid, type ServiceUidCustodyV1 } from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { registryStores } from "../src/lifecycle-registry.js";
import { approveNativeServiceGate, createPendingServiceGate, denyNativeServiceGate, readNativeServiceGate } from "../src/native-service-gate.js";
import { bindNativeServiceName } from "../src/native-service-name.js";
import { readRegistryServiceRoot } from "../src/service-root-reader.js";
import {
  encodeRoundTrip, parseServiceHead, parseServiceNativeGate, parseServiceNativeRoot, serviceCustodyIdentity,
} from "../src/service-custody-shapes.js";
import type { ServiceBootstrapResult } from "../src/service-custody.js";
import { bytesOf, checks, openFixture, within, type WriteCall } from "./_service-custody-fixture.js";

const tally = checks(), check = tally.check;
const fx = await openFixture("s1recovery");
const { records, auth } = fx;
const throwsSync = (fn: () => unknown) => { try { fn(); return false; } catch { return true; } };
const plan = async (r: ServiceUidCustodyV1) => (await fx.value(records, fx.keys(r).head))?.rootPlan as { credentialId: string; expMs: number } | null | undefined;
const state = (v: Record<string, unknown> | null | undefined) => v?.state;
const deny = async (r: ServiceUidCustodyV1) => {
  const g = (await readNativeServiceGate(fx.reg, fx.binding(r)))!;
  await denyNativeServiceGate(fx.reg, fx.binding(r), { expectedRevision: g.revision, operationId: mintLifecycleUid() });
};
const rootKeyOf = (r: ServiceUidCustodyV1, p?: { credentialId: string } | null) => fx.keys(r).root(p?.credentialId ?? "none");
const is = {
  uid: (r: ServiceUidCustodyV1) => (w: WriteCall) => w.key === fx.keys(r).uid,
  epgate: (r: ServiceUidCustodyV1) => (w: WriteCall) => w.key === fx.keys(r).epgate,
  head: (r: ServiceUidCustodyV1, s: string, pred: (v: Record<string, unknown>) => boolean = () => true) =>
    (w: WriteCall) => w.key === fx.keys(r).head && w.value?.state === s && pred(w.value),
  plan: (r: ServiceUidCustodyV1) => is.head(r, "service-creating", (v) => v.rootPlan !== null),
  gate: (r: ServiceUidCustodyV1, s: string) => (w: WriteCall) => w.key === fx.keys(r).gate && w.value?.state === s,
  root: (r: ServiceUidCustodyV1, s: string) => (w: WriteCall) => w.key.startsWith(`cred.${r.native.lifecycleUid}.`) && w.value?.state === s,
};
/** B4 is the first open native gate CAS; this arm lets it through so a later arm sees only B7. */
const passB4 = (r: ServiceUidCustodyV1) => fx.faults.onWrite(is.gate(r, "open"), {});
const active = (o: ServiceBootstrapResult) => o.kind === "active";

try {
  console.log("cell 8: a simulated lost ACK (the real write lands, the fixture reports an ambiguous error) is classified by exact leader readback, one write applied");
  for (const target of ["uid", "RootPlan", "root", "gate touch", "stamp"] as const) {
    const r = fx.reservation(), k = fx.keys(r);
    if (target === "gate touch") passB4(r);
    const match = target === "uid" ? is.uid(r) : target === "RootPlan" ? is.plan(r) : target === "root" ? is.root(r, "active")
      : target === "gate touch" ? is.gate(r, "open") : is.head(r, "active");
    const arm = fx.faults.onWrite(match, { fault: "ack-lost" });
    const w = { uid: await fx.watch("records", k.uid), head: await fx.watch("records", k.head), gate: await fx.watch("auth", k.gate), root: await fx.watch("auth", `cred.${r.native.lifecycleUid}.*`) };
    const out = await fx.bootstrap(r);
    for (const x of Object.values(w)) await x.stop();
    fx.faults.clear();
    const p = w.head.seen.find((v) => state(v) === "service-creating" && v?.rootPlan)?.rootPlan as { credentialId: string; expMs: number } | undefined;
    const root = out.kind === "active" ? await fx.value(auth, k.root(out.root.credentialId)) : null;
    check(`${target}: the bootstrap still reaches active through readback`, active(out) && arm.hits === 1, out);
    check(`${target}: exactly one write of each step landed`, w.uid.seen.length === 1
      && w.head.seen.filter((v) => state(v) === "service-creating" && v?.rootPlan !== null).length === 1
      && w.head.seen.filter((v) => state(v) === "active").length === 1 && w.root.seen.length === 1
      && w.gate.seen.filter((v) => state(v) === "open").length === 2,
      { uid: w.uid.seen.length, head: w.head.seen.map(state), gate: w.gate.seen.map(state), root: w.root.seen.length });
    check(`${target}: the original plan id and expiry are kept and the root is not revoked`,
      active(out) && out.kind === "active" && !!p && out.root.credentialId === p.credentialId && root?.exp === p.expMs && root?.state === "active", { out, p, root });
  }

  console.log("cells 8/10 (r4a §3): unknown outcomes are classified before any conditional retry");
  {
    const r = fx.reservation(), k = fx.keys(r), w = await fx.watch("records", k.uid);
    const arm = fx.faults.onWrite(is.uid(r), { fault: "not-sent" });
    const out = await fx.bootstrap(r);
    await w.stop(); fx.faults.clear();
    check("an unknown create that never landed is retried once on authoritative absence", active(out) && arm.hits === 1 && w.seen.length === 1, { out, writes: w.seen.length });
  }
  {
    const r = fx.reservation(), k = fx.keys(r), w = await fx.watch("records", k.uid);
    let original: (() => Promise<unknown>) | undefined, late: unknown;
    fx.faults.onWrite(is.uid(r), { fault: "deferred", deferred: (issue) => { original = issue; } });
    // Read 1 is the B0 classification before the write; read 2 is the post-write classification.
    let reads = 0;
    fx.faults.onRead("records", k.uid, async () => { if (++reads === 2 && original) late = await original().catch((e: unknown) => e); }, 2);
    const out = await fx.bootstrap(r);
    await w.stop(); fx.faults.clear();
    check("an unknown create whose deferred original the fixture issues after the classification read applies once", active(out) && typeof late === "number" && w.seen.length === 1, { out, late: String(late), writes: w.seen.length });
  }
  {
    const r = fx.reservation(), k = fx.keys(r), w = await fx.watch("records", k.head);
    let original: (() => Promise<unknown>) | undefined, late: unknown;
    fx.faults.onWrite(is.plan(r), { fault: "deferred", deferred: (issue) => { original = issue; } });
    fx.faults.onWrite(is.plan(r), { after: async () => { late = await original?.().catch((e: unknown) => e); } });
    const out = await fx.bootstrap(r);
    await w.stop(); fx.faults.clear();
    check("an unknown CAS whose deferred original the fixture issues after the retry applies once; the original loses",
      active(out) && isCasLoss(late) && w.seen.filter((v) => v?.rootPlan !== null && state(v) === "service-creating").length === 1, { out, late: String(late) });
  }
  {
    const r = fx.reservation(), k = fx.keys(r), w = await fx.watch("records", k.head);
    let original: (() => Promise<unknown>) | undefined, late: unknown;
    fx.faults.onWrite(is.plan(r), { fault: "deferred", deferred: (issue) => { original = issue; } });
    let armed = false;
    fx.faults.onWrite(is.plan(r), { before: async () => { armed = true; } });
    // The fixture issues the original between the post-write classification read and the retry: the retry loses.
    fx.faults.onRead("records", k.head, async () => { if (original && !armed && late === undefined) late = await original().catch((e: unknown) => e); }, 20);
    const out = await fx.bootstrap(r);
    await w.stop(); fx.faults.clear();
    check("an unknown CAS whose deferred original the fixture issues before the retry applies once; the retry re-decides",
      active(out) && typeof late === "number" && w.seen.filter((v) => v?.rootPlan !== null && state(v) === "service-creating").length === 1, { out, late: String(late) });
  }
  {
    const r = fx.reservation(), k = fx.keys(r);
    const arm = fx.faults.onWrite(is.uid(r), { fault: "not-sent" }, 3);
    const out = await fx.bootstrap(r);
    fx.faults.clear();
    check("three unknown rounds exhaust to held unknown with nothing written", out.kind === "held" && out.reason === "unknown" && arm.hits === 3 && (await records.get(k.uid)) === null, out);
  }
  {
    const r = fx.reservation(), k = fx.keys(r), w = await fx.watch("records", k.uid);
    fx.faults.onWrite(is.uid(r), { fault: "held" });
    const out = await fx.bootstrap(r);
    await w.stop(); fx.faults.clear();
    check("a timed-out create is classified absent and retried once", active(out) && w.seen.length === 1, { out, writes: w.seen.length });
  }
  {
    const r = fx.reservation(), k = fx.keys(r);
    fx.faults.onWrite(is.uid(r), { fault: "not-sent", before: async () => { await records.create(k.uid, bytesOf(r)); await records.delete(k.uid); } });
    const out = await fx.bootstrap(r);
    fx.faults.clear();
    console.log(`OBSERVED marker after an unknown create: ${JSON.stringify(out)}`);
    check("a deletion marker seen after an unknown create holds, with no further write", out.kind === "held" && (await records.get(k.head)) === null, out);
  }

  console.log("CAS contention and re-decision bounds");
  {
    const r = fx.reservation(), k = fx.keys(r), w = await fx.watch("records", k.head);
    fx.faults.onWrite(is.plan(r), { before: async () => { await fx.touch(records, k.head); } });
    const out = await fx.bootstrap(r);
    await w.stop(); fx.faults.clear();
    check("a RootPlan CAS lost to a sibling re-reads, re-decides and persists one plan", active(out) && w.seen.filter((v) => v?.rootPlan !== null && state(v) === "service-creating").length === 1, out);
  }
  {
    const r = fx.reservation(), k = fx.keys(r);
    const arm = fx.faults.onWrite(is.plan(r), { before: async () => { await fx.touch(records, k.head); } }, 10);
    const out = await fx.bootstrap(r);
    fx.faults.clear();
    check("four lost RootPlan decisions hold as contention with no plan", out.kind === "held" && out.reason === "contention" && arm.hits === 4 && (await plan(r)) === null, { out, hits: arm.hits });
  }
  {
    const r = fx.reservation(), k = fx.keys(r);
    await fx.bootstrap(r);
    const headRev = await fx.revision(records, k.head);
    const arm = fx.faults.onWrite(is.epgate(r), { before: async () => { await fx.touch(auth, k.epgate); } }, 10);
    const out = await fx.cancel(r, fx.cancelOp());
    fx.faults.clear();
    check("four lost endpoint denies hold as contention before any head write", out.kind === "held" && out.reason === "contention" && arm.hits === 4
      && (await fx.revision(records, k.head)) === headRev, { out, hits: arm.hits });
  }

  console.log("B7 finalize: sibling touches re-pin, bounded at 8");
  {
    const r = fx.reservation(), k = fx.keys(r), w = await fx.watch("auth", k.gate);
    passB4(r);
    fx.faults.onWrite(is.gate(r, "open"), { before: async () => { await fx.touch(auth, k.gate); } });
    const out = await fx.bootstrap(r);
    await w.stop(); fx.faults.clear();
    check("one sibling touch re-pins the byte-identical open gate and finalizes", active(out) && w.seen.filter((v) => state(v) === "open").length === 3, { out, gate: w.seen.map(state) });
  }
  {
    const r = fx.reservation(), k = fx.keys(r);
    passB4(r);
    const arm = fx.faults.onWrite(is.gate(r, "open"), { before: async () => { await fx.touch(auth, k.gate); } }, 20);
    const out = await fx.bootstrap(r);
    fx.faults.clear();
    check("eight lost touches hold as contention without a stamp", out.kind === "held" && out.reason === "contention" && arm.hits === 8
      && state(await fx.value(records, k.head)) === "service-creating", { out, hits: arm.hits });
  }

  console.log("cell 5: B7 observes a service-cancel fence");
  {
    const r = fx.reservation(), k = fx.keys(r), op = fx.cancelOp();
    let paused: unknown;
    passB4(r);
    fx.faults.onWrite(is.gate(r, "open"), { before: async () => { paused = await fx.pausedCancel(r, op, "auth", k.gate, 1); } });
    const out = await fx.bootstrap(r);
    fx.faults.clear();
    const p = await plan(r), rootKey = rootKeyOf(r, p);
    const refuses = async () => { try { await readRegistryServiceRoot(fx.reg, fx.binding(r), p!.credentialId, Date.now()); return false; } catch { return true; } };
    check("bootstrap reports cancelled when the touch loses to the cancel fence", out.kind === "cancelled" && out.opId === op.opId, { out, paused });
    check("the planned root stays active until C-L4 and the reader refuses", state(await fx.value(auth, rootKey)) === "active" && await refuses());
    const resumed = await fx.cancel(r, op);
    check("the same cancel resumes to revoke the unstamped root by CAS", resumed.kind === "pending" && resumed.rootDetail === "cas-revoked"
      && state(await fx.value(auth, rootKey)) === "revoked" && await refuses(), resumed);
  }

  console.log("cell 9: sibling drivers and stamp against cancel");
  {
    const r = fx.reservation(), k = fx.keys(r), w = { head: await fx.watch("records", k.head), root: await fx.watch("auth", `cred.${r.native.lifecycleUid}.*`) };
    let sibling: ServiceBootstrapResult | undefined;
    fx.faults.onWrite(is.plan(r), { before: async () => { sibling = await fx.bootstrap(r); } });
    const out = await fx.bootstrap(r);
    for (const x of Object.values(w)) await x.stop();
    fx.faults.clear();
    check("a sibling that finishes first leaves one plan, one root and one stamp", active(out) && sibling?.kind === "active"
      && out.kind === "active" && sibling.kind === "active" && out.root.credentialId === sibling.root.credentialId && out.root.expMs === sibling.root.expMs
      && w.head.seen.filter((v) => v?.rootPlan !== null && state(v) === "service-creating").length === 1
      && w.head.seen.filter((v) => state(v) === "active").length === 1 && w.root.seen.length === 1, { out, sibling });
  }
  {
    const r = fx.reservation(), k = fx.keys(r), w = { head: await fx.watch("records", k.head), root: await fx.watch("auth", `cred.${r.native.lifecycleUid}.*`) };
    const [a, b] = await Promise.all([fx.bootstrap(r), fx.bootstrap(r)]);
    for (const x of Object.values(w)) await x.stop();
    check("concurrent siblings converge on one root without an expiry recompute", a.kind === "active" && b.kind === "active"
      && a.root.credentialId === b.root.credentialId && a.root.expMs === b.root.expMs && w.root.seen.length === 1
      && w.head.seen.filter((v) => state(v) === "active").length === 1, { a, b, roots: w.root.seen.length });
  }
  {
    const r = fx.reservation(), k = fx.keys(r), op = fx.cancelOp();
    let cancelled: unknown;
    fx.faults.onWrite(is.head(r, "active"), { before: async () => { cancelled = await fx.cancel(r, op); } });
    const out = await fx.bootstrap(r);
    fx.faults.clear();
    const head = await fx.value(records, k.head), p = await plan(r);
    check("cancel before the stamp: the stamp CAS loses and bootstrap reports cancelled", out.kind === "cancelled"
      && state(head) === "service-cancelling" && head?.currentCredentialId === null, { out, cancelled });
    check("cancel before the stamp revokes the unstamped root", (cancelled as { rootDetail?: string })?.rootDetail === "cas-revoked"
      && state(await fx.value(auth, rootKeyOf(r, p))) === "revoked", cancelled);
  }
  {
    const r = fx.reservation(), op = fx.cancelOp();
    let cancelled: unknown;
    fx.faults.onWrite(is.head(r, "active"), { after: async () => { cancelled = await fx.cancel(r, op); } });
    const out = await fx.bootstrap(r);
    fx.faults.clear();
    const p = await plan(r);
    check("stamp before the cancel: the stamped root is retained and bootstrap never reports active",
      !active(out) && (cancelled as { root?: string })?.root === "retained-stamped" && state(await fx.value(auth, rootKeyOf(r, p))) === "active", { out, cancelled });
  }

  console.log("cell 7: bootstrap refuses after an endpoint deny at B5, B6 and B8");
  for (const at of ["B5", "B6", "B8"] as const) {
    const r = fx.reservation(), k = fx.keys(r);
    if (at === "B8") passB4(r);
    fx.faults.onWrite(at === "B5" ? is.gate(r, "open") : at === "B6" ? is.plan(r) : is.gate(r, "open"), { after: async () => { await deny(r); } });
    const out = await fx.bootstrap(r);
    fx.faults.clear();
    const p = await plan(r);
    const next = at === "B5" ? p === null : at === "B6" ? !!p && (await auth.get(k.root(p.credentialId))) === null : state(await fx.value(records, k.head)) === "service-creating";
    check(`a deny landing before ${at} stops with endpoint-revoked and no ${at} write`, out.kind === "endpoint-revoked" && next, { out, p });
  }
  {
    const r = fx.reservation(), k = fx.keys(r);
    fx.faults.onWrite(is.head(r, "active"), { before: async () => { await deny(r); } });
    const out = await fx.bootstrap(r);
    fx.faults.clear();
    const cancel = await fx.cancel(r, fx.cancelOp());
    check("L1 after the B8 recheck then L2: the stamp is retained, never active", out.kind === "endpoint-revoked" && state(await fx.value(records, k.head)) === "service-cancelling"
      && cancel.kind === "pending" && cancel.root === "retained-stamped", { out, cancel });
  }

  console.log("F5: endpoint recheck before every B5/B6/B8 attempt, and the plan expiry bounds requests");
  {
    const r = fx.reservation(), k = fx.keys(r);
    fx.faults.onWrite(is.head(r, "active"), { before: async () => { await fx.touch(records, k.head); await deny(r); } });
    const out = await fx.bootstrap(r);
    fx.faults.clear();
    check("a stamp retried after a lost CAS re-reads the endpoint first and writes no stamp", out.kind === "endpoint-revoked"
      && state(await fx.value(records, k.head)) === "service-creating", { out, head: state(await fx.value(records, k.head)) });
  }
  {
    const r = fx.reservation(), k = fx.keys(r);
    await fx.pausedBootstrap(r, "auth", k.gate, 2);
    const head = (await records.get(k.head))!, row = JSON.parse(new TextDecoder().decode(head.value)) as Record<string, unknown>;
    const p = { credentialId: mintLifecycleUid(), expMs: Date.now() + 1_500 };
    await records.update(k.head, bytesOf({ ...row, rootPlan: p }), head.revision);
    fx.faults.onRead("auth", k.root(p.credentialId), async () => { await within(new Promise<void>(() => {}), Math.max(0, p.expMs - Date.now()) + 300); });
    const out = await fx.bootstrap(r);
    fx.faults.clear();
    check("a request in flight at the plan expiry ends held without a root write", out.kind === "held" && out.reason === "plan-expired"
      && (await auth.get(k.root(p.credentialId))) === null, { out, root: await fx.value(auth, k.root(p.credentialId)) });
  }

  console.log("B9: an already-active head is verified before any plan clip, and its final check sees the root expiry");
  for (const at of ["the reader's root read", "verification's root re-read"] as const) {
    const r = fx.reservation(), k = fx.keys(r);
    await fx.pausedBootstrap(r, "auth", k.gate, 2);
    const head = (await records.get(k.head))!, row = JSON.parse(new TextDecoder().decode(head.value)) as Record<string, unknown>;
    const p = { credentialId: mintLifecycleUid(), expMs: Date.now() + 2_500 };
    await records.update(k.head, bytesOf({ ...row, rootPlan: p }), head.revision);
    const setup = await fx.bootstrap(r);
    const revs = [await fx.revision(records, k.head), await fx.revision(auth, k.root(p.credentialId))];
    // The already-active path reads the root twice in verification: the reader's read, then the re-read.
    let reads = 0, reached = false;
    fx.faults.onRead("auth", k.root(p.credentialId), async () => {
      if (++reads !== (at === "the reader's root read" ? 1 : 2)) return;
      reached = Date.now() < p.expMs;
      await within(new Promise<void>(() => {}), Math.max(0, p.expMs - Date.now()) + 300);
    }, 2);
    const out = await fx.bootstrap(r);
    fx.faults.clear();
    check(`an already-active root that expires while ${at} is held ends held, not active, with no write`, active(setup) && reached
      && out.kind === "held" && out.reason === "plan-expired" && out.step === "B9-verify"
      && (await fx.revision(records, k.head)) === revs[0] && (await fx.revision(auth, k.root(p.credentialId))) === revs[1], { setup, reached, out });
  }

  // Canonical 3862 line 43 revokes approval on an existing registration freeze without stealing its
  // op; it supersedes r4 §7 L1's "held:registration-in-flight", so cancellation continues.
  console.log("F4 (canonical): deny-new on a registration freeze keeps its op, and cancellation continues");
  {
    const r = fx.reservation(), k = fx.keys(r);
    const boot = await fx.bootstrap(r);
    if (boot.kind !== "active") throw new Error(`registration setup did not reach active: ${JSON.stringify(boot)}`);
    let g = (await readNativeServiceGate(fx.reg, fx.binding(r)))!;
    g = await approveNativeServiceGate(fx.reg, fx.binding(r), { expectedRevision: g.revision, rootCredentialId: boot.root.credentialId,
      approvalDigest: contractDigest({ approved: contractDigest(r) }), nameAuthorityRevision: fx.name.revision, approvalExpiresAt: null, callerCeiling: [] });
    const regOp = mintLifecycleUid();
    const barrier = endpointRegistrationBarrier(registryStores(fx.reg).authKv, fx.space, { endpoint: r.assignment.endpoint, instanceId: r.assignment.instanceId,
      opId: regOp, serviceRegistration: { requestId: "d".repeat(32), requestDigest: contractDigest({ registration: regOp }) } });
    const frozen = await barrier.freeze(g.revision);
    const out = await fx.cancel(r, fx.cancelOp());
    const after = (await readNativeServiceGate(fx.reg, fx.binding(r)))!.row;
    check("cancellation records deny-new without stealing the registration op", frozen !== null && after.state === "frozen"
      && after.op?.kind === "registration" && after.op.opId === regOp && after.serviceAuthority.state === "revoked", { after: { state: after.state, op: after.op, auth: after.serviceAuthority.state } });
    check("cancellation then fences the stamped head and native gate and retains the stamped root", out.kind === "pending" && out.root === "retained-stamped"
      && state(await fx.value(records, k.head)) === "service-cancelling" && state(await fx.value(auth, k.gate)) === "frozen"
      && state(await fx.value(auth, k.root(boot.root.credentialId))) === "active", out);
  }

  console.log("cell 1: cancellation at the B0, B1, B2 and B3 pauses, and the absent-head race");
  for (const at of [["B0", "records", "uid"], ["B1", "auth", "epgate"], ["B2", "records", "head"], ["B3", "auth", "gate"]] as const) {
    const r = fx.reservation(), k = fx.keys(r);
    await fx.pausedBootstrap(r, at[1], k[at[2]], 1);
    const op = fx.cancelOp(), out = await fx.cancel(r, op);
    const head = await fx.value(records, k.head), gate = await fx.value(auth, k.gate);
    check(`cancel at the ${at[0]} pause fences the head and native gate with no root`, out.kind === "pending" && out.root === "none"
      && state(head) === "service-cancelling" && (head?.op as { opId: string }).opId === op.opId && head?.rootPlan === null
      && state(gate) === "frozen" && gate?.generation === 0 && (gate?.op as { kind: string; opId: string }).kind === "service-cancel"
      && (gate?.op as { opId: string }).opId === op.opId, { out, head, gate });
    const boot = await fx.bootstrap(r);
    check(`bootstrap after the ${at[0]} cancel refuses`, boot.kind === "endpoint-revoked", boot);
  }
  {
    const r = fx.reservation(), k = fx.keys(r), w = await fx.watch("records", k.head);
    let cancelled: unknown;
    fx.faults.onWrite((x) => is.head(r, "service-creating")(x) && x.kind === "create", { before: async () => { cancelled = await fx.cancel(r, fx.cancelOp()); } });
    const out = await fx.bootstrap(r);
    await w.stop(); fx.faults.clear();
    check("absent-head race, cancel first: the creating head create loses and bootstrap reports cancelled",
      out.kind === "cancelled" && !w.seen.some((v) => state(v) === "service-creating") && (cancelled as { root?: string })?.root === "none", { out, cancelled });
  }
  {
    const r = fx.reservation(), k = fx.keys(r), w = await fx.watch("records", k.head);
    let cancelRun: Promise<unknown> | undefined, cReady!: () => void, bLanded!: () => void;
    const cancelReady = new Promise<void>((x) => { cReady = x; }), bootLanded = new Promise<void>((x) => { bLanded = x; });
    fx.faults.onWrite((x) => is.head(r, "service-cancelling")(x) && x.kind === "create", { before: async () => { cReady(); await bootLanded; } });
    fx.faults.onWrite((x) => is.head(r, "service-creating")(x) && x.kind === "create", {
      before: async () => { cancelRun = fx.cancel(r, fx.cancelOp()); await cancelReady; },
      after: async () => { bLanded(); await cancelRun; },
    });
    const out = await fx.bootstrap(r);
    const cancelled = await cancelRun;
    await w.stop(); fx.faults.clear();
    check("absent-head race, bootstrap first: the cancel create loses, re-reads and CASes the creating head",
      out.kind === "cancelled" && (cancelled as { kind?: string; root?: string })?.root === "none"
      && w.seen.map(state).join() === "service-creating,service-cancelling", { out, cancelled, head: w.seen.map(state) });
  }

  console.log("cell 2: D3 reservation confirmation");
  {
    const r = fx.reservation(), k = fx.keys(r), op = fx.cancelOp();
    const first = await fx.cancel(r, op);
    await records.create(k.uid, bytesOf(r));
    const resumed = await fx.cancel(r, op);
    check("a late B0 after an unconfirmed cancel lets the same operation continue", first.kind === "uid-unconfirmed" && resumed.kind === "pending"
      && resumed.root === "none" && state(await fx.value(records, k.head)) === "service-cancelling", { first, resumed });
  }
  {
    const r = fx.reservation(), k = fx.keys(r);
    fx.faults.onWrite(is.epgate(r), { after: async () => { await records.create(k.uid, bytesOf({ owner: fx.owner, actor: r.assignment.actor, mintedBy: "fixture" })); } });
    const out = await fx.cancel(r, fx.cancelOp());
    fx.faults.clear();
    console.log(`OBSERVED ordinary UID landing after the absent read: ${JSON.stringify(out)}`);
    check("an ordinary UID landing after the absent read gets no head or native gate write", (out.kind === "uid-unconfirmed" || out.kind === "uid-foreign")
      && (await records.get(k.head)) === null && (await auth.get(k.gate)) === null, out);
  }

  // A latch trip stands in for an interruption; no process exits. The resumed call is a fresh host and reseal.
  console.log("cell 4: a simulated interruption (latch trip) after every cancellation step, then a resealed invocation, resumes under the same operation");
  for (const at of [["L1", "auth", "epgate"], ["L2", "records", "head"], ["L3", "auth", "gate"], ["L4", "auth", "root"]] as const) {
    const r = fx.reservation(), k = fx.keys(r), op = fx.cancelOp();
    await fx.pausedBootstrap(r, "auth", `cred.${r.native.lifecycleUid}.*`, 1);
    const key = at[2] === "root" ? `cred.${r.native.lifecycleUid}.*` : k[at[2]];
    const interrupted = await fx.pausedCancel(r, op, at[1], key, 1);
    const resumed = await fx.cancel(r, op);
    const p = await plan(r);
    check(`a latch interruption after ${at[0]} and a resealed invocation reach the same nonterminal fence`, interrupted.kind === "held" && resumed.kind === "pending" && resumed.root === "revoked"
      && resumed.rootDetail === (at[0] === "L4" ? "already-revoked" : "cas-revoked") && state(await fx.value(auth, rootKeyOf(r, p))) === "revoked"
      && (await readNativeServiceGate(fx.reg, fx.binding(r)))?.row.serviceAuthority.state === "revoked", { interrupted, resumed });
  }
  {
    const r = fx.reservation(), k = fx.keys(r), op = fx.cancelOp();
    await fx.pausedBootstrap(r, "records", k.head, 1);
    await fx.pausedCancel(r, op, "records", k.head, 1);
    await auth.create(k.gate, bytesOf({ lifecycleUid: r.native.lifecycleUid, state: "frozen", generation: 0, serviceCustody: { v: 1, uidDigest: contractDigest(r) },
      op: { opId: mintLifecycleUid(), kind: "service-cancel" } }));
    const out = await fx.cancel(r, op);
    check("a native gate fenced by another cancel operation gives only a reference to it", out.kind === "foreign-operation" && out.opId !== op.opId, out);
  }

  console.log("cell 3: D4 root disposition");
  {
    const r = fx.reservation(), w = await fx.watch("auth", `cred.${r.native.lifecycleUid}.*`);
    await fx.pausedBootstrap(r, "records", fx.keys(r).head, 2);
    fx.faults.onWrite(is.root(r, "revoked"), { fault: "ack-lost" });
    const out = await fx.cancel(r, fx.cancelOp());
    await w.stop(); fx.faults.clear();
    check("a C-L4 create with a simulated lost ACK over its landed write reads back created-revoked, one write", out.kind === "pending" && out.rootDetail === "created-revoked" && w.seen.length === 1, { out, writes: w.seen.length });
  }
  {
    const r = fx.reservation(), w = await fx.watch("auth", `cred.${r.native.lifecycleUid}.*`);
    await fx.pausedBootstrap(r, "auth", `cred.${r.native.lifecycleUid}.*`, 1);
    fx.faults.onWrite(is.root(r, "revoked"), { fault: "not-sent" });
    const op = fx.cancelOp(), out = await fx.cancel(r, op);
    await w.stop(); fx.faults.clear();
    check("a C-L4 CAS that never landed is retried at its pinned revision", out.kind === "pending" && out.rootDetail === "cas-revoked"
      && w.seen.filter((v) => state(v) === "revoked").length === 1, { out });
    const again = await fx.cancel(r, op);
    check("the same cancel after a revoked root reports already-revoked", again.kind === "pending" && again.rootDetail === "already-revoked", again);
  }
  for (const variant of ["deletion marker", "foreign expiry"] as const) {
    const r = fx.reservation(), k = fx.keys(r);
    await fx.pausedBootstrap(r, "records", k.head, 2);
    const p = (await plan(r))!, key = k.root(p.credentialId);
    const row = { credentialId: p.credentialId, holderPrincipal: `${fx.owner}.${r.assignment.actor}`, lifecycleUid: r.native.lifecycleUid,
      sourceChain: ["root"], state: "active", exp: p.expMs + (variant === "foreign expiry" ? 1 : 0), serviceCustody: { v: 1, uidDigest: contractDigest(r) } };
    await auth.create(key, bytesOf(row));
    if (variant === "deletion marker") await auth.delete(key);
    const boot = await fx.bootstrap(r);
    const out = await fx.cancel(r, fx.cancelOp());
    check(`a planned root with a ${variant} holds both bootstrap and cancellation`, boot.kind === "held" && boot.reason === "root-foreign"
      && out.kind === "held" && out.reason === "root-foreign", { boot, out });
  }

  console.log("cell 6 and held classifications");
  {
    const r = fx.reservation(), k = fx.keys(r);
    const retired = bytesOf({ owner: fx.owner, actor: r.assignment.actor, lifecycleUid: mintLifecycleUid(), managerInstance: "fixture", processEpoch: 1, state: "retired" });
    await records.create(k.head, retired);
    const rev = await fx.revision(records, k.head), out = await fx.bootstrap(r);
    check("a retired ordinary head at the alias is an identity collision, never replaced", out.kind === "identity-collision" && (await fx.revision(records, k.head)) === rev, out);
  }
  {
    const r = fx.reservation(), k = fx.keys(r);
    await records.create(k.uid, bytesOf(r)); await records.delete(k.uid);
    const boot = await fx.bootstrap(r), cancel = await fx.cancel(r, fx.cancelOp());
    check("a UID deletion marker holds bootstrap and refuses cancellation with no fence", boot.kind === "held" && boot.reason === "uid-tombstone"
      && cancel.kind === "uid-foreign" && (await auth.get(k.epgate)) === null, { boot, cancel });
  }
  for (const variant of ["deletion marker", "malformed bytes"] as const) {
    const r = fx.reservation(), k = fx.keys(r);
    await fx.pausedBootstrap(r, "auth", k.epgate, 1);
    await records.create(k.head, variant === "malformed bytes" ? new TextEncoder().encode("{not json") : bytesOf({}));
    if (variant === "deletion marker") await records.delete(k.head);
    const boot = await fx.bootstrap(r), cancel = await fx.cancel(r, fx.cancelOp());
    console.log(`OBSERVED head ${variant}: ${JSON.stringify({ boot, cancel })}`);
    check(`a head ${variant} never lets bootstrap or cancellation write past it`, !active(boot) && (variant === "malformed bytes" || (boot.kind === "held" && boot.reason === "head-tombstone"))
      && cancel.kind === "held" && (await auth.get(k.gate)) === null, { boot, cancel });
  }
  for (const variant of ["deletion marker", "another UID's mirror"] as const) {
    const r = fx.reservation(), k = fx.keys(r);
    await fx.pausedBootstrap(r, "records", k.head, 1);
    await auth.create(k.gate, bytesOf({ lifecycleUid: r.native.lifecycleUid, state: "frozen", generation: 0,
      serviceCustody: { v: 1, uidDigest: variant === "another UID's mirror" ? contractDigest({ other: true }) : contractDigest(r) }, op: { opId: r.creation.operationId, kind: "activation" } }));
    if (variant === "deletion marker") await auth.delete(k.gate);
    const out = await fx.bootstrap(r);
    check(`a native gate with ${variant} holds as gate-foreign`, out.kind === "held" && out.reason === "gate-foreign", out);
  }
  {
    const other = createAccount().getPublicKey(), endpoint = "org.example.foreignname";
    await bindNativeServiceName(fx.reg, { accountPublicKey: other, space: fx.space }, {
      v: 1, kind: "service-endpoint-host", requestId: "e".repeat(32), operation: "name-bind", granter: { kind: "operator", auditId: "fixture" },
      input: { endpoint, owner: fx.owner, expectedRevision: 0, claimReference: "fixture-foreign-claim" } });
    const r = fx.reservation({ endpoint }), out = await fx.bootstrap(r);
    check("a service name bound by another account refuses before any write", out.kind === "name-unbound" && (await records.get(fx.keys(r).uid)) === null, out);
  }
  {
    const r = fx.reservation(), other = fx.reservation({ instanceId: r.assignment.instanceId });
    await createPendingServiceGate(fx.reg, fx.binding(other));
    const out = await fx.bootstrap(r);
    check("an endpoint gate of another assignment holds as foreign-assignment", out.kind === "held" && out.reason === "foreign-assignment" && (await records.get(fx.keys(r).uid)) === null, out);
  }
  {
    const r1 = fx.reservation(), r2 = fx.reservation({ instanceId: r1.assignment.instanceId });
    const fenced = await fx.cancel(r1, fx.cancelOp()), out = await fx.bootstrap(r2);
    check("an unconfirmed cancel fences its endpoint instance against a later reservation (S2 must authenticate cancel intents)",
      fenced.kind === "uid-unconfirmed" && out.kind === "held" && out.reason === "foreign-assignment", { fenced, out });
  }
  {
    const r = fx.reservation(), k = fx.keys(r);
    await fx.bootstrap(r);
    const g = (await auth.get(k.gate))!;
    await auth.update(k.gate, bytesOf({ lifecycleUid: r.native.lifecycleUid, state: "frozen", generation: 0, serviceCustody: { v: 1, uidDigest: contractDigest(r) },
      op: { opId: r.creation.operationId, kind: "activation" } }), g.revision);
    const out = await fx.bootstrap(r);
    check("an active head whose reader proof fails holds at verification", out.kind === "held" && out.reason === "verify", out);
  }
  {
    const r = fx.reservation(), k = fx.keys(r);
    await auth.create(k.epgate, new TextEncoder().encode("{not json"));
    const out = await fx.bootstrap(r);
    console.log(`OBSERVED malformed endpoint gate: ${JSON.stringify(out)}`);
    check("a malformed endpoint gate holds before any write", out.kind === "held" && (await records.get(k.uid)) === null, out);
  }

  console.log("cell 10 (r4a): a resumed invocation keeps its original deadline");
  {
    const r = fx.reservation(), k = fx.keys(r);
    const deadline = fx.original(r, 2_500);
    await fx.pausedBootstrap(r, "records", k.uid, 1);
    await within(new Promise<void>(() => {}), Math.max(0, deadline - Date.now()) + 100);
    const out = await fx.bootstrap(r);
    check("resuming after the original deadline holds and writes nothing further", out.kind === "held" && out.reason === "deadline" && (await records.get(k.head)) === null, out);
  }

  console.log("cell 11: shapes");
  {
    const r = fx.reservation(), id = serviceCustodyIdentity(r), otherId = serviceCustodyIdentity(fx.reservation());
    const base = { owner: id.owner, actor: id.actor, lifecycleUid: id.lifecycleUid, managerInstance: id.instanceId, processEpoch: 1, serviceCustody: { ...id.mirror } };
    const head = { ...base, state: "active", currentCredentialId: mintLifecycleUid() };
    const root = { credentialId: head.currentCredentialId, holderPrincipal: id.holderPrincipal, lifecycleUid: id.lifecycleUid, sourceChain: ["root"], state: "active", exp: Date.now() + 1_000, serviceCustody: { ...id.mirror } };
    check("an encoder refuses a row its parser would not read back", throwsSync(() => encodeRoundTrip({ ...root, exp: 1.5 } as never, (v) => parseServiceNativeRoot(v, id, root.credentialId))));
    check("a head with another UID's mirror refuses", throwsSync(() => parseServiceHead({ ...head, serviceCustody: { ...otherId.mirror } }, id)));
    check("a head without its mirror refuses", throwsSync(() => { const { serviceCustody: _, ...rest } = head; parseServiceHead(rest, id); }));
    check("a native gate with another UID's mirror refuses", throwsSync(() => parseServiceNativeGate({ lifecycleUid: id.lifecycleUid, state: "open", generation: 1, serviceCustody: { ...otherId.mirror } }, id)));
    check("a root with a mixed mirror refuses", throwsSync(() => parseServiceNativeRoot({ ...root, serviceCustody: { v: 1, uidDigest: otherId.digest, extra: 1 } }, id, root.credentialId)));
  }
} finally {
  await fx.close();
}
console.log(`SERVICE-CUSTODY recovery: ${tally.passed} passed, ${tally.failed} failed`);
emitSentinel({ passed: tally.passed, failed: tally.failed });
if (tally.failed) process.exitCode = 1;
