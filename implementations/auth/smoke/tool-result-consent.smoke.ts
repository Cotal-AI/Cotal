import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createUser, createAccount } from "@nats-io/nkeys";
import { Kvm } from "@nats-io/kv";
import { epAuthBucket, mintCreds, mintLifecycleUid, newIdentity, setupSpaceStreams, parseToolResultConsent, verifyArtifactSignature, type SignerAnchor } from "@cotal-ai/core";
import { createToolResultConsentSigner, makeToolResultConsentRecorder, handleToolResultConsent, pinnedJwksResolver, startAuthService, deriveOwnerForIdpSubject, grantActor, grantManagedActor, loadOwnerSecret, type AuthServiceHandle } from "../src/index.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { startHostedAuthFixture } from "./_hosted-auth-fixture.js";
import { spaceSegment } from "@cotal-ai/workspace";
import { emitSentinel } from "@cotal-ai/smoke-kit";

let passed = 0;
function check(name: string, value: unknown) { assert.ok(value, name); passed++; console.log(`PASS ${name}`); }
const fx = await startHostedAuthFixture("consent", 1);
const a = fx.accounts[0]!;
const pair = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(pair.publicKey), kid: "human-proof" };
const idp = createServer((_req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise<void>(resolve => idp.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
writeFileSync(join(a.stateDir, "idp.json"), JSON.stringify({ ver: 1, url: `${origin}/api/auth`, issuer: origin, audience: origin, jwksUri: `${origin}/jwks` }), { mode: 0o600 });
const secret = (await loadOwnerSecret(a.store, a.space))!;
const owner = deriveOwnerForIdpSubject(secret, origin, "human");
const signer = createUser();
const keyId = "consent_fixture";
const signerSeed = new TextDecoder().decode(signer.getSeed());
await a.store.create(`auth/${spaceSegment(a.space)}/tool-result-consent-key.json`, JSON.stringify({ ver: 1, keyId, seed: signerSeed }));
const anchor: SignerAnchor = { keyId, publicKey: signer.getPublicKey(), owner: "ai.cotal", roles: ["consents"], scope: { consents: ["tool-results"] }, validFrom: 0, validTo: Number.MAX_SAFE_INTEGER };
const uid = mintLifecycleUid(), holderUid = mintLifecycleUid();
grantActor(a.stateDir, { owner, actor: "web", lifecycleUid: holderUid, scope: [], allowSubscribe: [], allowPublish: [] });
grantManagedActor(a.stateDir, { custody: { kind: "foreground" }, owner, actor: "worker", lifecycleUid: uid, scope: [], allowSubscribe: [], allowPublish: [], tokenHash: "a".repeat(64) });
let service: AuthServiceHandle | undefined;
let resolvedAnchor: SignerAnchor | undefined = anchor;
let reader: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
const now = Math.floor(Date.now() / 1000);
const token = await new SignJWT({ auth_time: now, amr: ["pwd"] }).setProtectedHeader({ alg: "EdDSA", kid: "human-proof" }).setIssuer(origin).setAudience(origin).setSubject("human").setIssuedAt(now).setExpirationTime(now + 900).sign(pair.privateKey);
const body = { id: "consent_1", idpToken: token, subject: "human", accountPublicKey: a.accountPublicKey,
  holder: { actor: "web", lifecycleUid: holderUid }, target: { owner, actor: "worker", lifecycleUid: uid }, ttlMs: 86_400_000 };
async function post(value: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${service!.url}/tool-result-consent/issue`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service!.cap}`, ...headers }, body: JSON.stringify(value) });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
try {
  await setupSpaceStreams({ servers: fx.servers, space: a.space, creds: await mintCreds(a.auth, newIdentity(), "provisioner") });
  const input = { context: { accountPublicKey: a.accountPublicKey, lifecycleUid: mintLifecycleUid() }, space: a.space, servers: fx.servers,
    stateDir: a.stateDir, store: a.store, storeIdentity: a.store.identity,
    toolResultConsents: { keyId, resolveAnchor: async () => resolvedAnchor } };
  service = await startAuthService(input);
  const issued = await post(body);
  assert.equal(issued.status, 200, `same-owner signed human obtains consent through actual auth service route (${JSON.stringify(issued.body)})`); passed++;
  const consent = parseToolResultConsent(issued.body.consent);
  verifyArtifactSignature(consent as unknown as Record<string, unknown>, anchor);
  check("consent preserves authorized target holder and 24-hour window", consent.exp - consent.iat === 86_400_000 && consent.holder.owner === owner && consent.holder.actor === "web" && consent.target.lifecycleUid === uid && consent.id === body.id);
  reader = await openAuthorityClient({ server: fx.servers, space: a.space, dataAccount: { pub: a.accountPublicKey, signingSeed: a.auth.account.signingSeed! }, label: "consent-fixture-reader", grants: id => ({ publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: () => {} });
  const kv = await new Kvm(reader.nc).open(epAuthBucket(a.space));
  const recorded = await kv.get(`consent.${body.id}`);
  check("signed consent row is durable before HTTP release", recorded !== null && JSON.stringify(recorded.json()) === JSON.stringify(consent));
  for (const [name, change] of [
    ["foreign account", { accountPublicKey: createAccount().getPublicKey() }],
    ["cross-owner target", { target: { ...body.target, owner: `u_${"b".repeat(26)}` } }],
    ["target as holder", { holder: { actor: "worker", lifecycleUid: uid } }],
    ["stale target lifecycle", { target: { ...body.target, lifecycleUid: mintLifecycleUid() } }],
    ["stale holder lifecycle", { holder: { ...body.holder, lifecycleUid: mintLifecycleUid() } }],
    ["oversized window", { ttlMs: 86_400_001 }], ["caller owner", { owner }], ["caller scope", { scope: ["admin"] }],
    ["wrong subject", { subject: "other" }], ["session-only", { idpToken: "not-a-jwt" }],
  ] as const) {
    const id = `refuse_${passed}`;
    const answer = await post({ ...body, id, ...change });
    check(`${name} refuses before signed release`, answer.status >= 400 && answer.body.consent === undefined && await kv.get(`consent.${id}`) === null);
  }
  const duplicate = await Promise.all([post({ ...body, id: "duplicate" }), post({ ...body, id: "duplicate" })]);
  check("concurrent duplicate issuance has one winner and one refusal", duplicate.filter(r => r.status === 200).length === 1 && duplicate.filter(r => r.status === 409).length === 1);
  check("existing consent never overwrites on duplicate", (await post({ ...body, ttlMs: 1_000 })).status === 409 && JSON.stringify((await kv.get(`consent.${body.id}`))!.json()) === JSON.stringify(consent));
  check("browser Origin cannot reach host capability route", (await post(body, { origin })).status === 403);
  check("wrong host capability refuses", (await post(body, { authorization: "Bearer invalid" })).status === 401);
  for (const [name, changed] of [
    ["unknown", undefined], ["revoked", { ...anchor, revoked: true }],
    ["wrong role", { ...anchor, roles: ["receipts"] }], ["wrong scope", { ...anchor, scope: { consents: ["elsewhere"] } }],
    ["out of window", { ...anchor, validTo: 0 }],
  ] as const) {
    resolvedAnchor = changed as SignerAnchor | undefined;
    const id = `anchor_${passed}`;
    const response = await post({ ...body, id });
    check(`${name} anchor refuses without creating consent`, response.status >= 400 && response.body.consent === undefined && await kv.get(`consent.${id}`) === null);
  }
  resolvedAnchor = anchor;
  const rawSignerDoc = a.store.values.get(`auth/${spaceSegment(a.space)}/tool-result-consent-key.json`)!;
  for (const raw of [undefined, "{}", "not-json", JSON.stringify({ ver: 1, keyId, seed: "not-a-seed" })]) {
    if (raw === undefined) a.store.values.delete(`auth/${spaceSegment(a.space)}/tool-result-consent-key.json`);
    else a.store.values.set(`auth/${spaceSegment(a.space)}/tool-result-consent-key.json`, raw);
    const response = await post({ ...body, id: `key_${passed}` });
    check("missing corrupt or unusable private signer refuses with no release", response.status === 503 && response.body.consent === undefined);
  }
  a.store.values.set(`auth/${spaceSegment(a.space)}/tool-result-consent-key.json`, rawSignerDoc);
  // Faults wrap the real broker operation, not the rule or signed artifact. No source mutation.
  for (const mode of ["before-write", "lost-ack", "post-write-fence"] as const) {
    let writes = 0, fenced = false;
    const record = makeToolResultConsentRecorder({ put: async (...args: Parameters<typeof kv.put>) => {
      writes++;
      if (mode === "before-write") throw new Error("fixture refusal with private-sentinel");
      const revision = await kv.put(...args);
      if (mode === "lost-ack") throw new Error("fixture lost acknowledgement");
      fenced = true; return revision;
    } }, () => { if (fenced) throw new Error("fixture plane fence"); }, a.space);
    const issue = createToolResultConsentSigner({ space: a.space, accountPublicKey: a.accountPublicKey, dir: a.stateDir, store: a.store,
      idp: { issuer: origin, audience: origin, key: pinnedJwksResolver(`${origin}/jwks`) }, ownerSecret: secret,
      signer: { keyId, resolveAnchor: async () => anchor }, record });
    const faultServer = createServer((req, res) => { void handleToolResultConsent(req, res, { cap: service!.cap, badCaps: [], issueToolResultConsent: issue }); });
    await new Promise<void>(resolve => faultServer.listen(0, "127.0.0.1", resolve));
    try {
      const id = `fault_${mode.replaceAll("-", "_")}`;
      const response = await fetch(`http://127.0.0.1:${(faultServer.address() as AddressInfo).port}/tool-result-consent/issue`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${service.cap}` }, body: JSON.stringify({ ...body, id }),
      });
      const result = await response.json() as Record<string, unknown>;
      check(`${mode} returns unknown and no usable consent or automatic retry`, response.status === 503 && result.outcome === "unknown" && result.consent === undefined && writes === 1);
      check(`${mode} records only an actual committed write`, (await kv.get(`consent.${id}`) !== null) === (mode !== "before-write"));
      check(`${mode} sanitized error contains no private input`, !JSON.stringify(result).includes("private-sentinel") && !JSON.stringify(result).includes(token));
    } finally { faultServer.closeAllConnections(); await new Promise<void>(resolve => faultServer.close(() => resolve())); }
  }
  const deletedId = "never_reopen";
  await post({ ...body, id: deletedId });
  await kv.delete(`consent.${deletedId}`);
  check("a deleted consent id cannot be reopened", (await post({ ...body, id: deletedId })).status === 409);
  let releaseClock = now * 1000;
  const delayedId = "expired_proof_during_storage";
  const delayedSigner = createToolResultConsentSigner({ space: a.space, accountPublicKey: a.accountPublicKey, dir: a.stateDir, store: a.store,
    idp: { issuer: origin, audience: origin, key: pinnedJwksResolver(`${origin}/jwks`) }, ownerSecret: secret,
    signer: { keyId, resolveAnchor: async () => anchor }, now: () => releaseClock,
    record: async consent => { await makeToolResultConsentRecorder(kv, () => {}, a.space)(consent); releaseClock += 300_001; },
  });
  await assert.rejects(delayedSigner({ ...body, id: delayedId }), (error: unknown) => !!error && typeof error === "object" && "outcome" in error && error.outcome === "unknown");
  check("proof aging out during persistence yields no released consent", await kv.get(`consent.${delayedId}`) !== null);
  const foreignId = "foreign_recorder_space";
  await assert.rejects(makeToolResultConsentRecorder(kv, () => {}, "foreign")({ ...consent, id: foreignId }));
  check("native recorder refuses foreign tenant before broker write", await kv.get(`consent.${foreignId}`) === null);
  const publicLeak = JSON.stringify(issued.body);
  check("response contains neither signer seed nor human JWT nor host capability", ![signerSeed, token, service.cap].some(secret => publicLeak.includes(secret)) && Object.keys(issued.body).join() === "consent");
  console.log(`tool-result-consent: ${passed} passed, 0 failed`);
  await service.close(); service = undefined;
  service = await startAuthService(input);
  check("restart does not reopen a recorded consent id", (await post(body)).status === 409);
  check("restart preserves original signed consent bytes", JSON.stringify((await kv.get(`consent.${body.id}`))!.json()) === JSON.stringify(consent));
  console.log(`tool-result-consent final: ${passed} passed, 0 failed`);
  emitSentinel({ passed, failed: 0 });
} finally {
  await reader?.close(); await service?.close(); idp.closeAllConnections(); await new Promise<void>(resolve => idp.close(() => resolve())); await fx.close();
}
