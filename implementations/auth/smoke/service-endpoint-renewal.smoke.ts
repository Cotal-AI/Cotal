/** Owned-broker suite for the stock service endpoint renewal source
 * (`AuthProvider.serviceEndpointRenewal`). One hosted context (`startAuthService` with
 * `serviceEndpoints`) on a JWT-permission broker; the provider client reaches its door, and the
 * host handle binds names, approves and revokes as the fixture operator and owner. The signed IdP
 * is a loopback fixture. Nothing here is Cloud or production acceptance.
 *
 * Cells (each asserts counts):
 *  L1 the first pull activates: 1 activate intent; the record holds both request ids, created
 *     before the request is sent (observed), and the material; a fresh bearer that connects
 *     through the native callout;
 *  L2 the next pull renews under the persisted renew id: still 1 renew intent after 5 pulls, and
 *     each pull's bearer is unexpired;
 *  L3 a new source over the same store (a restart) reuses both ids: no index growth;
 *  L4 concurrent pulls share one dispatch;
 *  L5 an outage (the door is unreachable) is `unavailable`, retried with the same renew id, and
 *     recovers to `current` once the door is back;
 *  L6 a revoked assignment ends the source: `ended approval-revoked`, and a later pull refuses with
 *     no dispatch;
 *  L7 an expired renewal proof (approval and root live) reactivates under the same persisted
 *     activate id with the signed-in login: current, 1 POST, no new intent, and the bearer connects;
 *  L8 close() settles a pull in flight as closed without waiting for its answer, rejects new pulls
 *     with no request, and a second close is a no-op;
 *  L9 no token appears in state(), in thrown errors, or in the persisted record's non-material fields;
 *  L10 a revoke whose cause is `restore-quarantine` (how quarantine reaches an active instance; the
 *      admission gate itself guards only new requests) ends the source as approval-revoked;
 *  L11 a real `CotalEndpoint` starts with the source as its bearer function. It does not outlive a
 *      bearer here; the endpoint's own refresh schedule is covered by its own suites;
 *  L12 that reactivation with no sign-in is `unavailable` (not ended), sends nothing, says so in
 *      fixed text, and recovers once signed in again;
 *  L13 a store read or write failure and a corrupt record are fixed text and `unavailable`, and
 *      the source recovers under the same ids once they are restored.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { Kvm, type KV } from "@nats-io/kv";
import { connect, credsAuthenticator, tokenAuthenticator } from "@nats-io/transport-node";
import {
  CotalEndpoint, VOID_SCHEMA_DIGEST, endpointToken, epAuthBucket, mintCreds, newIdentity, serviceWitnessDigest, setupSpaceStreams, singleDocumentClosure,
  type ServiceAuthorityRequest, type ServiceRegistrationWitness,
} from "@cotal-ai/core";
import { cotalAuthProvider } from "../src/provider.js";
import { deriveOwnerForIdpSubject } from "../src/derive.js";
import { grantActor } from "../src/ledger.js";
import { deleteIdpSession, saveIdpSession } from "../src/login.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { ensurePinnedIdp, loadOwnerSecret, saveAuthServiceInfo } from "../src/store.js";
import type { ServiceEndpointHost, ServiceHostRequest, ServiceHostResult } from "../src/service-host-contract.js";
import { parseServiceRequestIntentIndexRecord } from "../src/service-host-ops.js";
import { startAuthService, type AuthServiceHandle } from "../src/service.js";
import { checks } from "./_service-custody-fixture.js";
import { MemoryStore, startHostedAuthFixture } from "./_hosted-auth-fixture.js";

const c = checks();
const rid = () => randomBytes(16).toString("hex");
const nowS = () => Math.floor(Date.now() / 1000);
const enc = new TextEncoder(), dec = new TextDecoder();
const call = (host: ServiceEndpointHost, req: object): Promise<ServiceHostResult> => host(req as ServiceHostRequest);
const operator = { kind: "operator", auditId: "renewal-fixture-operator" } as const;
const jwtLike = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./;

// ---- signed IdP fixture ----
const key = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(key.publicKey), kid: "renewal-idp" };
let origin = "";
const idp = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/auth/jwks") return void res.end(JSON.stringify({ keys: [jwk] }));
  if (req.url === "/api/auth/token" && req.headers.authorization === "Bearer session-a") {
    const now = nowS();
    return void res.end(JSON.stringify({ token: await new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: jwk.kid }).setIssuer(origin).setAudience(origin)
      .setSubject("user-a").setIssuedAt(now).setExpirationTime(now + 120).sign(key.privateKey) }));
  }
  res.writeHead(401); res.end("{}");
});
await new Promise<void>((r) => idp.listen(0, "127.0.0.1", () => r()));
origin = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
const idpUrl = `${origin}/api/auth`;

// ---- a switchable relay in front of the door, so an outage is a real unreachable door ----
let doorDown = false, doorPosts = 0, doorDelayMs = 0;
let doorTarget = "";
const relay = createServer(async (req, res) => {
  if (doorDown) { req.socket.destroy(); return; }
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(ch as Buffer);
  if (req.method === "POST") doorPosts++;
  if (doorDelayMs > 0) await new Promise((r) => setTimeout(r, doorDelayMs));
  let up: Response;
  try {
    up = await fetch(`${doorTarget}${req.url}`, { method: req.method, headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: "manual" });
  } catch { req.socket.destroy(); return; }
  const headers: Record<string, string> = {};
  up.headers.forEach((v, k) => { if (k !== "content-length" && k !== "transfer-encoding") headers[k] = v; });
  res.writeHead(up.status, headers); res.end(Buffer.from(await up.arrayBuffer()));
});
await new Promise<void>((r) => relay.listen(0, "127.0.0.1", () => r()));
const relayUrl = `http://127.0.0.1:${(relay.address() as { port: number }).port}`;

const cmd = { name: "status", class: "ephemeral", targeted: false, capability: "read", inputDigest: VOID_SCHEMA_DIGEST, outputDigest: VOID_SCHEMA_DIGEST };
const cluster = (urn: string) => { const document = { urn, revision: 1, attributes: [], events: [], commands: [cmd] }; return { document, ...singleDocumentClosure(document) }; };

const fx = await startHostedAuthFixture("svrenew", 1);
const [a] = fx.accounts;
const space = a.space, accountPublicKey = a.accountPublicKey;
const handles: AuthServiceHandle[] = [];
const prevHome = process.env.COTAL_HOME;
const closers: Array<() => Promise<unknown>> = [];
try {
  await setupSpaceStreams({ servers: fx.servers, space, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  const stateDir = join(fx.dir, "svrenew-state"), clientDir = join(fx.dir, "svrenew-client"), home = join(fx.dir, "svrenew-home");
  for (const d of [stateDir, clientDir, home]) mkdirSync(d, { recursive: true });
  ensurePinnedIdp(stateDir, idpUrl); ensurePinnedIdp(clientDir, idpUrl);
  const owner = deriveOwnerForIdpSubject((await loadOwnerSecret(a.store, space))!, origin, "user-a");
  grantActor(stateDir, { owner, actor: "cli", scope: [], allowSubscribe: [], allowPublish: [] });
  process.env.COTAL_HOME = home;
  saveIdpSession(home, idpUrl, { token: "session-a", expiresAt: nowS() + 3600, sub: "user-a" });
  const on = await startAuthService({ context: { accountPublicKey, lifecycleUid: "life-0" }, space, servers: fx.servers, store: a.store, storeIdentity: a.store.identity,
    stateDir, publicFace: { port: 0, trustedProxy: false }, serviceEndpoints: { startup: { kind: "normal" } } });
  handles.push(on);
  doorTarget = on.url;
  const host = on.serviceEndpointHost!;
  // The client reaches the door only through the relay.
  saveAuthServiceInfo(clientDir, { url: relayUrl, pid: process.pid, cap: on.cap });
  // The client store: the space's sentinel (as the stock client reads it) plus room for the renewal record.
  const clientStore = new MemoryStore({ kind: "injected", coordinate: "memory:renewal-client" });
  const { authClientSentinelKey } = await import("../src/store.js");
  await clientStore.put(authClientSentinelKey(space), a.sentinelCreds);
  const harness = await openAuthorityClient({ server: fx.servers, space, dataAccount: { pub: a.auth.account.pub, signingSeed: a.auth.account.signingSeed! },
    label: `harness:${space}`, grants: (id) => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
  closers.push(() => harness.close());
  const authKv: KV = await new Kvm(harness.nc).open(epAuthBucket(space));
  const indexOf = async (ep: string, iid: string) => {
    const e = await authKv.get(`svcintx.${endpointToken(ep)}.${iid}`);
    return e ? parseServiceRequestIntentIndexRecord(JSON.parse(dec.decode(e.value))) : undefined;
  };
  const count = async (ep: string, iid: string, op: string) => ((await indexOf(ep, iid))?.intents ?? []).filter((x) => x.operation === op).length;
  const viaProvider = async (r: ServiceAuthorityRequest) => (await cotalAuthProvider.serviceEndpointAuthority!({ store: clientStore, dir: clientDir, request: r })).result;

  /** One registered witness: bind, propose, approve through the host, replay the register. */
  const names = new Map<string, number>();
  const registeredWitness = async (ep: string): Promise<{ witness: ServiceRegistrationWitness; instanceId: string; assignmentDigest: string }> => {
    if (!names.has(ep)) {
      const b = await call(host, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "name-bind", granter: operator,
        input: { endpoint: ep, owner, expectedRevision: 0, claimReference: "renewal-fixture-namespace" } });
      if (b.state !== "bound") throw new Error(`fixture bind: ${JSON.stringify(b)}`);
      names.set(ep, b.binding.revision);
    }
    const x = cluster(ep), instanceId = rid();
    const reg = { v: 1, kind: "service-endpoint-authority", operation: "register", requestId: rid(), space, accountPublicKey, endpoint: ep, instanceId,
      registration: { clusterDigests: [x.closureDigest], contractArtifacts: [x.manifest, x.document] }, expected: { state: "unregistered" } } as ServiceAuthorityRequest;
    const first = await viaProvider(reg);
    if (first.state !== "approval-required") throw new Error(`fixture propose: ${JSON.stringify(first)}`);
    const p = await call(host, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "proposal-read", input: { proposalId: first.proposalId }, granter: operator });
    const d = await call(host, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "decide", granter: { kind: "owner", owner },
      input: { proposalId: first.proposalId, expectedProposalRevision: p.state === "present" ? p.record.revision : 0, expectedNameRevision: names.get(ep)!, decision: "approve", callerCeiling: [] } });
    if (d.state !== "approved") throw new Error(`fixture approve: ${JSON.stringify(d)}`);
    const r = await viaProvider(reg);
    if (r.state !== "registered") throw new Error(`fixture register: ${JSON.stringify(r)}`);
    return { witness: r.witness, instanceId, assignmentDigest: d.approval.assignment.assignmentDigest };
  };
  const source = (witness: ServiceRegistrationWitness) => {
    if (!cotalAuthProvider.serviceEndpointRenewal) throw new Error("the provider has no serviceEndpointRenewal hook");
    const s = cotalAuthProvider.serviceEndpointRenewal({ store: clientStore, dir: clientDir, witness });
    closers.push(() => s.close());
    return s;
  };
  const recordOf = async (witness: ServiceRegistrationWitness): Promise<Record<string, any> | undefined> => {
    const d = serviceWitnessDigest(witness);
    const hit = [...clientStore.values.entries()].find(([k, v]) => k.includes("/service-renewal/") && (JSON.parse(v) as { witnessDigest?: string }).witnessDigest === d);
    return hit ? { key: hit[0], ...(JSON.parse(hit[1]) as Record<string, any>) } : undefined;
  };
  const expOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")).exp as number;
  const dialOk = async (bearer: string) => {
    const nonce = randomBytes(16).toString("hex");
    try {
      const nc = await connect({ servers: fx.servers, name: nonce, inboxPrefix: `_INBOX_${nonce}`, timeout: 4000, reconnect: false, maxReconnectAttempts: 0,
        authenticator: [credsAuthenticator(enc.encode(a.sentinelCreds)), tokenAuthenticator(bearer)] });
      await nc.flush(); await nc.close(); return true;
    } catch { return false; }
  };
  const tokensSeen: string[] = [];
  const cell = async (title: string, body: () => Promise<void>) => {
    console.log(title);
    try { await body(); } catch (e) { c.check(`${title} crashed`, false, e instanceof Error ? e.message : String(e)); }
  };

  const ep = "org.example.renewal";
  const one = await registeredWitness(ep);
  let s1: ReturnType<typeof source> | undefined;

  await cell("L1 the first pull activates and persists before dispatch", async () => {
    // Observe the order: the POST count at the moment the record is created.
    let postsAtCreate: number | undefined;
    const create = clientStore.create.bind(clientStore);
    clientStore.create = async (k, v) => { if (k.includes("/service-renewal/")) postsAtCreate ??= doorPosts; return create(k, v); };
    s1 = source(one.witness);
    const posts0 = doorPosts;
    const b1 = await s1.bearer(); tokensSeen.push(b1);
    clientStore.create = create;
    const rec = await recordOf(one.witness);
    c.check("L1 the record is created before the request is sent", postsAtCreate === posts0, { postsAtCreate, posts0 });
    c.check("L1 exactly 1 POST and 1 activate intent", doorPosts === posts0 + 1 && await count(ep, one.instanceId, "activate") === 1, { posts: doorPosts - posts0 });
    c.check("L1 the record holds both request ids (32 hex) and material", /^[0-9a-f]{32}$/.test(rec?.activateRequestId) && /^[0-9a-f]{32}$/.test(rec?.renewRequestId) && rec?.material !== null, rec && { ...rec, material: rec.material ? "<present>" : null });
    c.check("L1 the bearer is unexpired and at most 60 s", expOf(b1) > nowS() && expOf(b1) <= nowS() + 60, expOf(b1) - nowS());
    c.check("L1 the bearer connects through the native service callout", await dialOk(b1));
    c.check("L1 state is current with expiries only", s1.state().state === "current" && !jwtLike.test(JSON.stringify(s1.state())), s1.state());
    c.check("L1 sentinel creds are exposed for the endpoint", s1.sentinelCreds === a.sentinelCreds);
  });

  await cell("L2 later pulls renew under the one persisted renew id", async () => {
    const rec0 = await recordOf(one.witness);
    for (let i = 0; i < 5; i++) { const b = await s1!.bearer(); tokensSeen.push(b); if (expOf(b) <= nowS()) throw new Error("expired bearer returned"); }
    const rec1 = await recordOf(one.witness);
    c.check("L2 1 renew intent after 5 pulls; activate still 1", await count(ep, one.instanceId, "renew") === 1 && await count(ep, one.instanceId, "activate") === 1);
    c.check("L2 the renew id is unchanged", rec0?.renewRequestId === rec1?.renewRequestId && rec0?.activateRequestId === rec1?.activateRequestId);
  });

  await cell("L3 a restarted source reuses both ids", async () => {
    const before = (await indexOf(ep, one.instanceId))?.intents.length;
    await s1!.close();
    const s2 = source(one.witness);
    const b = await s2.bearer(); tokensSeen.push(b);
    const after = (await indexOf(ep, one.instanceId))?.intents.length;
    c.check("L3 the index does not grow across a restart", before !== undefined && before === after, { before, after });
    c.check("L3 the restarted bearer connects", await dialOk(b));
    s1 = s2;
  });

  await cell("L4 concurrent pulls share one dispatch", async () => {
    const posts0 = doorPosts;
    const all = await Promise.all([s1!.bearer(), s1!.bearer(), s1!.bearer()]);
    tokensSeen.push(...all);
    c.check("L4 3 concurrent pulls, 1 POST, one bearer", doorPosts === posts0 + 1 && new Set(all).size === 1, { posts: doorPosts - posts0 });
  });

  await cell("L5 an outage is unavailable, then recovers with the same id", async () => {
    const rec0 = await recordOf(one.witness);
    doorDown = true;
    let thrown = "";
    try {
      try { await s1!.bearer(); } catch (e) { thrown = e instanceof Error ? e.message : String(e); }
      c.check("L5 the pull fails and state is unavailable", thrown !== "" && s1!.state().state === "unavailable", { thrown, state: s1!.state() });
      c.check("L5 the error carries no token", !jwtLike.test(thrown));
    } finally { doorDown = false; }
    const b = await s1!.bearer(); tokensSeen.push(b);
    const rec1 = await recordOf(one.witness);
    c.check("L5 it recovers to current with the same renew id", s1!.state().state === "current" && rec0?.renewRequestId === rec1?.renewRequestId && await count(ep, one.instanceId, "renew") === 1);
  });

  await cell("L6 a revoked assignment ends the source", async () => {
    const two = await registeredWitness(ep);
    const s = source(two.witness);
    tokensSeen.push(await s.bearer());
    const r = await call(host, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "revoke", granter: { kind: "owner", owner },
      input: { endpoint: ep, instanceId: two.instanceId, expectedAssignmentDigest: two.assignmentDigest, cause: "owner-request" } });
    let first = "";
    for (let i = 0; i < 20 && s.state().state !== "ended"; i++) {
      try { tokensSeen.push(await s.bearer()); } catch (e) { first = e instanceof Error ? e.message : String(e); }
      if (s.state().state !== "ended") await new Promise((res) => setTimeout(res, 250));
    }
    const st = s.state();
    c.check("L6 instrument: the fixture owner revoked through the stock host", r.state !== "denied", r);
    c.check("L6 ended approval-revoked", st.state === "ended" && (st as { reason: string }).reason === "approval-revoked", { st, first });
    const posts0 = doorPosts;
    let later = "";
    try { await s.bearer(); } catch (e) { later = e instanceof Error ? e.message : String(e); }
    c.check("L6 a later pull refuses with 0 POST", later !== "" && doorPosts === posts0, { later, posts: doorPosts - posts0 });
  });

  await cell("L10 a quarantine-restore revoke ends the source the same way", async () => {
    const five = await registeredWitness(ep);
    const s = source(five.witness);
    tokensSeen.push(await s.bearer());
    // A non-owner cause takes an operator granter (stock rule, service-host-ops.ts revoke V0).
    const r = await call(host, { v: 1, kind: "service-endpoint-host", requestId: rid(), operation: "revoke", granter: operator,
      input: { endpoint: ep, instanceId: five.instanceId, expectedAssignmentDigest: five.assignmentDigest, cause: "restore-quarantine" } });
    for (let i = 0; i < 20 && s.state().state !== "ended"; i++) {
      try { tokensSeen.push(await s.bearer()); } catch { /* the state says why */ }
      if (s.state().state !== "ended") await new Promise((res) => setTimeout(res, 250));
    }
    const st = s.state();
    c.check("L10 instrument: the stock host accepted the restore-quarantine revoke", r.state !== "denied", r);
    c.check("L10 ended approval-revoked, never unavailable", st.state === "ended" && (st as { reason: string }).reason === "approval-revoked", st);
  });

  /** Age a witness's stored material past its renewal expiry, as a machine offline for over 24 h leaves it. */
  const expireStored = async (w: ServiceRegistrationWitness) => {
    const { key: k, ...rec } = (await recordOf(w))!;
    rec.material.renewalExpiresAt = nowS() - 1; rec.material.accessExpiresAt = nowS() - 1;
    clientStore.values.set(k, JSON.stringify(rec));
    return rec;
  };

  await cell("L7 an expired renewal proof reactivates under the same persisted activate id", async () => {
    const three = await registeredWitness(ep);
    const s = source(three.witness);
    tokensSeen.push(await s.bearer());
    await s.close();
    const rec0 = await expireStored(three.witness);
    const intents0 = (await indexOf(ep, three.instanceId))?.intents.length;
    const s3 = source(three.witness);
    const posts0 = doorPosts;
    let b = "", thrown = "";
    try { b = await s3.bearer(); tokensSeen.push(b); } catch (e) { thrown = e instanceof Error ? e.message : String(e); }
    const rec1 = await recordOf(three.witness);
    const intents1 = (await indexOf(ep, three.instanceId))?.intents.length;
    c.check("L7 current with fresh material after 1 POST", s3.state().state === "current" && doorPosts === posts0 + 1 && b !== "" && expOf(b) > nowS(), { st: s3.state(), thrown, posts: doorPosts - posts0 });
    c.check("L7 the same activate and renew ids; no new intent; still 1 activate", rec1?.activateRequestId === rec0.activateRequestId && rec1?.renewRequestId === rec0.renewRequestId
      && intents0 === intents1 && await count(ep, three.instanceId, "activate") === 1, { intents0, intents1 });
    c.check("L7 the reactivated bearer connects, and the next pull renews", b !== "" && await dialOk(b) && (tokensSeen.push(await s3.bearer()), s3.state().state === "current"));
  });

  await cell("L12 reactivation without a sign-in is unavailable, then recovers", async () => {
    const seven = await registeredWitness(ep);
    const s = source(seven.witness);
    tokensSeen.push(await s.bearer());
    await s.close();
    await expireStored(seven.witness);
    deleteIdpSession(home, idpUrl);
    const s2 = source(seven.witness);
    const posts0 = doorPosts;
    let thrown = "";
    try {
      try { await s2.bearer(); } catch (e) { thrown = e instanceof Error ? e.message : String(e); }
      c.check("L12 unavailable, not ended, with 0 POST", s2.state().state === "unavailable" && doorPosts === posts0 && thrown !== "", { st: s2.state(), thrown, posts: doorPosts - posts0 });
      c.check("L12 the error is fixed text naming the sign-in, with no token or session", /sign-in/.test(thrown) && !jwtLike.test(thrown) && !thrown.includes("session-a"), thrown);
    } finally { saveIdpSession(home, idpUrl, { token: "session-a", expiresAt: nowS() + 3600, sub: "user-a" }); }
    tokensSeen.push(await s2.bearer());
    c.check("L12 once signed in again, the same source recovers to current", s2.state().state === "current" && await count(ep, seven.instanceId, "activate") === 1);
  });

  await cell("L13 store and record failures are fixed text and unavailable", async () => {
    const eight = await registeredWitness(ep);
    const s = source(eight.witness);
    tokensSeen.push(await s.bearer());
    const marker = "Zq9-store-text";
    const get = clientStore.get.bind(clientStore), put = clientStore.put.bind(clientStore);
    const fail = async (patch: () => void): Promise<string> => {
      patch();
      try { await s.bearer(); return ""; } catch (e) { return e instanceof Error ? e.message : String(e); } finally { clientStore.get = get; clientStore.put = put; }
    };
    const onRecord = (k: string) => k.includes("/service-renewal/");
    const gotErr = await fail(() => { clientStore.get = async (k) => { if (onRecord(k)) throw new Error(marker); return get(k); }; });
    const stGet = s.state().state;
    const putErr = await fail(() => { clientStore.put = async (k, v) => { if (onRecord(k)) throw new Error(marker); return put(k, v); }; });
    const stPut = s.state().state;
    const { key: k, ...rec } = (await recordOf(eight.witness))!;
    clientStore.values.set(k, `not-json ${marker}`);
    let corrupt = "";
    try { await s.bearer(); } catch (e) { corrupt = e instanceof Error ? e.message : String(e); }
    const stCorrupt = s.state().state;
    clientStore.values.set(k, JSON.stringify(rec));
    const texts = [gotErr, putErr, corrupt];
    c.check("L13 3 failures, each rejected with fixed text (no store or record bytes)", texts.every((t) => t !== "" && !t.includes(marker) && !t.includes("not-json")), texts);
    c.check("L13 each failure leaves the source unavailable, not idle or current", stGet === "unavailable" && stPut === "unavailable" && stCorrupt === "unavailable", { stGet, stPut, stCorrupt });
    tokensSeen.push(await s.bearer());
    c.check("L13 with the store and record restored, the same source recovers under the same ids", s.state().state === "current" && await count(ep, eight.instanceId, "renew") === 1);
  });

  await cell("L8 close aborts a pull in flight and rejects new pulls", async () => {
    const four = await registeredWitness(ep);
    const s = source(four.witness);
    tokensSeen.push(await s.bearer());
    doorDelayMs = 3000;
    let inflight = "";
    const t0 = Date.now();
    try {
      const pending = s.bearer().then((b) => { tokensSeen.push(b); return "resolved"; }, (e: Error) => e.message);
      await new Promise((r) => setTimeout(r, 300));
      await s.close();
      inflight = await pending;
    } finally { doorDelayMs = 0; }
    const took = Date.now() - t0;
    c.check("L8 close settles the in-flight pull as closed, well before the held answer", inflight === "service renewal is closed" && took < 2500 && s.state().state === "closed", { inflight, took, state: s.state() });
    const posts0 = doorPosts;
    let thrown = "";
    try { await s.bearer(); } catch (e) { thrown = e instanceof Error ? e.message : String(e); }
    c.check("L8 a pull after close refuses with 0 POST", thrown === "service renewal is closed" && doorPosts === posts0, thrown);
    let second = "ok";
    try { await s.close(); } catch (e) { second = e instanceof Error ? e.message : String(e); }
    c.check("L8 a second close resolves and changes nothing", second === "ok" && s.state().state === "closed", second);
  });

  await cell("L11 a real CotalEndpoint starts on the source as its bearer function", async () => {
    const six = await registeredWitness(ep);
    const s = source(six.witness);
    const posts0 = doorPosts;
    // The endpoint needs the sentinel before start; the source exposes it after its first pull.
    const first = await s.bearer(); tokensSeen.push(first);
    const epx = new CotalEndpoint({
      space, servers: fx.servers, bearer: () => s.bearer(), sentinelCreds: s.sentinelCreds!,
      card: { name: "renewal-service", kind: "endpoint", owner: six.witness.principal.owner, actor: six.witness.principal.actor },
      channels: [], registerPresence: false, watchPresence: false, watchChannels: false, consume: false,
    });
    epx.on("error", () => {}); epx.on("warning", () => {});
    let started = "ok";
    try { await epx.start(); } catch (e) { started = e instanceof Error ? e.message : String(e); }
    c.check("L11 the endpoint starts with the source's bearer through the native service callout", started === "ok", started);
    c.check("L11 the endpoint's pulls went through the one renew id: at most 1 renew intent", await count(ep, six.instanceId, "renew") <= 1 && await count(ep, six.instanceId, "activate") === 1,
      { renew: await count(ep, six.instanceId, "renew"), posts: doorPosts - posts0 });
    await epx.stop();
  });

  await cell("L9 no token outside bearer()", async () => {
    const records = [...clientStore.values.entries()].filter(([k]) => k.includes("/service-renewal/")).map(([, v]) => JSON.parse(v) as Record<string, any>);
    const outside = records.map(({ material: _m, ...rest }) => JSON.stringify(rest)).join("\n");
    c.check("L9 records hold no token outside their material field", records.length >= 5 && !tokensSeen.some((t) => outside.includes(t)) && !jwtLike.test(outside), records.length);
  });
} finally {
  for (const f of closers.reverse()) await f().catch(() => {});
  if (prevHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = prevHome;
  for (const h of handles) await h.close().catch(() => {});
  await fx.close();
  relay.closeAllConnections(); await new Promise<void>((r) => relay.close(() => r()));
  idp.closeAllConnections(); await new Promise<void>((r) => idp.close(() => r()));
}

console.log(c.failed === 0 ? `\nSERVICE ENDPOINT RENEWAL SMOKE OK (${c.passed} passed)` : `\nSERVICE ENDPOINT RENEWAL SMOKE FAILED (${c.passed} passed, ${c.failed} failed)`);
c.finish();
if (c.failed > 0) process.exit(1);
