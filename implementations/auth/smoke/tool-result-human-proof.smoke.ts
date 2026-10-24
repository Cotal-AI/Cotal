import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { mintLifecycleUid } from "@cotal-ai/core";
import {
  createIdpBridge, createUserTokenIssuer, deriveOwnerForIdpSubject, generateSigningKey,
  handleToolResultHumanProof, pinnedJwksResolver, TOOL_RESULT_HUMAN_PROOF_PATH,
  validateUserToken, verifyIdpToken, verifyToolResultHumanProof,
} from "@cotal-ai/auth";

let passed = 0;
function check(name: string, value: unknown) { assert.ok(value, name); passed++; console.log(`PASS ${name}`); }
async function refuses(name: string, fn: () => Promise<unknown>) {
  await assert.rejects(fn, name); passed++; console.log(`PASS ${name}`);
}
const now = Math.floor(Date.now() / 1000);
const keys = await generateKeyPair("EdDSA");
const foreign = await generateKeyPair("EdDSA");
const jwk = { ...await exportJWK(keys.publicKey), kid: "fixture" };
const issuer = "https://password-idp.example.test";
const secret = randomBytes(32);
const cap = randomBytes(32).toString("base64url");
let keyReads = 0;
const keyServer = createServer((_req, res) => { keyReads++; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise<void>(resolve => keyServer.listen(0, "127.0.0.1", resolve));
const keyUrl = `http://127.0.0.1:${(keyServer.address() as AddressInfo).port}/jwks`;
const idp = { issuer, audience: issuer, key: pinnedJwksResolver(keyUrl) };
const ctx = { cap, bridgeIdp: idp, ownerSecret: secret, badCaps: [] as number[] };
const server = createServer((req, res) => { void handleToolResultHumanProof(req, res, ctx).catch(() => { res.writeHead(500); res.end(); }); });
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${TOOL_RESULT_HUMAN_PROOF_PATH}`;
const sign = (claims: Record<string, unknown> = {}, options: { issuer?: string; audience?: string | readonly string[]; foreign?: boolean; header?: Record<string, unknown> } = {}) =>
  new SignJWT({ auth_time: now, amr: ["pwd"], ...claims }).setProtectedHeader({ alg: "EdDSA", kid: "fixture", ...options.header })
    .setIssuer(options.issuer ?? issuer).setAudience(typeof options.audience === "object" ? [...options.audience] : options.audience ?? issuer).setSubject("human")
    .setIssuedAt(now).setExpirationTime(now + 900).sign(options.foreign ? foreign.privateKey : keys.privateKey);
const post = (body: unknown, headers: Record<string, string> = {}, method = "POST") => fetch(url, {
  method, headers: { "content-type": "application/json", authorization: `Bearer ${cap}`, ...headers },
  ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
});
try {
  const token = await sign();
  const verified = await verifyIdpToken(token, idp);
  check("signed auth_time survives the pinned verification boundary", verified.auth_time === now);
  check("signed password amr survives verification and is frozen", verified.amr?.join() === "pwd" && Object.isFrozen(verified.amr));
  check("pinned JWKS was actually read", keyReads > 0);
  for (const age of [0, 300]) {
    const proof = await verifyToolResultHumanProof(await sign({ auth_time: now - age }), idp, () => now * 1000);
    check(`password proof admitted at age ${age}`, proof.authTime === now - age && proof.sub === "human" && Object.isFrozen(proof));
  }
  check("password proof admitted one millisecond before the ceiling",
    (await verifyToolResultHumanProof(token, idp, () => now * 1000 + 299_999)).authTime === now);
  for (const elapsed of [300_001, 300_999])
    await refuses(`password proof refuses at ${elapsed} elapsed milliseconds`, () => verifyToolResultHumanProof(token, idp, () => now * 1000 + elapsed));
  await refuses("password event one millisecond in the future refuses", () => verifyToolResultHumanProof(token, idp, () => now * 1000 - 1));
  const fractionalExpiry = await new SignJWT({ auth_time: now, amr: ["pwd"] }).setProtectedHeader({ alg: "EdDSA", kid: "fixture" })
    .setIssuer(issuer).setAudience(issuer).setSubject("human").setIssuedAt(now).setExpirationTime(now + 299.25).sign(keys.privateKey);
  check("proof is admitted just before its fractional expiry",
    (await verifyToolResultHumanProof(fractionalExpiry, idp, () => now * 1000 + 299_249)).authTime === now);
  for (const elapsed of [299_250, 299_251])
    await refuses(`proof refuses at or after fractional expiry (${elapsed} ms)`, () => verifyToolResultHumanProof(fractionalExpiry, idp, () => now * 1000 + elapsed));
  for (const [label, claims] of [
    ["301 seconds", { auth_time: now - 301 }], ["future", { auth_time: now + 1 }],
    ["milliseconds", { auth_time: now * 1000 }], ["fractional", { auth_time: now - 0.5 }],
    ["string", { auth_time: String(now) }], ["missing time", { auth_time: undefined }],
    ["negative", { auth_time: -1 }], ["missing amr", { amr: undefined }],
    ["string amr", { amr: "pwd" }], ["empty amr", { amr: [] }],
    ["non-password", { amr: ["otp"] }], ["mixed-type amr", { amr: ["pwd", 1] }],
    ["empty method", { amr: ["pwd", ""] }], ["object amr", { amr: { pwd: true } }],
  ] as const) {
    const bad = await sign(claims);
    await refuses(`${label} refuses consent proof`, () => verifyToolResultHumanProof(bad, idp, () => now * 1000));
    check(`${label} does not change ordinary JWT verification`, (await verifyIdpToken(bad, idp)).sub === "human");
  }
  for (const [name, options] of [
    ["foreign issuer", { issuer: "https://foreign.example.test" }],
    ["foreign audience", { audience: "https://foreign.example.test" }],
    ["mixed audience", { audience: [issuer, "https://foreign.example.test"] }],
    ["foreign signing key", { foreign: true }],
    ["foreign key id", { header: { kid: "unknown" } }],
    ["embedded key", { header: { jwk } }],
  ] as const) await refuses(name, async () => verifyToolResultHumanProof(await sign({}, options), idp));
  const pieces = token.split(".");
  const tampered = `${pieces[0]}.${Buffer.from(JSON.stringify({ sub: "other", auth_time: now, amr: ["pwd"] })).toString("base64url")}.${pieces[2]}`;
  await refuses("forged payload", () => verifyToolResultHumanProof(tampered, idp));
  await refuses("invalid decision clock", () => verifyToolResultHumanProof(token, idp, () => NaN));
  const expired = await new SignJWT({ auth_time: now, amr: ["pwd"] }).setProtectedHeader({ alg: "EdDSA", kid: "fixture" })
    .setIssuer(issuer).setAudience(issuer).setSubject("human").setIssuedAt(now - 10).setExpirationTime(now - 1).sign(keys.privateKey);
  await refuses("JWT clock tolerance cannot admit an expired consent proof", () => verifyToolResultHumanProof(expired, idp, () => now * 1000));
  const response = await post({ idpToken: token, subject: "human" });
  const decision = await response.json() as Record<string, unknown>;
  check("real HTTP handler admits signed password proof", response.status === 200 && decision.authorized === true);
  check("owner derives only from verified subject", decision.owner === deriveOwnerForIdpSubject(secret, issuer, "human") && decision.sub === "human");
  check("decision carries no token or signer", Object.keys(decision).sort().join() === "authTime,authorized,exp,owner,sub");
  check("session subject mismatch refuses", (await post({ idpToken: token, subject: "other" })).status === 403);
  check("mixed proofs refuse", (await post({ idpToken: token, subject: "human", actorToken: "inert-fixture" })).status === 400);
  check("caller owner assertion refuses", (await post({ idpToken: token, subject: "human", owner: decision.owner })).status === 400);
  check("agent secret cannot replace human JWT", (await post({ idpToken: "inert-agent-key", subject: "human" })).status === 403);
  check("session-only envelope refuses", (await post({ subject: "human" })).status === 400);
  check("null envelope refuses", (await post(null)).status === 400);
  check("missing host capability refuses", (await post({ idpToken: token, subject: "human" }, { authorization: "" })).status === 401);
  check("browser origin refuses", (await post({ idpToken: token, subject: "human" }, { origin: issuer })).status === 403);
  check("non-JSON refuses", (await post({}, { "content-type": "text/plain" })).status === 415);
  check("GET refuses", (await post({}, {}, "GET")).status === 405);
  check("oversized body refuses", (await post({ idpToken: "x".repeat(70_000), subject: "human" })).status === 413);
  const malformed = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${cap}` }, body: `{"idpToken":${token}` });
  const malformedReply = await malformed.text();
  check("malformed proof body refuses without echoing proof bytes", malformed.status === 400 && !malformedReply.includes(token) && malformedReply.includes("invalid human proof request"));
  check("signed missing provenance refuses on HTTP route", (await post({ idpToken: await sign({ auth_time: undefined, amr: undefined }), subject: "human" })).status === 403);

  let credentialWrites = 0;
  const bearerIssuer = createUserTokenIssuer({ issuer: "https://cotal.example.test", key: await generateSigningKey() });
  const bridge = createIdpBridge({ idp, space: "proof_fixture", spaceSecret: secret, issuer: bearerIssuer,
    authorizeActor: () => ({ lifecycleUid: mintLifecycleUid() }),
    mintConnectCredential: async () => { credentialWrites++; return "root0001"; } });
  const ordinary = await bridge.exchange(await sign({ auth_time: undefined, amr: undefined }), { actor: "cli" });
  const claims = await validateUserToken(ordinary.token, { issuer: bearerIssuer.issuer, audience: "proof_fixture", key: bearerIssuer.localKeySet() });
  check("ordinary exchange remains available without freshness", claims.act.actor === "cli" && credentialWrites === 1);
  check("ordinary exchange gains no consent authority", claims.act.view === undefined && !Object.keys(claims).includes("auth_time"));
  const originalClock = Date.now;
  try {
    for (const elapsed of [300_000, 300_001, 300_999]) {
      Date.now = () => now * 1000 + elapsed;
      const boundary = await post({ idpToken: token, subject: "human" });
      check(`real HTTP proof door enforces the ${elapsed} ms boundary`, boundary.status === (elapsed === 300_000 ? 200 : 403));
    }
  } finally { Date.now = originalClock; }
  const EXPECTED = 70;
  assert.equal(passed, EXPECTED, "signed proof smoke must execute every declared boundary cell");
  console.log(`tool-result-human-proof smoke: ${passed} passed, 0 failed`);
} finally {
  server.closeAllConnections(); keyServer.closeAllConnections();
  await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => keyServer.close(() => resolve()))]);
}
