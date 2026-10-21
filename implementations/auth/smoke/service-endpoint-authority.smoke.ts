/** Owned-broker suite for the public service endpoint authority door. One hosted context
 * (`startAuthService` with `serviceEndpoints`) on a JWT-permission broker serves the route on its
 * loopback and public faces. The provider client and the HTTP client reach it over real HTTP; the
 * host handle names the endpoint and approves, refuses and revokes. The signed IdP is a loopback
 * fixture serving /token and JWKS, and the owners' interactive actor rows are fixture rows. Section K
 * moves one engine-written proposal past its expiry ("sim expiry": a controlled fixture timestamp,
 * not 24 h elapsed). Nothing here is native, Cloud or production acceptance, and nothing proves a
 * human decision. */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createAccount } from "@nats-io/nkeys";
import { Kvm } from "@nats-io/kv";
import {
  SERVICE_AUTHORITY_MAX_BYTES, VOID_SCHEMA_DIGEST, epAuthBucket, mintCreds, newIdentity, parseServiceAuthorityResult, setupSpaceStreams,
  singleDocumentClosure, type SecretStore, type ServiceAuthorityRequest, type ServiceAuthorityResult,
} from "@cotal-ai/core";
import { openAuthorityClient } from "../src/authority-client.js";
import { cotalAuthProvider } from "../src/provider.js";
import { deriveOwnerForIdpSubject } from "../src/derive.js";
import { grantActor } from "../src/ledger.js";
import { fetchIdpJwt, saveIdpSession } from "../src/login.js";
import { authClientSentinelKey, ensurePinnedIdp, loadOwnerSecret, saveAuthServiceInfo } from "../src/store.js";
import type { ServiceEndpointHost, ServiceHostRequest, ServiceHostResult } from "../src/service-host-contract.js";
import { postRemoteServiceAuthority, readRemoteServiceAuthorityInfo } from "../src/service-authority-client.js";
import { serviceAuthorityEngineRequestId } from "../src/service-endpoint-authority.js";
import { serviceHostOperationId } from "../src/service-host-ops.js";
import { startAuthService, type AuthServiceHandle } from "../src/service.js";
import { checks } from "./_service-custody-fixture.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const c = checks();
const rid = () => randomBytes(16).toString("hex");
const call = (host: ServiceEndpointHost, req: object): Promise<ServiceHostResult> => host(req as ServiceHostRequest);
const operator = { kind: "operator", auditId: "fixture-operator" } as const;
const endpoint = "org.example.orders", reserved = "auth";

// ---- the signed IdP fixture -----------------------------------------------------------------------
const key = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(key.publicKey), kid: "svauth-idp" };
const sessions = new Map<string, string>();
let origin = "";
const mint = (sub: string, aud = origin) => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setIssuer(origin).setAudience(aud).setSubject(sub).setIssuedAt(now).setExpirationTime(now + 120).sign(key.privateKey);
};
const idp = createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/auth/jwks") return void res.end(JSON.stringify({ keys: [jwk] }));
  const sub = req.url === "/api/auth/token" ? sessions.get((req.headers.authorization ?? "").replace(/^Bearer /, "")) : undefined;
  if (sub === undefined) { res.writeHead(401); return void res.end("{}"); }
  res.end(JSON.stringify({ token: await mint(sub) }));
});
await new Promise<void>((r) => idp.listen(0, "127.0.0.1", () => r()));
const idpPort = (idp.address() as { port: number }).port;
origin = `http://127.0.0.1:${idpPort}`;
const idpUrl = `${origin}/api/auth`;
for (const s of ["a", "b", "c"]) sessions.set(`session-${s}`, `user-${s}`);

// ---- contract fixtures --------------------------------------------------------------------------
const cmd = (name: string, cls = "ephemeral") => ({ name, class: cls, targeted: false, capability: "read", inputDigest: VOID_SCHEMA_DIGEST, outputDigest: VOID_SCHEMA_DIGEST,
  ...(cls === "journal" ? { admissionCeiling: { maxBytes: 1024, maxDepth: 4, maxItems: 16 } } : {}) });
const cluster = (urn: string, commands: object[]) => {
  const document = { urn, revision: 1, attributes: [], events: [], commands };
  return { document, ...singleDocumentClosure(document) };
};
const orders = cluster("org.example.orders", [cmd("lookup")]), extra = cluster("org.example.extra", [cmd("count")]);
const registration = (...cs: Array<ReturnType<typeof cluster>>) => ({ clusterDigests: cs.map((x) => x.closureDigest), contractArtifacts: cs.flatMap((x) => [x.manifest, x.document]) });

const fx = await startHostedAuthFixture("svauth", 1);
const [a] = fx.accounts;
const space = a.space, accountPublicKey = a.accountPublicKey;
const handles: AuthServiceHandle[] = [];
const prevHome = process.env.COTAL_HOME;
let harness: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
try {
  await setupSpaceStreams({ servers: fx.servers, space, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  const stateDir = join(fx.dir, "svauth-state"), clientDir = join(fx.dir, "svauth-client"), home = join(fx.dir, "svauth-home");
  for (const d of [stateDir, clientDir, home]) mkdirSync(d, { recursive: true });
  ensurePinnedIdp(stateDir, idpUrl); ensurePinnedIdp(clientDir, idpUrl);
  const ownerSecret = (await loadOwnerSecret(a.store, space))!;
  const ownerOf = (sub: string) => deriveOwnerForIdpSubject(ownerSecret, origin, sub);
  const [ownerA, ownerB, ownerC] = ["user-a", "user-b", "user-c"].map(ownerOf);
  // Fixture rows: A signs in from the CLI, B from the web; C has no interactive row.
  grantActor(stateDir, { owner: ownerA, actor: "cli", scope: [], allowSubscribe: [], allowPublish: [] });
  grantActor(stateDir, { owner: ownerB, actor: "web", scope: [], allowSubscribe: [], allowPublish: [] });
  process.env.COTAL_HOME = home;
  const signIn = (s: "a" | "b" | "c") => saveIdpSession(home, idpUrl, { token: `session-${s}`, expiresAt: Math.floor(Date.now() / 1000) + 600, sub: `user-${s}` });
  const inputs = { context: { accountPublicKey, lifecycleUid: "life-0" }, space, servers: fx.servers, store: a.store, storeIdentity: a.store.identity,
    stateDir, publicFace: { port: 0, trustedProxy: false } };
  const raw = async (base: string, body: unknown, init: { method?: string; headers?: Record<string, string> } = {}) => {
    const r = await fetch(`${base}/service-endpoint-authority`, { method: init.method ?? "POST", headers: { "content-type": "application/json", ...init.headers },
      ...(init.method === "GET" ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    const text = await r.text();
    let json: unknown; try { json = JSON.parse(text); } catch { json = text; }
    return { status: r.status, body: json as Record<string, unknown>, cacheControl: r.headers.get("cache-control") };
  };

  // ---- A: default off ----
  const off = await startAuthService(inputs);
  handles.push(off);
  const offGet = await raw(off.url, null, { method: "GET" }), offPost = await raw(off.publicUrl!, {});
  c.check("A1 without serviceEndpoints the route answers 404 on both faces", offGet.status === 404 && offPost.status === 404, { offGet, offPost });
  await off.close();

  const on = await startAuthService({ ...inputs, serviceEndpoints: { startup: { kind: "normal" } } });
  handles.push(on);
  const host = on.serviceEndpointHost!, pub = on.publicUrl!;
  saveAuthServiceInfo(clientDir, { url: on.url, pid: process.pid, cap: on.cap });
  const clientStore: SecretStore = {
    get: async (k) => (k === authClientSentinelKey(space) ? a.sentinelCreds : undefined),
    put: async () => { throw new Error("client must not write the store"); }, create: async () => false, delete: async () => {},
  };
  const request = (operation: string, fields: object, instanceId: string, requestId = rid()) =>
    ({ v: 1, kind: "service-endpoint-authority", operation, requestId, space, accountPublicKey, endpoint, instanceId, ...fields }) as ServiceAuthorityRequest;
  const register = (instanceId: string, reg = registration(orders), requestId = rid()) =>
    request("register", { registration: reg, expected: { state: "unregistered" } }, instanceId, requestId);
  const status = (instanceId: string, requestId: string) => request("status", { target: { kind: "operation", requestId } }, instanceId);
  const viaProvider = async (who: "a" | "b" | "c", r: ServiceAuthorityRequest): Promise<ServiceAuthorityResult> => {
    signIn(who);
    return (await cotalAuthProvider.serviceEndpointAuthority!({ store: clientStore, dir: clientDir, request: r })).result;
  };
  const opRead = async (operationId: string) => call(host, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "operation-read", input: { operationId }, granter: operator });
  const propRead = async (proposalId: string) => call(host, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "proposal-read", input: { proposalId }, granter: operator });
  const engineOp = (owner: string, r: ServiceAuthorityRequest) => serviceHostOperationId(space, serviceAuthorityEngineRequestId({ space, accountPublicKey }, owner, r, "register", r.requestId));
  const idpProof = async (s: "a" | "b" | "c") => ({ kind: "idp" as const, token: await fetchIdpJwt(idpUrl, `session-${s}`) });
  const denied = (r: ServiceAuthorityResult, reason: string) => r.state === "denied" && r.reason === reason;

  // ---- B: info ----
  const info = await cotalAuthProvider.serviceEndpointInfo!({ store: clientStore, dir: clientDir, space });
  c.check("B1 the provider reads the receiver's own account and space over the loopback face", info.space === space && info.accountPublicKey === accountPublicKey, info);
  const pubInfo = await readRemoteServiceAuthorityInfo(pub, space), pubGet = await raw(pub, null, { method: "GET" });
  c.check("B2 the public face serves the same info, not stored", pubInfo.accountPublicKey === accountPublicKey && pubGet.cacheControl === "no-store", pubGet);

  // ---- C: register through the provider ----
  const i1 = rid(), i2 = rid(), i3 = rid(), i4 = rid();
  const r1 = register(i1);
  const first = await viaProvider("a", r1);
  c.check("C1 a first register answers approval-required with its proposal", first.state === "approval-required" && /^[0-9a-f]{64}$/.test(first.proposalId), first);
  const proposalId = first.state === "approval-required" ? first.proposalId : "";
  const p1 = await propRead(proposalId);
  const pv = p1.state === "present" ? p1.record.value as { owner: string; clusterDigests: string[]; commands: Array<{ name: string; clusterDigest: string }>; proposalDigest: string } : undefined;
  c.check("C1 the proposal holds the derived owner and only the verified closure's commands", pv?.owner === ownerA && pv.clusterDigests.join() === orders.closureDigest
    && pv.commands.map((x) => `${x.name}@${x.clusterDigest}`).join() === `lookup@${orders.closureDigest}` && first.state === "approval-required" && pv.proposalDigest === first.proposalDigest, p1);
  const narrow = await opRead(serviceHostOperationId(space, r1.requestId)), full = await opRead(engineOp(ownerA, r1));
  c.check("C2 the engine binding is keyed by the full public tuple, not the bare requestId", narrow.state === "absent" && full.state === "present", { narrow, full });
  const again = await viaProvider("a", r1), p1b = await propRead(proposalId);
  c.check("C3 a replay with a fresh proof answers the same proposal and writes nothing new",
    again.state === "approval-required" && again.proposalId === proposalId && p1b.state === "present" && p1.state === "present" && p1b.record.revision === p1.record.revision, { again, p1b });
  const changed = await raw(on.url, { request: { ...r1, registration: registration(orders, extra) }, proof: await idpProof("a") });
  c.check("C4 a changed body under the same request id is a conflict (409)", changed.status === 409 && changed.body.reason === "conflict", changed);
  const rB = register(i2, registration(orders), r1.requestId);
  const other = await viaProvider("b", rB);
  c.check("C5 another owner's equal request id binds its own proposal", other.state === "approval-required" && other.proposalId !== proposalId, other);
  const otherProposal = other.state === "approval-required" ? other.proposalId : "";
  const sameSelector = await viaProvider("b", register(i1, registration(orders), r1.requestId));
  c.check("C6 another owner on a live selector is refused selector-pending, not given that proposal", denied(sameSelector, "selector-pending"), sameSelector);
  const rC = register(i3);
  const noRow = await viaProvider("c", rC), cOp = await opRead(engineOp(ownerC, rC));
  c.check("C7 an owner without a current interactive row is refused and binds nothing", denied(noRow, "permission-denied") && cOp.state === "absent", { noRow, cOp });
  for (const control of ["auth", "delivery", "manager"]) {
    const rN = { ...register(rid()), endpoint: control } as ServiceAuthorityRequest;
    const first = await raw(on.url, { request: rN, proof: await idpProof("a") }), again = await viaProvider("a", rN), nOp = await opRead(engineOp(ownerA, rN));
    c.check(`C8 a register naming the native control endpoint ${control} is a definite 403 permission-denied and binds nothing`, first.status === 403
      && first.body.state === "denied" && first.body.reason === "permission-denied" && denied(again, "permission-denied") && nOp.state === "absent", { first, again, nOp });
  }

  // ---- D: owner operation status ----
  const s1 = await viaProvider("a", status(i1, r1.requestId));
  c.check("D1 the owner's operation status is proposed with its proposal", s1.state === "status" && s1.status.state === "proposed" && s1.status.proposalId === proposalId
    && first.state === "approval-required" && s1.status.proposalDigest === first.proposalDigest, s1);
  const s2 = await viaProvider("b", status(i1, r1.requestId));
  c.check("D2 another owner cannot read that operation", denied(s2, "not-found"), s2);
  const s3 = await viaProvider("a", request("status", { target: { kind: "instance" } }, i1));
  c.check("D3 instance status is unsupported in this cut", denied(s3, "unsupported"), s3);
  const s4 = await raw(on.url, { request: status(i1, r1.requestId), proof: { kind: "service-access", token: "fixture-access" } });
  c.check("D4 a service proof is not accepted before any service credential exists", s4.status === 403 && s4.body.reason === "proof-unsupported", s4);

  // ---- E: proof and envelope refusals ----
  const st = status(i1, r1.requestId);
  const garbage = await raw(on.url, { request: st, proof: { kind: "idp", token: "not-a-jwt" } });
  const wrongAud = await raw(on.url, { request: st, proof: { kind: "idp", token: await mint("user-a", "https://elsewhere.example") } });
  c.check("E1 a bad or wrong-audience proof is unauthenticated (401) and parses as denied", garbage.status === 401 && wrongAud.status === 401
    && parseServiceAuthorityResult(garbage.body, st).state === "denied" && wrongAud.body.reason === "unauthenticated", { garbage, wrongAud });
  const acct = await raw(on.url, { request: { ...st, accountPublicKey: createAccount().getPublicKey() }, proof: { kind: "idp", token: "not-a-jwt" } });
  const sp = await raw(on.url, { request: { ...st, space: "another-space" }, proof: await idpProof("a") });
  c.check("E2 another account is refused (403) before the proof is verified", acct.status === 403 && acct.body.reason === "account-mismatch", acct);
  c.check("E2 a request for another space is refused (403)", sp.status === 403 && sp.body.reason === "account-mismatch", sp);
  const browser = await raw(on.url, { request: st, proof: await idpProof("a") }, { headers: { origin: "https://evil.example" } });
  const media = await raw(on.url, "{}", { headers: { "content-type": "text/plain" } });
  const huge = await raw(on.url, `"${"x".repeat(SERVICE_AUTHORITY_MAX_BYTES)}"`);
  const shape = await raw(on.url, { request: { ...st, extra: 1 }, proof: await idpProof("a") });
  c.check("E3 browser origin 403, media 415, an envelope over 2 MiB 413, an unknown field 400",
    browser.status === 403 && media.status === 415 && huge.status === 413 && shape.status === 400, { browser: browser.status, media: media.status, huge: huge.status, shape: shape.status });

  // ---- F: closure compilation ----
  const missing = { clusterDigests: [orders.closureDigest], contractArtifacts: [orders.manifest] };
  const extraneous = { clusterDigests: [orders.closureDigest], contractArtifacts: [orders.manifest, orders.document, extra.document] };
  const tampered = { clusterDigests: [orders.closureDigest], contractArtifacts: [orders.manifest, { ...orders.document, revision: 2 }] };
  const journal = cluster("org.example.jobs", [cmd("enqueue", "journal")]);
  const results = [];
  for (const reg of [missing, extraneous, tampered]) results.push(await viaProvider("a", register(i4, reg)));
  const journalled = await viaProvider("a", register(i4, registration(journal)));
  c.check("F1 a missing, extraneous or tampered artifact refuses as closure-invalid", results.every((r) => denied(r, "closure-invalid")), results);
  c.check("F2 a journal-class command refuses as unsupported-runtime", denied(journalled, "unsupported-runtime"), journalled);
  c.check("F3 no refused closure reached the capacity index: the selector is still free", (await viaProvider("a", register(i4))).state === "approval-required");

  // ---- G: create-only name binding through the host ----
  const bindReq = { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "name-bind", granter: operator,
    input: { endpoint, owner: ownerA, expectedRevision: 0, claimReference: "fixture-verified-namespace" } };
  const g1 = await call(host, bindReq), g2 = await call(host, bindReq);
  const nameRevision = g1.state === "bound" ? g1.binding.revision : -1;
  c.check("G1 an operator binds the name to its owner", g1.state === "bound" && g1.binding.owner === ownerA && nameRevision > 0, g1);
  c.check("G2 the identical request recovers the same binding at the same revision", g2.state === "bound" && g2.binding.revision === nameRevision, g2);
  const g3 = await call(host, { ...bindReq, input: { ...bindReq.input, claimReference: "another-claim" } });
  const g4 = await call(host, { ...bindReq, requestId: rid(), input: { ...bindReq.input, owner: ownerB } });
  c.check("G3 the same request id with a changed claim is a conflict", g3.state === "denied" && g3.reason === "conflict", g3);
  c.check("G4 another request for a bound name is refused name-bound", g4.state === "denied" && g4.reason === "name-bound", g4);
  const g5 = await call(host, { ...bindReq, requestId: rid(), input: { ...bindReq.input, expectedRevision: nameRevision } });
  const g6 = await call(host, { ...bindReq, requestId: rid(), input: { ...bindReq.input, endpoint: reserved } });
  let g7 = ""; try { await call(host, { ...bindReq, requestId: rid(), granter: { kind: "owner", owner: ownerA } }); } catch (e) { g7 = (e as Error).message; }
  c.check("G5 update, a native control name and an owner granter are refused", g5.state === "denied" && g5.reason === "unsupported"
    && g6.state === "denied" && g6.reason === "permission-denied" && /operator decision/.test(g7), { g5, g6, g7 });

  // ---- H: approval and status ----
  const nameOwned = await viaProvider("b", register(rid()));
  c.check("H1 another owner cannot register under a bound name", denied(nameOwned, "name-owned"), nameOwned);
  const p1c = await propRead(proposalId);
  const decide = (owner: string, pid: string, revision: number, decision: "approve" | "refuse") => call(host, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "decide",
    granter: { kind: "owner", owner }, input: { proposalId: pid, expectedProposalRevision: revision, expectedNameRevision: nameRevision, decision, callerCeiling: [] } });
  const pOther = await propRead(otherProposal);
  const bApprove = await decide(ownerB, otherProposal, pOther.state === "present" ? pOther.record.revision : 0, "approve");
  c.check("H2 an owner's proposal under another owner's name cannot be approved", bApprove.state === "denied" && bApprove.reason === "name-claim-required", bApprove);
  const approved = await decide(ownerA, proposalId, p1c.state === "present" ? p1c.record.revision : 0, "approve");
  const approval = approved.state === "approved" ? approved.approval : undefined;
  c.check("H3 the owner approves through the host", approval !== undefined && approval.proposalId === proposalId, approved);
  const s5 = await viaProvider("a", status(i1, r1.requestId));
  c.check("H4 status reports approved-unregistered with the approval's digest", s5.state === "status" && s5.status.state === "approved-unregistered"
    && s5.status.approvalDigest === approval?.approvalDigest, s5);
  const replayed = await viaProvider("a", r1);
  c.check("H5 a register replay after approval is pending, never registered or a credential", replayed.state === "pending" && replayed.phase === "approved-unregistered", replayed);
  const r4 = register(rid());
  const second = await viaProvider("a", r4);
  const p4 = second.state === "approval-required" ? await propRead(second.proposalId) : undefined;
  const refused = second.state === "approval-required" && p4?.state === "present" ? await decide(ownerA, second.proposalId, p4.record.revision, "refuse") : undefined;
  const s6 = await viaProvider("a", status(r4.instanceId, r4.requestId)), again4 = await viaProvider("a", r4);
  c.check("H6 a refused proposal reads refused and its register replay is denied", refused?.state === "refused" && s6.state === "status" && s6.status.state === "refused"
    && denied(again4, "proposal-refused"), { refused, s6, again4 });

  // ---- I: revocation ----
  const revoked = await call(host, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "revoke", granter: { kind: "owner", owner: ownerA },
    input: { endpoint, instanceId: i1, expectedAssignmentDigest: approval?.assignment.assignmentDigest ?? "", cause: "owner-request" } });
  c.check("I1 the host revoke lands deny-new and stays nonterminal", revoked.state === "pending" && revoked.denyNew === "landed", revoked);
  const s7 = await viaProvider("a", status(i1, r1.requestId)), after = await viaProvider("a", r1);
  c.check("I2 status reports revoking once deny-new landed", s7.state === "status" && s7.status.state === "revoking" && s7.status.phase === "deny-new-landed", s7);
  c.check("I3 a register replay after revocation is denied approval-revoked", denied(after, "approval-revoked"), after);

  // ---- J: the public face end to end, and its refusal budget ----
  const r5 = register(rid());
  const viaPublic = await postRemoteServiceAuthority(pub, { request: r5, proof: await idpProof("a") });
  const s8 = await postRemoteServiceAuthority(pub, { request: status(r5.instanceId, r5.requestId), proof: await idpProof("a") });
  c.check("J1 the public face admits a register and answers its status", viaPublic.state === "approval-required" && s8.state === "status" && s8.status.state === "proposed", { viaPublic, s8 });
  let lastBad = 0;
  for (let i = 0; i < 31; i++) lastBad = (await raw(pub, { request: st, proof: { kind: "idp", token: "not-a-jwt" } })).status;
  const stillValid = await postRemoteServiceAuthority(pub, { request: status(r5.instanceId, r5.requestId), proof: await idpProof("a") });
  c.check("J2 refused proofs exhaust the peer's budget (429) while a valid proof still answers", lastBad === 429 && stillValid.state === "status", { lastBad, stillValid });
  const loop = await raw(on.url, { request: st, proof: { kind: "idp", token: "not-a-jwt" } });
  c.check("J2 the public budget never consumes the loopback face's", loop.status === 401, loop);

  // ---- K: an undecided proposal past its expiry (sim expiry) ----
  const rExp = register(rid()), rLive = register(rid());
  const kExp = await viaProvider("a", rExp), kLive = await viaProvider("a", rLive);
  const expId = kExp.state === "approval-required" ? kExp.proposalId : "";
  harness = await openAuthorityClient({ server: fx.servers, space, dataAccount: { pub: a.auth.account.pub, signingSeed: a.auth.account.signingSeed! },
    label: `harness:${space}`, grants: (id) => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
  const kv = await new Kvm(harness.nc).open(epAuthBucket(space));
  const enc = new TextEncoder(), dec = new TextDecoder(), expire = Date.now() - 1;          // simulation: the canonical expiry has passed
  const pe = (await kv.get(`svcprop.${expId}`))!;
  await kv.update(`svcprop.${expId}`, enc.encode(JSON.stringify({ ...JSON.parse(dec.decode(pe.value)), expiresAtMs: expire })), pe.revision);
  const ce = (await kv.get("svccap.space"))!, cap = JSON.parse(dec.decode(ce.value)) as { pending: Array<{ proposalId: string }> };
  await kv.update("svccap.space", enc.encode(JSON.stringify({ ...cap, pending: cap.pending.map((x) => (x.proposalId === expId ? { ...x, expiresAtMs: expire } : x)) })), ce.revision);
  await new Promise((r) => setTimeout(r, 1000));                                             // past the whole expiry second the view carries
  const kRead = await propRead(expId);
  c.check("K1 (sim expiry) the host still reads the expired proposal as live proposed", kRead.state === "present" && (kRead.record.value as { state: string }).state === "proposed", kRead);
  const k2 = await viaProvider("a", status(rExp.instanceId, rExp.requestId)), k3 = await viaProvider("a", rExp);
  c.check("K2 its status reads refused with reason expired", k2.state === "status" && k2.status.state === "refused" && k2.status.reason === "expired" && k2.status.proposalId === expId, k2);
  c.check("K3 its register replay is denied proposal-expired, not approval-required", denied(k3, "proposal-expired"), k3);
  const kDecide = await decide(ownerA, expId, kRead.state === "present" ? kRead.record.revision : 0, "approve");
  c.check("K4 the host refuses its approval as expired, agreeing with the door", kDecide.state === "denied" && kDecide.reason === "expired", kDecide);
  const k5 = await viaProvider("a", status(rLive.instanceId, rLive.requestId)), k6 = await viaProvider("a", rLive);
  c.check("K5 the unexpired control still reads proposed and replays approval-required", k5.state === "status" && k5.status.state === "proposed"
    && k6.state === "approval-required" && kLive.state === "approval-required" && k6.proposalId === kLive.proposalId, { k5, k6 });
  const k7 = await viaProvider("a", status(i1, r1.requestId));
  c.check("K6 the approved and revoked history keeps its answer", k7.state === "status" && k7.status.state === "revoking", k7);
} finally {
  await harness?.close().catch(() => {});
  if (prevHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = prevHome;
  for (const h of handles) await h.close().catch(() => {});
  await fx.close();
  idp.closeAllConnections();
  await new Promise<void>((r) => idp.close(() => r()));
}

console.log(c.failed === 0 ? `\nSERVICE ENDPOINT AUTHORITY SMOKE OK (${c.passed} passed)` : `\nSERVICE ENDPOINT AUTHORITY SMOKE FAILED (${c.passed} passed, ${c.failed} failed)`);
c.finish();
if (c.failed > 0) process.exit(1);
