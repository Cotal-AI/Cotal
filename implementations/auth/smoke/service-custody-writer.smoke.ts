/** Dormant service native custody writer on an owned loopback broker: bootstrap, cancellation,
 * recovery after an observed post-write loss, and the sealed host/readiness boundary. The service
 * name binding, reservation material and deadlines are fixture-supplied original material; this
 * does not exercise S2 durable host authentication, which does not exist yet. Pause points come
 * from the fixture tripping the host's fatal latch when the broker delivers the paused write, so
 * that write lands and the writer must report it as held. No production account, grant,
 * credential, admission or serving path is used. */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { createAccount } from "@nats-io/nkeys";
import {
  contractDigest, createEndpointStreams, epAuthBucket, epgateKey, isReachable, lifecycleHeadKey, mintLifecycleUid,
  recordsBucket, serviceEndpointActor, uidReservationKey, type ServiceUidCustodyV1,
} from "@cotal-ai/core";
import { openLifecycleRegistry, registryStores, tryReserveUid, type LifecycleRegistry } from "../src/lifecycle-registry.js";
import { acquirePlaneClaim, PLANE_CLAIM_KEY, type PlaneClaimHold, type PlaneLivenessOracle, type ScanGuard } from "../src/plane-claim.js";
import { bindNativeServiceName } from "../src/native-service-name.js";
import { readNativeServiceGate } from "../src/native-service-gate.js";
import { readRegistryServiceRoot } from "../src/service-root-reader.js";
import { parseServiceNativeGate, serviceCustodyIdentity } from "../src/service-custody-shapes.js";
import {
  cancelServiceCustody, openServiceCustodyHost, runServiceBootstrap, sealServiceBootstrapIntent, sealServiceCancelIntent,
  type ServiceCustodyHost,
} from "../src/service-custody.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

let passed = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) { passed++; console.log(`PASS ${label}`); } else { failed++; console.log(`FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail)); }
};
const throws = async (label: string, fn: () => unknown, pattern: RegExp) => {
  try { await fn(); check(label, false, "no throw"); } catch (e) { check(label, pattern.test((e as Error).message), (e as Error).message); }
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A bounded fixture wait; resolves `undefined` when the event never comes. */
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, pause(ms).then(() => undefined)]);
const dec = new TextDecoder();

const SPACE = "s1custody", OTHER_SPACE = "s1custodyother", FENCE_SPACE = "s1custodyfence";
const OWNER = `u_${"a".repeat(26)}`;
const ENDPOINT = "org.example.orders";
const neverOracle: PlaneLivenessOracle = async () => { throw new Error("the oracle must not be consulted on a create path"); };
const tuple = (n: number) => ({ serverId: `NFIXTURE${n}`, cid: n, userNkey: `U${String.fromCharCode(64 + n).repeat(55)}` });

const port = await pickFreePort();
if (port === 4222) throw new Error("fixture refuses the default NATS port");
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", dir, "-p", String(port), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
let nc: NatsConnection | undefined;
try {
  for (let n = 0; !(await isReachable(`nats://127.0.0.1:${port}`)); n++) {
    if (n >= 50) throw new Error("owned fixture broker failed readiness");
    await pause(100);
  }
  nc = await connect({ servers: `nats://127.0.0.1:${port}`, reconnect: false, name: "s1-custody-fixture" });
  const conn = nc;
  for (const space of [SPACE, OTHER_SPACE, FENCE_SPACE]) await createEndpointStreams(await jetstreamManager(conn), new Kvm(conn), space);
  const reg: LifecycleRegistry = await openLifecycleRegistry(conn, SPACE);
  const records = await new Kvm(conn).open(recordsBucket(SPACE));
  const auth = await new Kvm(conn).open(epAuthBucket(SPACE));
  const hold = await acquirePlaneClaim({ nc: conn, space: SPACE, ledger: tuple(1), records: tuple(2), oracle: neverOracle, log: () => {} });
  const otherHold = await acquirePlaneClaim({ nc: conn, space: OTHER_SPACE, ledger: tuple(3), records: tuple(4), oracle: neverOracle, log: () => {} });
  const accountPublicKey = createAccount().getPublicKey();
  const bindName = (registry: LifecycleRegistry, space: string) => bindNativeServiceName(registry, { accountPublicKey, space }, {
    v: 1, kind: "service-endpoint-host", requestId: "a".repeat(32), operation: "name-bind",
    granter: { kind: "operator", auditId: "fixture-verified-claim" },
    input: { endpoint: ENDPOINT, owner: OWNER, expectedRevision: 0, claimReference: "fixture-namespace-claim" },
  });
  await bindName(reg, SPACE);

  const reservation = (endpoint = ENDPOINT, space = SPACE): ServiceUidCustodyV1 => {
    const instanceId = mintLifecycleUid(), lifecycleUid = mintLifecycleUid();
    return {
      v: 1, kind: "native-service-uid", native: { accountPublicKey, space, lifecycleUid },
      assignment: { owner: OWNER, actor: serviceEndpointActor({ accountPublicKey, space, owner: OWNER, endpoint, instanceId }), endpoint, instanceId, duty: "serve" },
      creation: { operationId: mintLifecycleUid(), requestDigest: contractDigest({ fixture: "s1", lifecycleUid }) },
    };
  };
  const binding = (r: ServiceUidCustodyV1) => ({ accountPublicKey, space: SPACE, owner: OWNER, endpoint: r.assignment.endpoint,
    instanceId: r.assignment.instanceId, lifecycleUid: r.native.lifecycleUid, assignmentDigest: contractDigest(r) });
  const keys = (r: ServiceUidCustodyV1) => ({
    uid: uidReservationKey(r.native.lifecycleUid), head: lifecycleHeadKey(OWNER, r.assignment.actor), gate: `gate.${r.native.lifecycleUid}`,
    epgate: epgateKey(r.assignment.endpoint, r.assignment.instanceId),
  });
  const value = async (kv: typeof records, key: string) => { const e = await kv.get(key); return e && e.operation === "PUT" ? JSON.parse(dec.decode(e.value)) as Record<string, unknown> : null; };
  const revision = async (kv: typeof records, key: string) => (await kv.get(key))?.revision ?? 0;
  const freshHost = (h: PlaneClaimHold = hold) => openServiceCustodyHost({ registry: reg, hold: h, accountPublicKey });
  const later = () => Date.now() + 120_000;
  const cancelOp = () => ({ opId: mintLifecycleUid(), requestDigest: contractDigest({ cancel: mintLifecycleUid() }) });
  // Trip `trip` when the broker delivers the nth write to `key`, so that write lands under a
  // fenced host and the writer must observe the loss after it.
  const tripOnWrite = (bucket: string, key: string, nth: number, trip: (reason: string) => void) => {
    let seen = 0;
    const sub = conn.subscribe(`$KV.${bucket}.${key}`, { callback: () => { if (++seen === nth) { trip(`fixture pause at write ${nth} of ${key}`); sub.unsubscribe(); } } });
    return sub;
  };

  console.log("A. sealed host and readiness boundary");
  await throws("a structural copy of a genuine hold is refused", () => openServiceCustodyHost({ registry: reg, hold: { ...hold }, accountPublicKey }), /plane claim hold/);
  await throws("a hold acquired for another space is refused", () => openServiceCustodyHost({ registry: reg, hold: otherHold, accountPublicKey }), /another space/);
  await throws("a hand-assembled registry is refused", () => openServiceCustodyHost({ registry: { space: SPACE } as unknown as LifecycleRegistry, hold, accountPublicKey }), /./);
  await throws("an intent is refused for a structural host", async () => sealServiceBootstrapIntent({ space: SPACE, accountPublicKey } as ServiceCustodyHost, { reservation: reservation(), notAfterMs: later() }), /sealed/);
  await throws("an intent whose account differs from the host is refused", async () => {
    const r = reservation(); r.native.accountPublicKey = createAccount().getPublicKey();
    sealServiceBootstrapIntent(freshHost().host, { reservation: r, notAfterMs: later() });
  }, /./);
  await throws("an intent without an explicit positive deadline is refused", async () => sealServiceBootstrapIntent(freshHost().host, { reservation: reservation(), notAfterMs: 0 }), /notAfterMs/);
  {
    const r = reservation(), k = keys(r), { host, trip } = freshHost();
    trip("fixture fatal before any write");
    const out = await runServiceBootstrap(sealServiceBootstrapIntent(host, { reservation: r, notAfterMs: later() }));
    check("a tripped latch holds before any write", out.kind === "held" && (await records.get(k.uid)) === null, out);
  }
  {
    const r = reservation(), k = keys(r), { host } = freshHost();
    const plane = (await auth.get(PLANE_CLAIM_KEY))!;
    const moved = await auth.update(PLANE_CLAIM_KEY, new TextEncoder().encode(JSON.stringify({ ...JSON.parse(dec.decode(plane.value)), claimId: "NFOREIGNCLAIM" })), plane.revision);
    const out = await runServiceBootstrap(sealServiceBootstrapIntent(host, { reservation: r, notAfterMs: later() }));
    check("a claim lost before the write holds with no reservation written", out.kind === "held" && (await records.get(k.uid)) === null, out);
    await auth.update(PLANE_CLAIM_KEY, plane.value, moved);
  }
  {
    const r = reservation(), k = keys(r);
    const out = await runServiceBootstrap(sealServiceBootstrapIntent(freshHost().host, { reservation: r, notAfterMs: Date.now() - 1 }));
    check("an expired original deadline holds with no reservation written", out.kind === "held" && out.reason === "deadline" && (await records.get(k.uid)) === null, out);
  }
  {
    // The awaited guard itself rejects after a landed write: the genuine hold's own fence is set
    // when the broker delivers the reservation write, and the host's latch is never tripped. A
    // fence is permanent, so this hold and its space serve this check only.
    const fenceReg = await openLifecycleRegistry(conn, FENCE_SPACE);
    const fenceRecords = await new Kvm(conn).open(recordsBucket(FENCE_SPACE));
    const fenceHold = await acquirePlaneClaim({ nc: conn, space: FENCE_SPACE, ledger: tuple(5), records: tuple(6), oracle: neverOracle, log: () => {} });
    await bindName(fenceReg, FENCE_SPACE);
    const r = reservation(ENDPOINT, FENCE_SPACE), k = keys(r);
    const { host } = openServiceCustodyHost({ registry: fenceReg, hold: fenceHold, accountPublicKey });
    const sub = tripOnWrite(recordsBucket(FENCE_SPACE), k.uid, 1, (reason) => fenceHold.fence(reason));
    const out = await runServiceBootstrap(sealServiceBootstrapIntent(host, { reservation: r, notAfterMs: later() }));
    sub.unsubscribe();
    check("the awaited hold check rejecting after the reservation write lands is held, never success",
      out.kind === "held" && out.reason === "post-write-readiness" && /fixture pause/.test(out.detail) && !/host was fenced/.test(out.detail)
      && (await fenceRecords.get(k.uid)) !== null, out);
    const again = await runServiceBootstrap(sealServiceBootstrapIntent(host, { reservation: r, notAfterMs: later() }));
    check("the fenced hold refuses the next invocation before any write", again.kind === "held" && again.reason === "readiness"
      && (await fenceRecords.get(k.head)) === null, again);
  }

  console.log("B. bootstrap, recovery and verification");
  {
    const r = reservation(), k = keys(r), first = freshHost();
    const sub = tripOnWrite(recordsBucket(SPACE), k.uid, 1, first.trip);
    const paused = await runServiceBootstrap(sealServiceBootstrapIntent(first.host, { reservation: r, notAfterMs: later() }));
    sub.unsubscribe();
    check("a loss observed after the reservation write lands is held, never success", paused.kind === "held" && paused.reason === "post-write-readiness" && (await records.get(k.uid)) !== null, paused);
    const out = await runServiceBootstrap(sealServiceBootstrapIntent(freshHost().host, { reservation: r, notAfterMs: later() }));
    check("the same original material resumes to an active root", out.kind === "active", out);
    if (out.kind === "active") {
      const head = await value(records, k.head), gate = await value(auth, k.gate), root = await value(auth, `cred.${r.native.lifecycleUid}.${out.root.credentialId}`);
      check("the head is active at the planned root with its mirror", head?.state === "active" && head.currentCredentialId === out.root.credentialId
        && (head.serviceCustody as { uidDigest: string }).uidDigest === contractDigest(r), head);
      check("the native gate is open at generation 1", gate?.state === "open" && gate.generation === 1, gate);
      check("the root row is active, root-sourced and carries the plan expiry", root?.state === "active" && root.exp === out.root.expMs, root);
      check("the endpoint gate stays pending-root (no approval is written)", (await readNativeServiceGate(reg, binding(r)))?.row.serviceAuthority.state === "pending-root");
      const proof = await readRegistryServiceRoot(reg, binding(r), out.root.credentialId, Date.now());
      check("the unchanged active-root reader proves the written custody", proof.expiresAt === Math.floor(out.root.expMs / 1000), proof);
      const before = { head: await revision(records, k.head), gate: await revision(auth, k.gate) };
      const again = await runServiceBootstrap(sealServiceBootstrapIntent(freshHost().host, { reservation: r, notAfterMs: later() }));
      check("re-running the same bootstrap returns the same root without a new plan or write",
        again.kind === "active" && again.root.credentialId === out.root.credentialId && again.root.expMs === out.root.expMs
        && before.head === await revision(records, k.head) && before.gate === await revision(auth, k.gate), again);

      console.log("C. cancellation of a stamped root");
      const op = cancelOp();
      const cancel = await cancelServiceCustody(sealServiceCancelIntent(freshHost().host, { reservation: r, ...op }), { deadlineMs: later() });
      check("cancelling a stamped root retains it, nonterminal", cancel.kind === "pending" && cancel.root === "retained-stamped", cancel);
      const ch = await value(records, k.head);
      check("the cancelling head preserves the stamp and derives the plan from the root row",
        ch?.state === "service-cancelling" && ch.currentCredentialId === out.root.credentialId
        && (ch.rootPlan as { credentialId: string; expMs: number }).expMs === out.root.expMs, ch);
      check("the stamped root row is left active for a future retirement phase", (await value(auth, `cred.${r.native.lifecycleUid}.${out.root.credentialId}`))?.state === "active");
      check("the endpoint gate is revoked", (await readNativeServiceGate(reg, binding(r)))?.row.serviceAuthority.state === "revoked");
      check("the native gate is frozen under the cancel operation", (await value(auth, k.gate))?.state === "frozen");
      await throws("the unchanged active-root reader refuses the cancelling head", () => readRegistryServiceRoot(reg, binding(r), out.root.credentialId, Date.now()), /^service native root /);
      const headRev = await revision(records, k.head);
      const repeat = await cancelServiceCustody(sealServiceCancelIntent(freshHost().host, { reservation: r, ...op }), { deadlineMs: later() });
      check("re-running the same cancel operation resumes idempotently", repeat.kind === "pending" && repeat.root === "retained-stamped" && headRev === await revision(records, k.head), repeat);
      const foreign = await cancelServiceCustody(sealServiceCancelIntent(freshHost().host, { reservation: r, ...cancelOp() }), { deadlineMs: later() });
      check("a different cancel operation gets only a reference to the recorded one", foreign.kind === "foreign-operation" && foreign.opId === op.opId, foreign);
      const resumed = await runServiceBootstrap(sealServiceBootstrapIntent(freshHost().host, { reservation: r, notAfterMs: later() }));
      check("bootstrap after cancellation never returns the root", resumed.kind === "endpoint-revoked" || resumed.kind === "cancelled", resumed);
    }
  }

  console.log("D. cancellation before the root is stamped");
  {
    // Paused after the RootPlan CAS (second head write): the plan is durable, no root row exists.
    const r = reservation(), k = keys(r), first = freshHost();
    const sub = tripOnWrite(recordsBucket(SPACE), k.head, 2, first.trip);
    const paused = await runServiceBootstrap(sealServiceBootstrapIntent(first.host, { reservation: r, notAfterMs: later() }));
    sub.unsubscribe();
    const plan = (await value(records, k.head))?.rootPlan as { credentialId: string; expMs: number } | undefined;
    check("bootstrap paused with a durable plan and no root row", paused.kind === "held" && !!plan && (await auth.get(`cred.${r.native.lifecycleUid}.${plan.credentialId}`)) === null, { paused, plan });
    if (plan) {
      const cancel = await cancelServiceCustody(sealServiceCancelIntent(freshHost().host, { reservation: r, ...cancelOp() }), { deadlineMs: later() });
      check("cancellation create-fences the planned root key", cancel.kind === "pending" && cancel.root === "revoked" && cancel.rootDetail === "created-revoked", cancel);
      const root = await value(auth, `cred.${r.native.lifecycleUid}.${plan.credentialId}`);
      check("the fenced root row is revoked with the unchanged plan expiry and mirror", root?.state === "revoked" && root.exp === plan.expMs
        && (root.serviceCustody as { uidDigest: string }).uidDigest === contractDigest(r), root);
      const resumed = await runServiceBootstrap(sealServiceBootstrapIntent(freshHost().host, { reservation: r, notAfterMs: later() }));
      check("a resumed bootstrap cannot stage over the fence", resumed.kind !== "active" && (await value(auth, `cred.${r.native.lifecycleUid}.${plan.credentialId}`))?.state === "revoked", resumed);
    }
  }
  {
    // Paused after the root row create (first write to the planned root key), before the stamp.
    const r = reservation(), k = keys(r), first = freshHost();
    const prefix = `cred.${r.native.lifecycleUid}.`;
    let seen = 0;
    const sub = conn.subscribe(`$KV.${epAuthBucket(SPACE)}.${prefix}*`, { callback: () => { if (++seen === 1) first.trip("fixture pause at root create"); } });
    const paused = await runServiceBootstrap(sealServiceBootstrapIntent(first.host, { reservation: r, notAfterMs: later() }));
    sub.unsubscribe();
    const plan = (await value(records, k.head))?.rootPlan as { credentialId: string; expMs: number } | undefined;
    check("bootstrap paused with an active unstamped root row", paused.kind === "held" && !!plan && (await value(auth, `${prefix}${plan.credentialId}`))?.state === "active", paused);
    const cancel = await cancelServiceCustody(sealServiceCancelIntent(freshHost().host, { reservation: r, ...cancelOp() }), { deadlineMs: later() });
    check("cancellation revokes the exact unstamped root by CAS", cancel.kind === "pending" && cancel.rootDetail === "cas-revoked"
      && !!plan && (await value(auth, `${prefix}${plan.credentialId}`))?.state === "revoked", cancel);
  }
  {
    // Bootstrap paused at the native gate create; cancellation paused right after its endpoint deny.
    const r = reservation(), k = keys(r), first = freshHost();
    let sub = tripOnWrite(epAuthBucket(SPACE), k.gate, 1, first.trip);
    await runServiceBootstrap(sealServiceBootstrapIntent(first.host, { reservation: r, notAfterMs: later() }));
    sub.unsubscribe();
    const second = freshHost();
    sub = tripOnWrite(epAuthBucket(SPACE), k.epgate, 1, second.trip);
    const cut = await cancelServiceCustody(sealServiceCancelIntent(second.host, { reservation: r, ...cancelOp() }), { deadlineMs: later() });
    sub.unsubscribe();
    check("cancellation paused after the endpoint deny is held", cut.kind === "held" && (await readNativeServiceGate(reg, binding(r)))?.row.serviceAuthority.state === "revoked", cut);
    const resumed = await runServiceBootstrap(sealServiceBootstrapIntent(freshHost().host, { reservation: r, notAfterMs: later() }));
    check("bootstrap refuses once the endpoint is revoked, writing no plan", resumed.kind === "endpoint-revoked" && (await value(records, k.head))?.rootPlan === null, resumed);
  }

  console.log("E. refusals and unconfirmed reservations");
  {
    const r = reservation("org.example.unbound"), k = keys(r);
    const out = await runServiceBootstrap(sealServiceBootstrapIntent(freshHost().host, { reservation: r, notAfterMs: later() }));
    check("an unbound service name refuses before any write", out.kind === "name-unbound" && (await records.get(k.uid)) === null, out);
  }
  {
    const r = reservation(), k = keys(r);
    await tryReserveUid(reg, r.native.lifecycleUid, { owner: OWNER, actor: "cli", mintedBy: "fixture" });
    const out = await runServiceBootstrap(sealServiceBootstrapIntent(freshHost().host, { reservation: r, notAfterMs: later() }));
    check("an ordinary reservation burns the candidate with no head written", out.kind === "uid-burned" && (await records.get(k.head)) === null, out);
    const cancel = await cancelServiceCustody(sealServiceCancelIntent(freshHost().host, { reservation: r, ...cancelOp() }), { deadlineMs: later() });
    check("cancellation of a burned candidate refuses without fencing anything", cancel.kind === "uid-foreign"
      && (await auth.get(k.epgate)) === null && (await records.get(k.head)) === null && (await auth.get(k.gate)) === null, cancel);
  }
  {
    const r = reservation(), k = keys(r);
    await records.create(k.head, new TextEncoder().encode(JSON.stringify({ owner: OWNER, actor: r.assignment.actor, lifecycleUid: mintLifecycleUid(), managerInstance: "fixture", processEpoch: 1, state: "active" })));
    const out = await runServiceBootstrap(sealServiceBootstrapIntent(freshHost().host, { reservation: r, notAfterMs: later() }));
    check("an ordinary head at the alias is an identity collision, never replaced", out.kind === "identity-collision" && (await value(records, k.head))?.managerInstance === "fixture", out);
  }
  {
    const r = reservation(), k = keys(r);
    const out = await cancelServiceCustody(sealServiceCancelIntent(freshHost().host, { reservation: r, ...cancelOp() }), { deadlineMs: later() });
    check("cancellation with no reservation denies the endpoint and stays unconfirmed",
      out.kind === "uid-unconfirmed" && (await readNativeServiceGate(reg, binding(r)))?.row.serviceAuthority.state === "revoked"
      && (await records.get(k.head)) === null && (await auth.get(k.gate)) === null, out);
    const boot = await runServiceBootstrap(sealServiceBootstrapIntent(freshHost().host, { reservation: r, notAfterMs: later() }));
    check("a later bootstrap refuses before reserving the UID", boot.kind === "endpoint-revoked" && (await records.get(k.uid)) === null, boot);
    const expired = await cancelServiceCustody(sealServiceCancelIntent(freshHost().host, { reservation: r, ...cancelOp() }), { deadlineMs: Date.now() - 1 });
    check("a cancel invocation past its explicit deadline holds", expired.kind === "held" && expired.reason === "deadline", expired);
  }
  const movePlane = async () => {
    const plane = (await auth.get(PLANE_CLAIM_KEY))!;
    const moved = await auth.update(PLANE_CLAIM_KEY, new TextEncoder().encode(JSON.stringify({ ...JSON.parse(dec.decode(plane.value)), claimId: "NFOREIGNCLAIM" })), plane.revision);
    return async () => { await auth.update(PLANE_CLAIM_KEY, plane.value, moved); };
  };
  const active = async (r: ServiceUidCustodyV1) => {
    const out = await runServiceBootstrap(sealServiceBootstrapIntent(freshHost().host, { reservation: r, notAfterMs: later() }));
    if (out.kind !== "active") throw new Error(`fixture bootstrap did not reach active: ${JSON.stringify(out)}`);
  };

  console.log("F. a held endpoint-gate read on the writer's own request path");
  {
    // Hold the RESPONSE of the writer's own leader read of the endpoint gate, the read whose result
    // drives the deny CAS, on the registry's own manager handle. The check first proves the hold
    // was reached, then that no endpoint-gate write starts after the deadline or a claim loss.
    const streams = registryStores(reg).jsm.streams;
    const realGetMessage = streams.getMessage.bind(streams);
    let arm: { subject: string; hit: () => void; release: Promise<void>; returned: () => void } | undefined;
    streams.getMessage = (async (...args: Parameters<typeof realGetMessage>) => {
      const m = await realGetMessage(...args);
      const a = arm, q = args[1] as { last_by_subj?: string } | undefined;
      if (a && q?.last_by_subj === a.subject) { arm = undefined; a.hit(); await a.release; queueMicrotask(a.returned); }
      return m;
    }) as typeof streams.getMessage;
    for (const variant of ["deadline", "claim lost, released after return", "claim lost, released before return"] as const) {
      const r = reservation(), k = keys(r);
      await active(r);
      const before = await revision(auth, k.epgate);
      const writes: number[] = [];
      const sub = conn.subscribe(`$KV.${epAuthBucket(SPACE)}.${k.epgate}`, { callback: () => { writes.push(Date.now()); } });
      let hit!: () => void, release!: () => void, returned!: () => void;
      const hitP = new Promise<void>((x) => { hit = x; }), returnedP = new Promise<void>((x) => { returned = x; });
      arm = { subject: `$KV.${epAuthBucket(SPACE)}.${k.epgate}`, hit, returned, release: new Promise<void>((x) => { release = x; }) };
      const deadlineMs = variant === "deadline" ? Date.now() + 1_500 : later();
      const running = cancelServiceCustody(sealServiceCancelIntent(freshHost().host, { reservation: r, ...cancelOp() }), { deadlineMs });
      const reached = (await within(hitP.then(() => true), 10_000)) === true;
      const restore = variant !== "deadline" && reached ? await movePlane() : undefined;
      if (variant === "claim lost, released before return") release();
      const out = await running;
      const atReturn = writes.length;
      release();
      await within(returnedP, 5_000);
      await conn.flush();
      await within(new Promise<void>((x) => { const t = setInterval(() => { if (writes.length > atReturn) { clearInterval(t); x(); } }, 25); setTimeout(() => clearInterval(t), 2_000); }), 2_000);
      sub.unsubscribe();
      if (restore) await restore();
      arm = undefined;
      check(`${variant}: the held endpoint-gate read was reached`, reached);
      check(`${variant}: the writer reports held`, out.kind === "held" && (variant !== "claim lost, released before return" || out.reason === "readiness"), out);
      check(`${variant}: no endpoint-gate write starts, before or after the writer returned`,
        writes.length === 0 && (await revision(auth, k.epgate)) === before, { writes: writes.length, atReturn, before, after: await revision(auth, k.epgate) });
    }
    streams.getMessage = realGetMessage;
  }

  console.log("G. the genuine hold's own check, not its mutable guard field");
  for (const variant of ["guard object replaced after open", "guard method replaced after open", "guard object replaced before open"] as const) {
    const r = reservation(), k = keys(r);
    const original: ScanGuard = hold.guard, originalMethod = hold.guard.assertHeld;
    const mutate = () => {
      if (variant === "guard method replaced after open") hold.guard.assertHeld = async () => {};
      else (hold as { guard: ScanGuard }).guard = { assertHeld: async () => {} };
    };
    if (variant === "guard object replaced before open") mutate();
    const { host } = freshHost();
    if (variant !== "guard object replaced before open") mutate();
    const restore = await movePlane();
    const out = await runServiceBootstrap(sealServiceBootstrapIntent(host, { reservation: r, notAfterMs: later() }));
    const wrote = (await records.get(k.uid)) !== null;
    (hold as { guard: ScanGuard }).guard = original; original.assertHeld = originalMethod;
    await restore();
    check(`${variant}: a moved claim still holds with no reservation written`, out.kind === "held" && !wrote, { out, wrote });
  }

  console.log("H. a frozen activation native gate at generation 1 is not canonical");
  for (const variant of ["creation op", "foreign op"] as const) {
    const r = reservation(), k = keys(r), first = freshHost();
    const sub = tripOnWrite(recordsBucket(SPACE), k.head, 1, first.trip);
    await runServiceBootstrap(sealServiceBootstrapIntent(first.host, { reservation: r, notAfterMs: later() }));
    sub.unsubscribe();
    const seeded = { lifecycleUid: r.native.lifecycleUid, state: "frozen", generation: 1, serviceCustody: { v: 1, uidDigest: contractDigest(r) },
      op: { opId: variant === "creation op" ? r.creation.operationId : mintLifecycleUid(), kind: "activation" } };
    const seededRev = await auth.put(k.gate, new TextEncoder().encode(JSON.stringify(seeded)), { previousSeq: 0 });
    let parsed = true;
    try { parseServiceNativeGate(structuredClone(seeded), serviceCustodyIdentity(r)); } catch { parsed = false; }
    check(`${variant}: the shared parser refuses it`, !parsed);
    const boot = await runServiceBootstrap(sealServiceBootstrapIntent(freshHost().host, { reservation: r, notAfterMs: later() }));
    check(`${variant}: bootstrap holds without touching the gate`, boot.kind === "held" && (await revision(auth, k.gate)) === seededRev, boot);
    const cancel = await cancelServiceCustody(sealServiceCancelIntent(freshHost().host, { reservation: r, ...cancelOp() }), { deadlineMs: later() });
    check(`${variant}: cancellation holds instead of normalizing the gate`, cancel.kind === "held" && (await revision(auth, k.gate)) === seededRev, cancel);
  }
} finally {
  await nc?.close().catch(() => {});
  broker.kill("SIGTERM");
  await new Promise<void>((r) => { if (broker.exitCode !== null || broker.signalCode !== null) r(); else broker.once("exit", () => r()); });
  releaseBroker();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`SERVICE-CUSTODY writer: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
