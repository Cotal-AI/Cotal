/** Owned-broker suite for public service registration and serving. One hosted context
 * (`startAuthService` with `serviceEndpoints`) on a JWT-permission broker serves the door on its
 * loopback and public faces and composes the native service callout. The provider client and raw
 * HTTP reach it; the host handle binds names, approves, refuses and revokes. Two unrelated
 * ephemeral services, owned by different owners, run the whole path: approved register, activate,
 * a real service connection through the callout, ready and renew. The signed IdP is a loopback
 * fixture and the owners' interactive rows are fixture rows.
 *
 * Sections E and F also exercise the named stop points. "sim stop" means the fixture writes the
 * durable state a stop at that point leaves, with the engine's own record shapes and the native
 * barrier and registration primitives, and then drives the real door. Nothing here is native,
 * Cloud or production acceptance, and nothing proves a human decision. */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { KvWatchInclude, Kvm, type KV } from "@nats-io/kv";
import { connect, credsAuthenticator, tokenAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  GOVERNED_TRAIT_URNS, VOID_SCHEMA_DIGEST, contractArtifactCanonicalBytes, contractDigest, contractStoreContext, endpointRegistrationBarrier,
  endpointToken, epAuthBucket, epgateKey, mintCreds, newIdentity, parseServiceAuthorityResult, publishContractArtifact, recordsBucket,
  registerServiceInstance, serviceAuthorityRequestDigest, serviceWitnessDigest, setupSpaceStreams, singleDocumentClosure,
  type SecretStore, type ServiceAuthorityRequest, type ServiceAuthorityResult, type ServiceRegistrationWitness,
} from "@cotal-ai/core";
import { openAuthorityClient } from "../src/authority-client.js";
import { cotalAuthProvider } from "../src/provider.js";
import { deriveOwnerForIdpSubject } from "../src/derive.js";
import { grantActor } from "../src/ledger.js";
import { fetchIdpJwt, saveIdpSession } from "../src/login.js";
import { openLifecycleRegistry } from "../src/lifecycle-registry.js";
import { readNativeIssuance } from "../src/native-issuance.js";
import { nativeServiceNameAuthority } from "../src/native-service-name.js";
import { authClientSentinelKey, ensurePinnedIdp, loadOwnerSecret, saveAuthServiceInfo } from "../src/store.js";
import type { ServiceEndpointHost, ServiceHostRequest, ServiceHostResult } from "../src/service-host-contract.js";
import { serviceAuthorityEngineRequestId } from "../src/service-endpoint-authority.js";
import { parseServiceRequestIntentIndexRecord, parseServiceRequestIntentRecord, serviceHostOperationId } from "../src/service-host-ops.js";
import { startAuthService, type AuthServiceHandle } from "../src/service.js";
import { checks } from "./_service-custody-fixture.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const c = checks();
const rid = () => randomBytes(16).toString("hex");
const call = (host: ServiceEndpointHost, req: object): Promise<ServiceHostResult> => host(req as ServiceHostRequest);
const operator = { kind: "operator", auditId: "fixture-operator" } as const;
const enc = new TextEncoder(), dec = new TextDecoder();
const nowS = () => Math.floor(Date.now() / 1000);

// ---- the signed IdP fixture -----------------------------------------------------------------------
const key = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(key.publicKey), kid: "svserve-idp" };
const sessions = new Map<string, string>();
let origin = "";
const mint = (sub: string) => {
  const now = nowS();
  return new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setIssuer(origin).setAudience(origin).setSubject(sub).setIssuedAt(now).setExpirationTime(now + 120).sign(key.privateKey);
};
const idp = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/auth/jwks") return void res.end(JSON.stringify({ keys: [jwk] }));
  const sub = req.url === "/api/auth/token" ? sessions.get((req.headers.authorization ?? "").replace(/^Bearer /, "")) : undefined;
  if (sub === undefined) { res.writeHead(401); return void res.end("{}"); }
  res.end(JSON.stringify({ token: await mint(sub) }));
});
await new Promise<void>((r) => idp.listen(0, "127.0.0.1", () => r()));
origin = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
const idpUrl = `${origin}/api/auth`;
for (const s of ["a", "b"]) sessions.set(`session-${s}`, `user-${s}`);

// ---- contract fixtures --------------------------------------------------------------------------
const cmd = (name: string, traits: string[] = []) => ({ name, class: "ephemeral", targeted: false, capability: "read", inputDigest: VOID_SCHEMA_DIGEST, outputDigest: VOID_SCHEMA_DIGEST,
  ...(traits.length ? { traits } : {}) });
const cluster = (urn: string, commands: object[]) => {
  const document = { urn, revision: 1, attributes: [], events: [], commands };
  return { document, ...singleDocumentClosure(document) };
};
type Cluster = ReturnType<typeof cluster>;
const registration = (x: Cluster) => ({ clusterDigests: [x.closureDigest], contractArtifacts: [x.manifest, x.document] });

const fx = await startHostedAuthFixture("svserve", 1);
const [a] = fx.accounts;
const space = a.space, accountPublicKey = a.accountPublicKey;
const handles: AuthServiceHandle[] = [];
const conns: NatsConnection[] = [];
const prevHome = process.env.COTAL_HOME;
let harness: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
try {
  await setupSpaceStreams({ servers: fx.servers, space, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  const stateDir = join(fx.dir, "svserve-state"), clientDir = join(fx.dir, "svserve-client"), home = join(fx.dir, "svserve-home");
  for (const d of [stateDir, clientDir, home]) mkdirSync(d, { recursive: true });
  ensurePinnedIdp(stateDir, idpUrl); ensurePinnedIdp(clientDir, idpUrl);
  const ownerSecret = (await loadOwnerSecret(a.store, space))!;
  const [ownerA, ownerB] = ["user-a", "user-b"].map((sub) => deriveOwnerForIdpSubject(ownerSecret, origin, sub));
  grantActor(stateDir, { owner: ownerA, actor: "cli", scope: [], allowSubscribe: [], allowPublish: [] });
  grantActor(stateDir, { owner: ownerB, actor: "web", scope: [], allowSubscribe: [], allowPublish: [] });
  process.env.COTAL_HOME = home;
  const signIn = (s: "a" | "b") => saveIdpSession(home, idpUrl, { token: `session-${s}`, expiresAt: nowS() + 600, sub: `user-${s}` });
  const on = await startAuthService({ context: { accountPublicKey, lifecycleUid: "life-0" }, space, servers: fx.servers, store: a.store, storeIdentity: a.store.identity,
    stateDir, publicFace: { port: 0, trustedProxy: false }, serviceEndpoints: { startup: { kind: "normal" } } });
  handles.push(on);
  const host = on.serviceEndpointHost!, pub = on.publicUrl!;
  saveAuthServiceInfo(clientDir, { url: on.url, pid: process.pid, cap: on.cap });
  const clientStore: SecretStore = {
    get: async (k) => (k === authClientSentinelKey(space) ? a.sentinelCreds : undefined),
    put: async () => { throw new Error("client must not write the store"); }, create: async () => false, delete: async () => {},
  };
  harness = await openAuthorityClient({ server: fx.servers, space, dataAccount: { pub: a.auth.account.pub, signingSeed: a.auth.account.signingSeed! },
    label: `harness:${space}`, grants: (id) => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
  const authKv: KV = await new Kvm(harness.nc).open(epAuthBucket(space)), recordsKv: KV = await new Kvm(harness.nc).open(recordsBucket(space));
  const harnessReg = await openLifecycleRegistry(harness.nc, space), store = await contractStoreContext(harness.nc, space);

  // ---- request, proof and record helpers ----
  type Who = "a" | "b";
  type ServiceAuthorityProof = { kind: "service-renewal" | "service-access"; token: string };
  const ownerOf = (w: Who) => (w === "a" ? ownerA : ownerB);
  const req = (operation: string, endpoint: string, instanceId: string, fields: object, requestId = rid()) =>
    ({ v: 1, kind: "service-endpoint-authority", operation, requestId, space, accountPublicKey, endpoint, instanceId, ...fields }) as ServiceAuthorityRequest;
  const registerReq = (ep: string, iid: string, x: Cluster, expected: ServiceRegistrationWitness | null = null, requestId = rid()) =>
    req("register", ep, iid, { registration: registration(x), expected: expected === null ? { state: "unregistered" } : { state: "registered", witness: expected } }, requestId);
  const witnessReq = (op: "activate" | "renew" | "ready", w: ServiceRegistrationWitness, requestId = rid()) => req(op, w.endpoint, w.instanceId, { witness: w }, requestId);
  const statusReq = (ep: string, iid: string, target: object) => req("status", ep, iid, { target });
  const opStatus = (r: ServiceAuthorityRequest) => statusReq(r.endpoint, r.instanceId, { kind: "operation", operation: r.operation, requestId: r.requestId });
  const viaProvider = async (who: Who, r: ServiceAuthorityRequest, proof?: ServiceAuthorityProof): Promise<ServiceAuthorityResult> => {
    signIn(who);
    return (await cotalAuthProvider.serviceEndpointAuthority!({ store: clientStore, dir: clientDir, request: r, ...(proof ? { proof } : {}) })).result;
  };
  const idpProof = async (s: Who) => ({ kind: "idp" as const, token: await fetchIdpJwt(idpUrl, `session-${s}`) });
  /** Raw HTTP on a face: the status code and, below 500, the body the core parser accepts for this request. */
  const raw = async (base: string, request: unknown, proof: unknown) => {
    const r = await fetch(`${base}/service-endpoint-authority`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ request, proof }) });
    const body = JSON.parse(await r.text()) as Record<string, unknown>;
    let parsed: ServiceAuthorityResult | undefined;
    try { if (r.status < 500) parsed = parseServiceAuthorityResult(body, request as ServiceAuthorityRequest); } catch { parsed = undefined; }
    return { status: r.status, body, parsed };
  };
  const denied = (r: ServiceAuthorityResult | undefined, reason: string) => r?.state === "denied" && r.reason === reason;
  const st = (r: ServiceAuthorityResult | undefined) => (r?.state === "status" ? r.status : undefined);
  const engineId = (owner: string, r: ServiceAuthorityRequest, operation = r.operation, requestId = r.requestId) =>
    serviceHostOperationId(space, serviceAuthorityEngineRequestId({ space, accountPublicKey }, owner, r, operation, requestId));
  const propRead = (proposalId: string) => call(host, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "proposal-read", input: { proposalId }, granter: operator });
  const bindName = async (ep: string, who: Who) => {
    const r = await call(host, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "name-bind", granter: operator,
      input: { endpoint: ep, owner: ownerOf(who), expectedRevision: 0, claimReference: "fixture-verified-namespace" } });
    if (r.state !== "bound") throw new Error(`fixture name binding failed: ${JSON.stringify(r)}`);
    return r.binding.revision;
  };
  const names = new Map<string, number>();
  /** One approved selector: the proposal-phase register, then the owner's approval through the host. */
  const approved = async (who: Who, ep: string, x: Cluster) => {
    if (!names.has(ep)) names.set(ep, await bindName(ep, who));
    const proposal = registerReq(ep, rid(), x);
    const first = await viaProvider(who, proposal);
    if (first.state !== "approval-required") throw new Error(`fixture proposal not admitted: ${JSON.stringify(first)}`);
    const p = await propRead(first.proposalId);
    const d = await call(host, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "decide", granter: { kind: "owner", owner: ownerOf(who) },
      input: { proposalId: first.proposalId, expectedProposalRevision: p.state === "present" ? p.record.revision : 0, expectedNameRevision: names.get(ep)!, decision: "approve", callerCeiling: [] } });
    if (d.state !== "approved") throw new Error(`fixture approval failed: ${JSON.stringify(d)}`);
    return { who, ep, x, instanceId: proposal.instanceId, proposal, proposalId: first.proposalId, assignmentDigest: d.approval.assignment.assignmentDigest };
  };
  type Approved = Awaited<ReturnType<typeof approved>>;
  const revoke = (s: Approved) => call(host, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "revoke", granter: { kind: "owner", owner: ownerOf(s.who) },
    input: { endpoint: s.ep, instanceId: s.instanceId, expectedAssignmentDigest: s.assignmentDigest, cause: "owner-request" } });
  const registered = async (s: Approved, r = s.proposal) => {
    const out = await viaProvider(s.who, r);
    if (out.state !== "registered") throw new Error(`fixture registration failed: ${JSON.stringify(out)}`);
    return out.witness;
  };
  const credential = async (who: Who, r: ServiceAuthorityRequest, proof?: ServiceAuthorityProof) => {
    const out = await viaProvider(who, r, proof);
    if (out.state !== "credential") throw new Error(`fixture credential failed: ${JSON.stringify(out)}`);
    return out;
  };
  const gate = async (ep: string, iid: string) => {
    const e = (await authKv.get(epgateKey(ep, iid)))!;
    return { revision: e.revision, row: JSON.parse(dec.decode(e.value)) as { state: string; generation: number; processEpoch: number;
      serviceAuthority: { activationIssued: boolean; registration?: { requestId: string; operationId: string }; pendingRegistration?: { operationId: string; requestId: string } } } };
  };
  const indexOf = async (ep: string, iid: string) => {
    const e = await authKv.get(`svcintx.${endpointToken(ep)}.${iid}`);
    return e ? { revision: e.revision, row: parseServiceRequestIntentIndexRecord(JSON.parse(dec.decode(e.value))) } : undefined;
  };
  // sim stop: the index entry and intent row the engine writes before an effect, in its own shapes.
  const simIndex = async (owner: string, r: ServiceAuthorityRequest) => {
    const id = engineId(owner, r), cur = await indexOf(r.endpoint, r.instanceId);
    const intents = [...(cur?.row.intents ?? []), { operationId: id, operation: r.operation as "register" }].sort((x, y) => (x.operationId < y.operationId ? -1 : 1));
    const row = parseServiceRequestIntentIndexRecord({ v: 1, kind: "service-request-intent-index", owner, endpoint: r.endpoint, instanceId: r.instanceId, intents });
    const key = `svcintx.${endpointToken(r.endpoint)}.${r.instanceId}`;
    if (cur) await authKv.update(key, enc.encode(JSON.stringify(row)), cur.revision); else await authKv.create(key, enc.encode(JSON.stringify(row)));
    return id;
  };
  const simIntent = async (owner: string, r: ServiceAuthorityRequest) => {
    const id = await simIndex(owner, r);
    const w = "witness" in r ? r.witness : r.operation === "register" && r.expected.state === "registered" ? r.expected.witness : null;
    const row = parseServiceRequestIntentRecord({ v: 1, kind: "service-request-intent", operationId: id, operation: r.operation, account: { accountPublicKey, space },
      owner, endpoint: r.endpoint, instanceId: r.instanceId, requestId: r.requestId, requestDigest: serviceAuthorityRequestDigest(r),
      registrationRequestId: w?.registrationRequestId ?? null, witnessDigest: w ? serviceWitnessDigest(w) : null, admittedAtMs: Date.now() });
    await authKv.create(`svcint.${id}`, enc.encode(JSON.stringify(row)));
    return id;
  };
  const barrierFor = (r: ServiceAuthorityRequest, id: string) => {
    const { progress: _p, ...b } = endpointRegistrationBarrier(authKv, space, { endpoint: r.endpoint, instanceId: r.instanceId, opId: id,
      serviceRegistration: { requestId: r.requestId, requestDigest: serviceAuthorityRequestDigest(r) } });
    void _p;
    return b;
  };
  /** sim stop after the freeze CAS: the barrier's own freeze, at the gate's current revision. */
  const simFreeze = async (r: ServiceAuthorityRequest, id: string) => barrierFor(r, id).freeze((await gate(r.endpoint, r.instanceId)).revision);
  /** sim stop after the spec write, before reopen: the native registration with its reopen stopped. */
  const simSpec = async (s: Approved, r: ServiceAuthorityRequest, id: string) => {
    const artifacts = new Map([s.x.manifest, s.x.document].map((v) => [contractDigest(v), v] as const));
    try {
      await registerServiceInstance(recordsKv, { space, instanceId: r.instanceId, registrant: { owner: ownerOf(s.who) },
        spec: { endpoint: r.endpoint, owner: ownerOf(s.who), clusterDigests: [s.x.closureDigest], protocol: { v: 1 } },
        authority: nativeServiceNameAuthority(harnessReg, { space, accountPublicKey }), readClusterArtifact: (d) => artifacts.get(d),
        barrier: { ...barrierFor(r, id), reopen: async () => { throw new Error("sim stop before reopen"); } } });
      return "completed";
    } catch (e) { return (e as Error).message; }
  };
  const dial = async (bearer: string) => {
    const nonce = randomBytes(16).toString("hex");
    const nc = await connect({ servers: fx.servers, name: nonce, inboxPrefix: `_INBOX_${nonce}`, timeout: 4000, reconnect: false, maxReconnectAttempts: 0,
      authenticator: [credsAuthenticator(enc.encode(a.sentinelCreds)), tokenAuthenticator(bearer)] });
    conns.push(nc);
    await nc.flush();
    return nc;
  };
  const natkeys = async () => { const out: string[] = []; for await (const k of await authKv.keys("natkey.*")) out.push(k); return new Set(out); };

  // ---- A: service one, the whole path ----
  const ordersEp = "org.example.orders", billingEp = "org.example.billing";
  const orders = cluster(ordersEp, [cmd("lookup")]), billing = cluster(billingEp, [cmd("charge")]);
  const s1 = await approved("a", ordersEp, orders);
  const sA = await viaProvider("a", opStatus(s1.proposal));
  c.check("A1 after approval the proposal's register status is approved-unregistered", st(sA)?.state === "approved-unregistered", sA);
  const regA = await viaProvider("a", s1.proposal);
  const w1 = regA.state === "registered" ? regA.witness : undefined;
  const g1 = await gate(ordersEp, s1.instanceId);
  c.check("A2 the approved register replay registers natively: the stamp names the request and a first registration keeps epoch 0",
    w1 !== undefined && w1.registrationRequestId === s1.proposal.requestId && g1.row.serviceAuthority.registration?.requestId === s1.proposal.requestId
    && g1.row.processEpoch === 0 && w1.processEpoch === 0 && g1.row.state === "open" && !g1.row.serviceAuthority.activationIssued, { regA, g1 });
  c.check("A2 the registered snapshot binds the submitted closure and both artifacts", regA.state === "registered"
    && regA.snapshot.spec.value.clusterDigests.join() === orders.closureDigest && regA.snapshot.contractArtifacts.length === 2, regA);
  const sReg = await viaProvider("a", opStatus(s1.proposal));
  c.check("A3 the register's operation status reads registered with the same witness", st(sReg)?.state === "registered"
    && serviceWitnessDigest((st(sReg) as { witness: ServiceRegistrationWitness }).witness) === serviceWitnessDigest(w1!), sReg);
  const act1 = witnessReq("activate", w1!), before = nowS();
  const cred1 = await credential("a", act1);
  const after = nowS(), g1a = await gate(ordersEp, s1.instanceId);
  c.check("A4 an IdP activate lands the activation CAS and returns material within the fixed bounds",
    g1a.row.serviceAuthority.activationIssued && cred1.accessExpiresAt > after && cred1.accessExpiresAt <= after + 60 && cred1.accessExpiresAt >= before
    && cred1.renewalExpiresAt > after && cred1.renewalExpiresAt <= after + 86_400, { cred1: { ...cred1, accessBearer: "<redacted>", renewalProof: "<redacted>" }, g1a: g1a.row });
  const keysBefore = await natkeys();
  const svc1 = await dial(cred1.accessBearer);
  const fresh = [...await natkeys()].filter((k) => !keysBefore.has(k));
  const receipt = fresh.length === 1 ? await readNativeIssuance(authKv, fresh[0]!.slice("natkey.".length)) : undefined;
  c.check("A5 the access bearer connects through the composed native service callout with a receipt for this witness",
    !svc1.isClosed() && receipt?.service !== undefined && serviceWitnessDigest(receipt.service.witness) === serviceWitnessDigest(w1!), { fresh, receipt });
  const rd1 = witnessReq("ready", w1!);
  const ready1 = await viaProvider("a", rd1, { kind: "service-access", token: cred1.accessBearer });
  const sInst = await viaProvider("a", statusReq(ordersEp, s1.instanceId, { kind: "instance" }), { kind: "service-renewal", token: cred1.renewalProof });
  c.check("A6 ready on the access proof records the service-reported status", ready1.state === "ready" && ready1.reportedAt >= before, ready1);
  c.check("A6 instance status on the renewal proof reads ready", st(sInst)?.state === "ready", sInst);
  const rn1 = witnessReq("renew", w1!);
  const cred2 = await credential("a", rn1, { kind: "service-renewal", token: cred1.renewalProof });
  const svc1b = await dial(cred2.accessBearer);
  // Ed25519 signing is deterministic: material renewed within the same second can be byte-identical.
  c.check("A7 renew on the renewal proof returns material no older than the first, and its bearer connects", cred2.accessExpiresAt >= cred1.accessExpiresAt
    && cred2.renewalExpiresAt >= cred1.renewalExpiresAt && !svc1b.isClosed() && cred2.renewalExpiresAt <= nowS() + 86_400, { exp: cred2.accessExpiresAt });
  const gBefore = await gate(ordersEp, s1.instanceId);
  const x1 = await viaProvider("a", s1.proposal), gAfter = await gate(ordersEp, s1.instanceId);
  c.check("A8 X1 a completed register replayed after activation and ready answers registered with the same witness, no freeze or epoch advance",
    x1.state === "registered" && serviceWitnessDigest(x1.witness) === serviceWitnessDigest(w1!) && gAfter.revision === gBefore.revision
    && gAfter.row.generation === gBefore.row.generation && gAfter.row.processEpoch === gBefore.row.processEpoch, { x1, gBefore: gBefore.row, gAfter: gAfter.row });
  const x1s = await viaProvider("a", opStatus(s1.proposal));
  c.check("A8 X1 the register's operation status reads ready after the report", st(x1s)?.state === "ready", x1s);

  // ---- B: an unrelated second service and owner ----
  const s2 = await approved("b", billingEp, billing);
  const w2 = await registered(s2);
  const credB = await credential("b", witnessReq("activate", w2));
  const svc2 = await dial(credB.accessBearer);
  const readyB = await viaProvider("b", witnessReq("ready", w2), { kind: "service-access", token: credB.accessBearer });
  const credB2 = await credential("b", witnessReq("renew", w2), { kind: "service-renewal", token: credB.renewalProof });
  c.check("B1 a second owner's unrelated service registers, activates, connects, reports ready and renews",
    w2.endpoint === billingEp && !svc2.isClosed() && readyB.state === "ready" && credB2.witness.instanceId === s2.instanceId, readyB);
  c.check("B1 both services stay connected at once", !svc1.isClosed() && !svc1b.isClosed() && !svc2.isClosed());
  const crossRead = await viaProvider("b", opStatus(act1));
  c.check("B2 another owner cannot read the first service's activate status", denied(crossRead, "not-found"), crossRead);

  // ---- C: the proof matrix, bounds and refusals ----
  const renewIdp = await raw(on.url, rn1, await idpProof("a")), readyRenewal = await raw(on.url, rd1, { kind: "service-renewal", token: cred1.renewalProof });
  const regRenewal = await raw(on.url, s1.proposal, { kind: "service-renewal", token: cred1.renewalProof });
  c.check("C1 renew on IdP, ready on renewal and register on renewal are bad shape (400)", renewIdp.status === 400 && readyRenewal.status === 400 && regRenewal.status === 400,
    { renewIdp: renewIdp.status, readyRenewal: readyRenewal.status, regRenewal: regRenewal.status });
  const garbage = await raw(on.url, rn1, { kind: "service-renewal", token: "not-a-jwt" });
  const swapped = await raw(on.url, rn1, { kind: "service-renewal", token: cred1.accessBearer });
  const otherWitness = { ...w1!, registrationRevision: w1!.registrationRevision + 7 };
  const mismatch = await raw(on.url, witnessReq("renew", otherWitness), { kind: "service-renewal", token: cred1.renewalProof });
  c.check("C2 a malformed renewal, an access bearer as renewal, and a proof for another witness are unauthenticated (401)",
    garbage.status === 401 && swapped.status === 401 && mismatch.status === 401 && denied(mismatch.parsed, "unauthenticated"), { garbage: garbage.status, swapped: swapped.status, mismatch: mismatch.status });
  const governed = cluster("org.example.guarded", [cmd("pay", [GOVERNED_TRAIT_URNS[0]!])]);
  const g = await raw(on.url, registerReq("org.example.guarded", rid(), governed), await idpProof("a"));
  c.check("C3 a governed trait refuses as unsupported-runtime (422) and binds nothing", g.status === 422 && denied(g.parsed, "unsupported-runtime"), g.body);
  const bWitness = await raw(on.url, witnessReq("activate", w1!), { kind: "service-renewal", token: credB.renewalProof });
  c.check("C4 another service's renewal proof cannot act on this witness (401)", bWitness.status === 401, bWitness.body);
  const ownStatus = await viaProvider("a", opStatus(rn1), { kind: "service-renewal", token: cred2.renewalProof });
  const otherStatus = await viaProvider("b", opStatus(rn1), { kind: "service-renewal", token: credB2.renewalProof });
  c.check("C5 a renewal proof reads its own witness's intents and not another service's", st(ownStatus)?.state === "ready" && denied(otherStatus, "not-found"), { ownStatus, otherStatus });

  // ---- D: ownership, quota and persisted keys ----
  const idxBefore = await indexOf(ordersEp, s1.instanceId);
  const x2: unknown[] = [];
  for (let n = 0; n < 3; n++) x2.push((await raw(on.url, witnessReq("activate", w1!), await idpProof("b"))).status);
  const idxAfter = await indexOf(ordersEp, s1.instanceId);
  c.check("D1 X2 another owner's IdP activates naming this witness are 403 and touch no index", x2.every((s) => s === 403) && idxAfter?.revision === idxBefore?.revision, { x2 });
  const x3a = await credential("a", rn1, { kind: "service-renewal", token: cred2.renewalProof });
  const x3b = await viaProvider("a", rd1, { kind: "service-access", token: x3a.accessBearer });
  const idxX3 = await indexOf(ordersEp, s1.instanceId);
  c.check("D2 X3 a restarted service replays its persisted renew and ready keys with fresh proofs; the index is unchanged",
    x3b.state === "ready" && idxX3?.revision === idxBefore?.revision && idxX3?.row.intents.length === idxBefore?.row.intents.length, { count: idxX3?.row.intents.length });
  const sq = await approved("a", ordersEp, orders), wq = await registered(sq), credQ = await credential("a", witnessReq("activate", wq));
  let proof = credQ.renewalProof, last: ServiceAuthorityResult | undefined, count = (await indexOf(ordersEp, sq.instanceId))!.row.intents.length;
  const firstRenew = witnessReq("renew", wq);
  while (count < 64) {
    const r = count === 2 ? firstRenew : witnessReq("renew", wq);
    last = await viaProvider("a", r, { kind: "service-renewal", token: proof });
    if (last.state !== "credential") break;
    proof = last.renewalProof; count = (await indexOf(ordersEp, sq.instanceId))!.row.intents.length;
  }
  const over = await raw(on.url, witnessReq("renew", wq), { kind: "service-renewal", token: proof });
  const listed = await viaProvider("a", firstRenew, { kind: "service-renewal", token: proof });
  c.check("D3 the 65th intent of one instance is resource-exhausted (429) before any effect", count === 64 && over.status === 429 && denied(over.parsed, "resource-exhausted"), { count, over: over.status, last: last?.state });
  c.check("D3 a listed request still replays at the bound", listed.state === "credential", listed.state);

  // ---- E: stop points (a)-(k), each with resume, current and cancel ----
  const current = async () => st(await viaProvider("a", statusReq(ordersEp, s1.instanceId, { kind: "instance" })))?.state === "ready";
  const regStatus = async (who: Who, r: ServiceAuthorityRequest) => {
    const res = await raw(on.url, opStatus(r), await idpProof(who));
    return res.status === 503 ? "503" : st(res.parsed) ? `${st(res.parsed)!.state}${"phase" in st(res.parsed)! ? `:${(st(res.parsed) as { phase: string }).phase}` : ""}` : JSON.stringify(res.body);
  };
  /** Run one stop point: `stop` leaves the durable state for a fresh approved instance; the replay
   *  then resumes it, and on a second instance a host revoke cancels it. */
  const point = async (label: string, ep: string, prepare: (s: Approved) => Promise<{ r: ServiceAuthorityRequest; who: Who; proof?: ServiceAuthorityProof }>,
    expect: { at: string; resumed: string; cancelled: string }) => {
    const sr = await approved("a", ep, ep === ordersEp ? orders : cluster(ep, [cmd("lookup")]));
    const run = await prepare(sr);
    const at = await regStatus("a", run.r);
    const res = await viaProvider(run.who, run.r, run.proof);
    const resumed = await regStatus("a", run.r);
    c.check(`E${label} (sim stop) status ${expect.at}, the replay resumes to ${res.state}, status ${expect.resumed}, and current reads are unaffected`,
      at === expect.at && resumed === expect.resumed && await current(), { at, res: res.state === "denied" ? res : res.state, resumed });
    const sc = await approved("a", ep === ordersEp ? ordersEp : `${ep}-c`, ep === ordersEp ? orders : cluster(`${ep}-c`, [cmd("lookup")]));
    const cancelRun = await prepare(sc);
    const rv = await revoke(sc);
    const cs = await regStatus("a", cancelRun.r), refused = await viaProvider(cancelRun.who, cancelRun.r, cancelRun.proof);
    c.check(`E${label} (sim stop) cancel: the host revoke reads ${expect.cancelled} and the replay is refused with no effect`,
      rv.state === "pending" && cs === expect.cancelled && refused.state === "denied", { rv: rv.state, cs, refused });
    return { sr, run, res };
  };
  await point("(a) index only", ordersEp, async (s) => { await simIndex(ownerA, s.proposal); return { r: s.proposal, who: "a" }; },
    { at: "503", resumed: "registered", cancelled: "503" });
  await point("(b) intent, no artifact", ordersEp, async (s) => { await simIntent(ownerA, s.proposal); return { r: s.proposal, who: "a" }; },
    { at: "registering:admitted", resumed: "registered", cancelled: "revoking:deny-new-landed" });
  await point("(c) one artifact published", ordersEp, async (s) => {
    await simIntent(ownerA, s.proposal); await publishContractArtifact(store, contractArtifactCanonicalBytes(s.x.manifest));
    return { r: s.proposal, who: "a" };
  }, { at: "registering:admitted", resumed: "registered", cancelled: "revoking:deny-new-landed" });
  const d = await point("(d) frozen, no spec", ordersEp, async (s) => {
    const id = await simIntent(ownerA, s.proposal); await simFreeze(s.proposal, id); return { r: s.proposal, who: "a" };
  }, { at: "registering:barrier", resumed: "registered", cancelled: "revoking:deny-new-landed" });
  const gd = await gate(ordersEp, d.sr.instanceId);
  c.check("E(d) the resumed registration completes the same operation", gd.row.serviceAuthority.registration?.operationId === engineId(ownerA, d.run.r), gd.row);
  let eStop = "";
  await point("(e) spec written, no reopen", "org.example.stop-e", async (s) => {
    const id = await simIntent(ownerA, s.proposal); eStop = await simSpec(s, s.proposal, id); return { r: s.proposal, who: "a" };
  }, { at: "registering:barrier", resumed: "registered", cancelled: "revoking:deny-new-landed" });
  c.check("E(e) the stop came from the stopped reopen, which left the gate frozen", /sim stop before reopen/.test(eStop) && /left frozen/.test(eStop), eStop);
  const f = await point("(f) registered, reply lost", ordersEp, async (s) => { await registered(s); return { r: s.proposal, who: "a" }; },
    { at: "registered", resumed: "registered", cancelled: "revoking:deny-new-landed" });
  const gf = await gate(ordersEp, f.sr.instanceId), fAgain = await viaProvider("a", f.run.r), gf2 = await gate(ordersEp, f.sr.instanceId);
  c.check("E(f) the lost-reply replay returns the same stamp and never rewrites the gate", f.res.state === "registered" && fAgain.state === "registered"
    && gf.row.serviceAuthority.registration?.requestId === f.sr.proposal.requestId && gf2.revision === gf.revision, { gf: gf.revision, gf2: gf2.revision });
  const actOf = new Map<string, ServiceAuthorityRequest>();
  await point("(g) activate before its CAS", ordersEp, async (s) => {
    const w = await registered(s), r = witnessReq("activate", w); actOf.set(s.instanceId, r);
    await simIntent(ownerA, r); return { r, who: "a" };
  }, { at: "registered", resumed: "registered", cancelled: "revoking:deny-new-landed" });
  const h = await point("(h) activate after its CAS", ordersEp, async (s) => {
    const w = await registered(s), r = witnessReq("activate", w); await credential("a", r); return { r, who: "a" };
  }, { at: "registered", resumed: "registered", cancelled: "revoking:deny-new-landed" });
  const gh = await gate(ordersEp, h.sr.instanceId), hAgain = await viaProvider("a", h.run.r), gh2 = await gate(ordersEp, h.sr.instanceId);
  c.check("E(h) the replay re-issues material and never rewrites the gate", h.res.state === "credential" && hAgain.state === "credential" && gh2.revision === gh.revision,
    { gh: gh.revision, gh2: gh2.revision });
  await point("(i) ready before its status", ordersEp, async (s) => {
    const w = await registered(s), cr = await credential("a", witnessReq("activate", w)), r = witnessReq("ready", w);
    await simIntent(ownerA, r); return { r, who: "a", proof: { kind: "service-access", token: cr.accessBearer } };
  }, { at: "registered", resumed: "ready", cancelled: "revoking:deny-new-landed" });
  const j = await point("(j) pre-activation re-registration admitted", ordersEp, async (s) => {
    const w = await registered(s), r = registerReq(ordersEp, s.instanceId, orders, w); await simIntent(ownerA, r); return { r, who: "a" };
  }, { at: "registering:admitted", resumed: "registered", cancelled: "revoking:deny-new-landed" });
  const jOld = await viaProvider("a", opStatus(j.sr.proposal)), jOldS = st(jOld);
  c.check("E(j) the re-registration supersedes the earlier register with both real ids", jOldS?.state === "superseded"
    && jOldS.registrationRequestId === j.sr.proposal.requestId && jOldS.currentRegistrationRequestId === j.run.r.requestId, jOld);
  let kWait: ServiceAuthorityRequest | undefined, kWaitAt = "";
  const k = await point("(k) a competing freeze", ordersEp, async (s) => {
    const waiting = registerReq(ordersEp, s.instanceId, orders); await simIntent(ownerA, waiting);
    const id = await simIntent(ownerA, s.proposal); await simFreeze(s.proposal, id);
    if (kWait === undefined) { kWait = waiting; kWaitAt = await regStatus("a", waiting); }
    return { r: s.proposal, who: "a" };
  }, { at: "registering:barrier", resumed: "registered", cancelled: "revoking:deny-new-landed" });
  const kAfter = await viaProvider("a", opStatus(kWait!)), kAfterS = st(kAfter), kReplay = await viaProvider("a", kWait!);
  c.check("E(k) the waiting request reads registering admitted during the competitor's freeze", kWaitAt === "registering:admitted", kWaitAt);
  c.check("E(k) after the competitor stamps, the waiting request is superseded with both real ids and its replay is a conflict",
    kAfterS?.state === "superseded" && kAfterS.currentRegistrationRequestId === k.run.r.requestId && denied(kReplay, "conflict"), { kAfter, kReplay });

  // ---- F: X4-X10 ----
  const x4ep = "org.example.x4";
  names.set(x4ep, await bindName(x4ep, "a"));
  const x4c = cluster(x4ep, [cmd("lookup")]), r1x4 = registerReq(x4ep, rid(), x4c);
  const p1x4 = await viaProvider("a", r1x4);
  const pr = p1x4.state === "approval-required" ? await propRead(p1x4.proposalId) : undefined;
  await call(host, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "decide", granter: { kind: "owner", owner: ownerA },
    input: { proposalId: p1x4.state === "approval-required" ? p1x4.proposalId : "", expectedProposalRevision: pr?.state === "present" ? pr.record.revision : 0, expectedNameRevision: names.get(x4ep)!, decision: "refuse", callerCeiling: [] } });
  const s4 = await approved("a", x4ep, x4c);
  await revoke(s4);
  const x4a = st(await viaProvider("a", opStatus(r1x4))), x4b = st(await viaProvider("a", opStatus(s4.proposal)));
  c.check("F1 X4 a refused proposal stays refused while another, revoked proposal reads revoking", x4a?.state === "refused" && x4b?.state === "revoking", { x4a, x4b });
  const s5 = await approved("a", ordersEp, orders);
  const r5a = registerReq(ordersEp, s5.instanceId, orders), r5b = registerReq(ordersEp, s5.instanceId, orders);
  await simIntent(ownerA, r5a);
  const w5b = await registered(s5, r5b);
  const x5a = st(await viaProvider("a", opStatus(r5a)));
  const r5c = registerReq(ordersEp, s5.instanceId, orders, w5b), id5c = await simIntent(ownerA, r5c);
  await simFreeze(r5c, id5c);
  const x5b = st(await viaProvider("a", opStatus(r5a)));
  await viaProvider("a", r5c);
  const x5c = st(await viaProvider("a", opStatus(r5a)));
  c.check("F2 X5 a superseded request stays superseded through a later freeze and then names the newer stamp",
    x5a?.state === "superseded" && x5a.currentRegistrationRequestId === r5b.requestId && x5b?.state === "superseded" && x5b.currentRegistrationRequestId === r5b.requestId
    && x5c?.state === "superseded" && x5c.currentRegistrationRequestId === r5c.requestId, { x5a, x5b, x5c });
  const s6 = await approved("a", ordersEp, orders), r6b = registerReq(ordersEp, s6.instanceId, orders);
  await registered(s6, r6b);
  const x6 = st(await viaProvider("a", opStatus(s6.proposal)));
  c.check("F3 X6 a proposal-phase request after another request registered reads superseded, not approved-unregistered",
    x6?.state === "superseded" && x6.registrationRequestId === s6.proposal.requestId && x6.currentRegistrationRequestId === r6b.requestId, x6);
  const changedBody = await raw(on.url, { ...act1, witness: otherWitness }, await idpProof("a"));
  c.check("F4 X8 a changed body under an existing key is a conflict (409), not a state refusal", changedBody.status === 409 && denied(changedBody.parsed, "conflict"), changedBody.body);
  const s9 = await approved("a", ordersEp, orders), w9 = await registered(s9), r9 = witnessReq("activate", w9);
  // A KV revision is the stream sequence, so the gate's writes are counted by a watcher on its key.
  const gateWrites: number[] = [], watcher = await authKv.watch({ key: epgateKey(ordersEp, s9.instanceId), include: KvWatchInclude.UpdatesOnly });
  const watching = (async () => { for await (const e of watcher) gateWrites.push(e.revision); })();
  const [c9a, c9b] = await Promise.all([viaProvider("a", r9), viaProvider("a", r9)]);
  await new Promise((r) => setTimeout(r, 500));
  watcher.stop(); await watching;
  const g9b = await gate(ordersEp, s9.instanceId), idx9 = await indexOf(ordersEp, s9.instanceId);
  c.check("F5 X9 two identical concurrent activates: one intent, one activation CAS, both answered", c9a.state === "credential" && c9b.state === "credential"
    && idx9?.row.intents.filter((x) => x.operation === "activate").length === 1 && gateWrites.length === 1 && g9b.row.serviceAuthority.activationIssued,
    { c9a: c9a.state, c9b: c9b.state, gateWrites });
  const s10 = await approved("a", ordersEp, orders), w10 = await registered(s10), r10 = witnessReq("activate", w10);
  await simIntent(ownerA, r10);
  await registered(s10, registerReq(ordersEp, s10.instanceId, orders, w10));
  const idx10 = await indexOf(ordersEp, s10.instanceId), x10 = await viaProvider("a", r10), idx10b = await indexOf(ordersEp, s10.instanceId);
  c.check("F6 X10 an activate replay after its witness went stale is refused at the effect with no new record",
    denied(x10, "stale-witness") && idx10b?.revision === idx10?.revision, x10);
  const gAct = actOf.get([...actOf.keys()][1]!);
  if (gAct) {
    const gone = await raw(on.url, gAct, await idpProof("a"));
    c.check("F7 a cancelled assignment's activate is refused (409) with no material", gone.status === 409 && denied(gone.parsed, "approval-revoked"), gone.body);
  }
  const live9 = c9a.state === "credential" ? await dial(c9a.accessBearer) : undefined;
  await revoke(s9);
  let dialed = "connected";
  try { await dial(c9a.state === "credential" ? c9a.accessBearer : ""); } catch (e) { dialed = (e as Error).message; }
  c.check("F8 the same live bearer connects before its assignment is revoked and is refused by the callout after", live9 !== undefined && /authorization violation/i.test(dialed), dialed);
} finally {
  for (const nc of conns) await nc.close().catch(() => {});
  await harness?.close().catch(() => {});
  if (prevHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = prevHome;
  for (const hh of handles) await hh.close().catch(() => {});
  await fx.close();
  idp.closeAllConnections();
  await new Promise<void>((r) => idp.close(() => r()));
}

console.log(c.failed === 0 ? `\nSERVICE SERVING SMOKE OK (${c.passed} passed)` : `\nSERVICE SERVING SMOKE FAILED (${c.passed} passed, ${c.failed} failed)`);
c.finish();
if (c.failed > 0) process.exit(1);
