/**
 * Plane-1 IdP-bridge smoke — the exchange proven against a REAL Better Auth instance (plan
 * §"Plane 1": "our own review of every token-minting path", not a hand-rolled stand-in).
 *
 * Section A boots better-auth (memory adapter + JWT plugin, out-of-the-box EdDSA/Ed25519) on a
 * loopback HTTP server, signs a user up, fetches a real session JWT over HTTP, and proves the
 * bridge end-to-end: OUR pinnedJwksResolver consumes BA's real /jwks endpoint, the exchange
 * derives the issuer-namespaced owner, the ledger hook authors scope/parent, and the minted
 * bearer round-trips validateUserToken. Reality checks pin BA's shape (alg=EdDSA + kid; sub =
 * user id) so a future BA default change fails loud here, not at a deploy.
 *
 * Section B isolates the reject matrix on a synthetic EdDSA IdP (controlled claims real BA can't
 * mint): tamper, alg confusion, key smuggling, foreign key, wrong iss/aud, expired, post-dated,
 * missing sub/exp, ledger deny, no-grant deny, bad actor grammar (hook must NOT be consulted).
 * Broker-free; loopback HTTP only. Run: pnpm smoke:auth-idp-bridge
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintLifecycleUid } from "@cotal-ai/core";
import { SignJWT, decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair } from "jose";
import type { CryptoKey, JWK } from "jose";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins/jwt";
import { toNodeHandler } from "better-auth/node";
import {
  createIdpBridge,
  createUserTokenIssuer,
  deriveOwnerToken,
  generateSigningKey,
  pinnedJwksResolver,
  validateUserToken,
} from "../src/index.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
async function rejects(name: string, fn: () => Promise<unknown> | unknown, needle?: string) {
  try { await fn(); check(`${name} (expected rejection)`, false); }
  catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(needle && !msg.includes(needle) ? `${name} (wrong reason: ${msg})` : name, !needle || msg.includes(needle));
  }
}

const SPACE = "demo";
const SECRET = "s".repeat(32);

// ---------- Section A: the real Better Auth instance ----------
console.log("A) real Better Auth (memory adapter + JWT plugin, defaults)");

// Listen first (port 0 → ephemeral, no fixed-port collisions), then configure BA with the real
// origin — the handler closure binds `auth` after the fact.
let handler: ReturnType<typeof toNodeHandler> | undefined;
const server = createServer((req, res) => handler!(req, res));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const auth = betterAuth({
  baseURL: origin,
  secret: "smoke-only-better-auth-secret-0123456789",
  // The memory adapter requires every model pre-seeded (it throws on a missing key); the jwt
  // plugin adds the `jwks` model on top of BA's base four.
  database: memoryAdapter({ user: [], session: [], account: [], verification: [], jwks: [] }),
  emailAndPassword: { enabled: true },
  // Explicit iss/aud (operator best practice — both sides pin the same strings; BA's defaults
  // would be the baseURL origin anyway, but a pin should never rest on a default).
  plugins: [jwt({ jwt: { issuer: origin, audience: origin } })],
});
handler = toNodeHandler(auth);

// Sign up headless, then fetch the session JWT over REAL HTTP with the real session cookie.
const signup = await auth.api.signUpEmail({
  body: { email: "human@example.test", password: "correct-horse-battery", name: "Human 42" },
  returnHeaders: true,
});
const userId = signup.response.user.id;
const cookie = (signup.headers.get("set-cookie") ?? "").split(";")[0];
check("BA signup yields a user id + session cookie", !!userId && cookie.includes("="));

const tokenRes = await fetch(`${origin}/api/auth/token`, { headers: { cookie } });
const { token: idpJwt } = (await tokenRes.json()) as { token: string };
check("BA /token returns a JWT for the session", tokenRes.status === 200 && typeof idpJwt === "string" && idpJwt.split(".").length === 3);

// Reality-pin BA's out-of-the-box shape — a default change (alg, sub) must fail HERE.
{
  const h = decodeProtectedHeader(idpJwt);
  const p = decodeJwt(idpJwt);
  check("BA JWT is EdDSA with a kid (out-of-the-box)", h.alg === "EdDSA" && typeof h.kid === "string");
  check("BA JWT sub is the user id; iss/aud as pinned", p.sub === userId && p.iss === origin && p.aud === origin);
  check("BA JWT expires (session policy)", typeof p.exp === "number" && p.exp > Math.floor(Date.now() / 1000));
}

// The bridge, wired exactly as an operator would: pinned resolver on BA's real JWKS endpoint.
const cotalKey = await generateSigningKey();
const cotalIssuer = createUserTokenIssuer({ issuer: "https://auth.cotal.test", key: cotalKey });
// A deterministic root-credential mint stub (R1): the bridge REQUIRES the hook, but these Plane-1
// exchange tests never run the connect arm, so a fixed grammar-valid id is enough to prove the
// claim rides through issue↔validate. `credCalls` lets a test assert the hook is actually invoked.
const credCalls: Array<{ owner: string; actor: string; lifecycleUid: string }> = [];
const mintStub = async (a: { owner: string; actor: string; lifecycleUid: string }): Promise<string> => { credCalls.push(a); return "root0001"; };
const hookCalls: Array<{ owner: string; actor: string }> = [];
const hookUid = mintLifecycleUid();
const bridge = createIdpBridge({
  idp: { issuer: origin, audience: origin, key: pinnedJwksResolver(`${origin}/api/auth/jwks`) },
  space: SPACE,
  spaceSecret: SECRET,
  issuer: cotalIssuer,
  mintConnectCredential: mintStub,
  authorizeActor: (owner, actor) => {
    hookCalls.push({ owner, actor });
    if (actor === "denied_agent") throw new Error("ledger: actor not authorized for this owner");
    // Grants are lifecycle-bound from v0.4: the bridge refuses a uid-less grant at mint.
    return { scope: ["chat"], parent: `${owner}.spawner_1`, lifecycleUid: hookUid };
  },
});

const expectedOwner = deriveOwnerToken(SECRET, JSON.stringify([origin, userId]));
const res = await bridge.exchange(idpJwt, { actor: "agent_1" });
check("exchange mints a bearer bound to the issuer-namespaced derived owner", res.owner === expectedOwner);
check("exchange reports the bearer exp", typeof res.exp === "number" && res.exp === decodeJwt(res.token).exp);

const v = await validateUserToken(res.token, { key: cotalIssuer.localKeySet(), issuer: "https://auth.cotal.test", audience: SPACE });
check("minted bearer round-trips validateUserToken with the full principal",
  v.owner === expectedOwner && v.space === SPACE && v.act.actor === "agent_1");
check("scope + parent came from the LEDGER HOOK, server-authored",
  v.act.scope?.join() === "chat" && v.act.parent === `${expectedOwner}.spawner_1` && hookCalls[0]?.owner === expectedOwner);
check("the bearer carries the root credential id from the mint hook (R1: every v0.4 bearer is credential-bound)",
  v.credentialId === "root0001" && credCalls.some((c) => c.owner === expectedOwner && c.actor === "agent_1" && typeof c.lifecycleUid === "string"));
check("re-login is deterministic (same sub → same owner)",
  (await bridge.exchange(idpJwt, { actor: "agent_2" })).owner === expectedOwner);
{
  const short = await bridge.exchange(idpJwt, { actor: "agent_1", ttlSec: 60 });
  const skew = Math.abs(short.exp - (Math.floor(Date.now() / 1000) + 60));
  check("ttlSec passes through to the bearer exp", skew <= 2);
}

await rejects("ledger deny fails the exchange", () => bridge.exchange(idpJwt, { actor: "denied_agent" }), "ledger");
{
  const before = hookCalls.length;
  await rejects("a bad-grammar actor is refused BEFORE the ledger hook runs",
    () => bridge.exchange(idpJwt, { actor: "a.b" }));
  check("…and the hook was not consulted", hookCalls.length === before);
}
{
  // Same signature, tampered payload — must die at the JWKS signature check.
  const [h, p, s] = idpJwt.split(".");
  const forged = JSON.parse(Buffer.from(p, "base64url").toString());
  forged.sub = "someone-else";
  await rejects("a payload-tampered BA token is rejected (signature)",
    () => bridge.exchange(`${h}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${s}`, { actor: "agent_1" }));
}

// ---------- Section B: reject matrix on a synthetic IdP (controlled claims) ----------
console.log("B) synthetic-IdP reject matrix (claims real BA can't mint)");
const IDP_ISS = "https://idp.example.test";
const { privateKey: idpPriv, publicKey: idpPub } = await generateKeyPair("EdDSA", { extractable: true });
const idpKid = "idp-key-1";
const localKey = (async (header: { kid?: string }) => {
  if (header.kid !== idpKid) throw new Error(`no key for kid ${String(header.kid)}`);
  return idpPub as CryptoKey;
}) as Parameters<typeof validateUserToken>[1]["key"];

const now = () => Math.floor(Date.now() / 1000);
const mintIdp = (mut: (j: SignJWT) => SignJWT, header: Record<string, unknown> = {}) =>
  mut(new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: idpKid, ...header } as never))
    .sign(idpPriv);
const baseIdp = (j: SignJWT) => j.setSubject("human-42").setIssuer(IDP_ISS).setAudience(IDP_ISS).setIssuedAt(now()).setExpirationTime(now() + 300);

const synth = createIdpBridge({
  idp: { issuer: IDP_ISS, audience: IDP_ISS, key: localKey },
  space: SPACE,
  spaceSecret: SECRET,
  issuer: cotalIssuer,
  mintConnectCredential: mintStub,
  authorizeActor: () => ({ lifecycleUid: mintLifecycleUid() }),
});

check("synthetic happy path exchanges (control for the rejects below)",
  (await synth.exchange(await mintIdp(baseIdp), { actor: "agent_1" })).owner === deriveOwnerToken(SECRET, JSON.stringify([IDP_ISS, "human-42"])));
check("a scopeless grant mints a scopeless bearer (explicit allow, no scope)",
  (await validateUserToken((await synth.exchange(await mintIdp(baseIdp), { actor: "agent_1" })).token,
    { key: cotalIssuer.localKeySet(), issuer: "https://auth.cotal.test", audience: SPACE })).scope.length === 0);
{
  // Grants are lifecycle-bound from v0.4 (SPEC 13.1): a uid-less grant cannot mint a bearer of
  // ANY shape - the connect gate would refuse it anyway, so the bridge fails at the earlier
  // boundary with the re-grant instruction.
  const uidless = createIdpBridge({
    idp: { issuer: IDP_ISS, audience: IDP_ISS, key: localKey },
    space: SPACE, spaceSecret: SECRET, issuer: cotalIssuer,
    mintConnectCredential: mintStub,
    authorizeActor: () => ({}),
  });
  let refused = false;
  try { await uidless.exchange(await mintIdp(baseIdp), { actor: "agent_1" }); }
  catch (e) { refused = String(e).includes("no lifecycleUid"); }
  check("a grant without a lifecycleUid refuses at mint (bearers are lifecycle-bound)", refused);
}

// The minted Cotal bearer must NOT outlive the IdP proof it rests on: request the max TTL against a
// near-expiry IdP JWT and assert the bearer exp is capped to the IdP's remaining life (~30s), not now+900.
{
  const idpExp = now() + 30;
  const nearExpiry = await mintIdp((j) =>
    j.setSubject("human-42").setIssuer(IDP_ISS).setAudience(IDP_ISS).setIssuedAt(now()).setExpirationTime(idpExp));
  const capped = await synth.exchange(nearExpiry, { actor: "agent_1", ttlSec: 900 });
  check("a near-expiry IdP proof caps the bearer to its remaining life, not the full TTL",
    capped.exp <= idpExp + 2 && capped.exp > now() + 20, { bearerExp: capped.exp, idpExp });
}

await rejects("HS256 alg confusion is rejected at the header", async () => {
  const hs = await new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject("human-42")
    .setIssuer(IDP_ISS).setAudience(IDP_ISS).setIssuedAt(now()).setExpirationTime(now() + 300)
    .sign(new TextEncoder().encode("smoke-only-symmetric-secret-0123456789"));
  return synth.exchange(hs, { actor: "agent_1" });
}, "alg");
await rejects("a jku key-smuggling header is rejected outright",
  async () => synth.exchange(await mintIdp(baseIdp, { jku: "https://evil.example/jwks" }), { actor: "agent_1" }), "jku");
{
  // Foreign EdDSA key, same kid + claims — must die at signature verification.
  const { privateKey: foreign } = await generateKeyPair("EdDSA");
  await rejects("a foreign-key token with a matching kid is rejected (signature)",
    async () => synth.exchange(await baseIdp(new SignJWT({}).setProtectedHeader({ alg: "EdDSA", kid: idpKid })).sign(foreign), { actor: "agent_1" }));
}
await rejects("wrong iss is rejected",
  async () => synth.exchange(await mintIdp((j) => baseIdp(j).setIssuer("https://other.example")), { actor: "agent_1" }));
await rejects("wrong aud is rejected",
  async () => synth.exchange(await mintIdp((j) => baseIdp(j).setAudience("https://other.example")), { actor: "agent_1" }));
await rejects("a MULTI-audience token is rejected — exact aud, not set-membership",
  async () => synth.exchange(await mintIdp((j) => baseIdp(j).setAudience([IDP_ISS, "https://other.example"])), { actor: "agent_1" }), "aud");
check("a singleton-array aud equal to the configured audience is accepted (RFC 7519 array form)",
  (await synth.exchange(await mintIdp((j) => baseIdp(j).setAudience([IDP_ISS])), { actor: "agent_1" })).owner === deriveOwnerToken(SECRET, JSON.stringify([IDP_ISS, "human-42"])));
await rejects("a missing iat is rejected",
  async () => synth.exchange(await mintIdp((j) => j.setSubject("human-42").setIssuer(IDP_ISS).setAudience(IDP_ISS).setExpirationTime(now() + 300)), { actor: "agent_1" }), "iat");
await rejects("an embedded jwk header is rejected outright",
  async () => synth.exchange(await mintIdp(baseIdp, { jwk: { kty: "OKP", crv: "Ed25519", x: "AA" } }), { actor: "agent_1" }), "jwk");
await rejects("an expired IdP token is rejected",
  async () => synth.exchange(await mintIdp((j) => j.setSubject("human-42").setIssuer(IDP_ISS).setAudience(IDP_ISS).setIssuedAt(now() - 600).setExpirationTime(now() - 300)), { actor: "agent_1" }));
await rejects("a post-dated (future-iat) IdP token is rejected",
  async () => synth.exchange(await mintIdp((j) => j.setSubject("human-42").setIssuer(IDP_ISS).setAudience(IDP_ISS).setIssuedAt(now() + 3600).setExpirationTime(now() + 3900)), { actor: "agent_1" }), "iat");
await rejects("a missing exp is rejected — session proofs must expire",
  async () => synth.exchange(await mintIdp((j) => j.setSubject("human-42").setIssuer(IDP_ISS).setAudience(IDP_ISS).setIssuedAt(now())), { actor: "agent_1" }), "exp");
await rejects("a missing sub is rejected",
  async () => synth.exchange(await mintIdp((j) => j.setIssuer(IDP_ISS).setAudience(IDP_ISS).setIssuedAt(now()).setExpirationTime(now() + 300)), { actor: "agent_1" }), "sub");
{
  const badGrant = createIdpBridge({
    idp: { issuer: IDP_ISS, audience: IDP_ISS, key: localKey },
    space: SPACE, spaceSecret: SECRET, issuer: cotalIssuer,
    mintConnectCredential: mintStub,
    authorizeActor: () => null as never,
  });
  await rejects("a hook returning a non-object is a DENY (no allow-by-default)",
    async () => badGrant.exchange(await mintIdp(baseIdp), { actor: "agent_1" }), "deny");
}

// Misconfig fails at CONSTRUCTION, not as every-exchange-rejected. Each of the three below supplies
// the REQUIRED mintConnectCredential hook so the constructor reaches, and refuses on, the field the
// cell names: the hook is validated last (idp.issuer, idp.audience, idp.key, authorizeActor, then
// it), so omitting it left each cell one reordering away from passing for the wrong reason.
await rejects("a missing idp.issuer pin fails at construction",
  () => createIdpBridge({ idp: { issuer: "", audience: IDP_ISS, key: localKey }, space: SPACE, spaceSecret: SECRET, issuer: cotalIssuer, authorizeActor: () => ({}), mintConnectCredential: mintStub }), "issuer");
await rejects("a missing idp.audience pin fails at construction",
  () => createIdpBridge({ idp: { issuer: IDP_ISS, audience: "", key: localKey }, space: SPACE, spaceSecret: SECRET, issuer: cotalIssuer, authorizeActor: () => ({}), mintConnectCredential: mintStub }), "audience");
await rejects("a missing idp.key fails at construction",
  () => createIdpBridge({ idp: { issuer: IDP_ISS, audience: IDP_ISS, key: undefined as never }, space: SPACE, spaceSecret: SECRET, issuer: cotalIssuer, authorizeActor: () => ({}), mintConnectCredential: mintStub }), "key");
await rejects("a missing authorizeActor hook fails at construction",
  () => createIdpBridge({ idp: { issuer: IDP_ISS, audience: IDP_ISS, key: localKey }, space: SPACE, spaceSecret: SECRET, issuer: cotalIssuer, authorizeActor: undefined as never, mintConnectCredential: mintStub }), "hook");
// R1: the mint hook is REQUIRED at construction — a public bridge that could mint a claimless
// bearer would silently disable deny-new in any composition without the connect arm.
await rejects("a missing mintConnectCredential hook fails at construction (v0.4 never mints claimless)",
  () => createIdpBridge({ idp: { issuer: IDP_ISS, audience: IDP_ISS, key: localKey }, space: SPACE, spaceSecret: SECRET, issuer: cotalIssuer, authorizeActor: () => ({ lifecycleUid: mintLifecycleUid() }), mintConnectCredential: undefined as never }), "mintConnectCredential");

// The derivation encoding is INJECTIVE: a '|'-straddling issuer/sub pair cannot collide.
check("derivation encoding is injective — ('a','b|c') and ('a|b','c') derive different owners",
  deriveOwnerToken(SECRET, JSON.stringify(["a".repeat(1), "b|c"])) !== deriveOwnerToken(SECRET, JSON.stringify(["a|b", "c"])));

// The owner namespace is issuer-separated: same sub under a different IdP issuer → different owner.
check("same sub under a different IdP issuer derives a DIFFERENT owner",
  deriveOwnerToken(SECRET, JSON.stringify([IDP_ISS, "human-42"])) !== deriveOwnerToken(SECRET, JSON.stringify([origin, "human-42"])));

server.close();
console.log(`\nidp-bridge smoke: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
