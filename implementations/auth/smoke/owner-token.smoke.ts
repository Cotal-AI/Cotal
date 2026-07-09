/**
 * Auth-bridge smoke: owner-token derivation + the strict user-token validator
 * (per-user-auth cutover prep — plan §"Plane 2" / §"Token shape"; broker-free).
 *
 * Pins the security-load-bearing properties:
 *  - derivation: deterministic, per-space unlinkable, non-PII, emits the exact core format;
 *  - nkey-DISJOINTNESS (flip acceptance criterion 2): an nkey never validates as a derived
 *    owner, and a derived owner is grammar-valid;
 *  - validation: EdDSA-pinned, key-smuggling headers rejected, iss/aud/exp/iat/TTL/ver/act
 *    all enforced fail-closed.
 * Run: pnpm smoke:auth-owner-token
 */
import { SignJWT, exportJWK, generateKeyPair, calculateJwkThumbprint } from "jose";
import type { CryptoKey, JWTPayload } from "jose";
import { assertDerivedOwnerToken, assertValidOwnerToken } from "@cotal-ai/core";
import { deriveOwnerToken, validateUserToken, USER_TOKEN_VER } from "../src/index.js";

let failures = 0;
function check(label: string, ok: boolean) {
  if (!ok) {
    failures++;
    console.error(`✗ ${label}`);
  } else {
    console.log(`✓ ${label}`);
  }
}
async function rejects(label: string, fn: () => Promise<unknown> | unknown, needle?: string) {
  try {
    await fn();
    check(`${label} (expected rejection)`, false);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    check(needle && !msg.includes(needle) ? `${label} (rejected but wrong reason: ${msg})` : label, !needle || msg.includes(needle));
  }
}

// ---- derivation ----
const secretA = "a".repeat(32);
const secretB = "b".repeat(32);
const tok = deriveOwnerToken(secretA, "better-auth|user-8f3a");
check(`derived token has the core format (${tok})`, assertDerivedOwnerToken(tok) === tok);
check("derived token passes the grammar validator", assertValidOwnerToken(tok) === tok);
check("deterministic: same (secret, subject) → same owner", deriveOwnerToken(secretA, "better-auth|user-8f3a") === tok);
check("per-space: different secret → different owner", deriveOwnerToken(secretB, "better-auth|user-8f3a") !== tok);
check("different subject → different owner", deriveOwnerToken(secretA, "better-auth|user-8f3b") !== tok);
const pii = deriveOwnerToken(secretA, "alice@example.com");
check("non-PII: token carries no subject substring", !pii.includes("alice") && !pii.includes("example"));
await rejects("rejects a short secret", () => deriveOwnerToken("tooshort", "sub"), "32 bytes");
await rejects("rejects an empty subject", () => deriveOwnerToken(secretA, ""), "non-empty");

// ---- nkey disjointness (flip acceptance criterion 2) ----
const NKEY = "UDOE2PE4P2EC4MBDNHSUYHIXF3FUWZMHLD6O7IA727W5UWW7RA7HIUB5";
await rejects("an nkey NEVER validates as a derived owner", () => assertDerivedOwnerToken(NKEY));
await rejects("an uppercase forgery of the format fails", () => assertDerivedOwnerToken("U_" + "A".repeat(26)));
await rejects("wrong-length body fails", () => assertDerivedOwnerToken("u_" + "a".repeat(25)));
check("derived token can never be nkey-shaped (28 chars, has '_', lowercase body)", tok.length === 28 && tok.includes("_") && tok.slice(2) === tok.slice(2).toLowerCase());

// ---- user-token validation ----
const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const { publicKey: roguePub, privateKey: roguePriv } = await generateKeyPair("EdDSA");
void roguePub;
const ISS = "https://auth.cotal.test";
const SPACE = "demo";
const owner = tok;

function baseClaims(): JWTPayload {
  return { sub: owner, scope: ["chat"], ver: USER_TOKEN_VER, act: { owner, actor: "agent_1" } };
}
async function mint(mutate: (p: JWTPayload) => void = () => {}, opts: { alg?: string; key?: CryptoKey; ttl?: number; header?: Record<string, unknown>; skewSec?: number; noNbf?: boolean } = {}) {
  const p = baseClaims();
  mutate(p);
  const now = Math.floor(Date.now() / 1000) + (opts.skewSec ?? 0);
  const jwt = new SignJWT(p)
    .setProtectedHeader({ alg: opts.alg ?? "EdDSA", ...(opts.header ?? {}) })
    .setIssuer(ISS)
    .setAudience(SPACE)
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.ttl ?? 300));
  if (!opts.noNbf) jwt.setNotBefore(now);
  return jwt.sign(opts.key ?? privateKey);
}
const V = { key: publicKey as CryptoKey, issuer: ISS, audience: SPACE };

const good = await validateUserToken(await mint(), V);
check("valid token accepted; owner/space/act round out", good.owner === owner && good.space === SPACE && good.act.actor === "agent_1" && good.ver === USER_TOKEN_VER);

await rejects("wrong signer rejected", async () => validateUserToken(await mint(() => {}, { key: roguePriv }), V));
await rejects("wrong issuer rejected", async () => {
  const now = Math.floor(Date.now() / 1000);
  const t = await new SignJWT(baseClaims()).setProtectedHeader({ alg: "EdDSA" }).setIssuer("https://evil.test").setAudience(SPACE).setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 300).sign(privateKey);
  return validateUserToken(t, V);
});
await rejects("wrong audience (space) rejected", async () => {
  const now = Math.floor(Date.now() / 1000);
  const t = await new SignJWT(baseClaims()).setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience("otherspace").setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 300).sign(privateKey);
  return validateUserToken(t, V);
});
await rejects("expired token rejected", async () => {
  const now = Math.floor(Date.now() / 1000);
  const t = await new SignJWT(baseClaims()).setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience(SPACE).setIssuedAt(now - 600).setNotBefore(now - 600).setExpirationTime(now - 300).sign(privateKey);
  return validateUserToken(t, V);
});
await rejects("missing exp rejected", async () => {
  const now = Math.floor(Date.now() / 1000);
  const t = await new SignJWT(baseClaims()).setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience(SPACE).setIssuedAt(now).setNotBefore(now).sign(privateKey);
  return validateUserToken(t, V);
}, "exp");
await rejects("missing nbf rejected", async () => validateUserToken(await mint(() => {}, { noNbf: true }), V), "nbf");
await rejects("overlong TTL rejected (revocation lever)", async () => validateUserToken(await mint(() => {}, { ttl: 86400 }), V), "cap");
// The panel-caught bypass: nbf = now (valid immediately) but iat/exp post-dated an hour out —
// passes nbf/exp checks and the exp-iat span cap, yet its effective validity from NOW is far
// beyond the cap. Only a clock-anchored iat guard kills this shape.
await rejects("future-dated iat/exp window rejected (clock-anchored cap)", async () => {
  const now = Math.floor(Date.now() / 1000);
  const t = await new SignJWT(baseClaims())
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuer(ISS)
    .setAudience(SPACE)
    .setIssuedAt(now + 3600)
    .setNotBefore(now)
    .setExpirationTime(now + 3900)
    .sign(privateKey);
  return validateUserToken(t, V);
}, "future");
await rejects("stale ver rejected (downgrade defense)", async () => validateUserToken(await mint((p) => (p.ver = 0)), V), "ver");
await rejects("missing act rejected", async () => validateUserToken(await mint((p) => delete p.act), V), "act");
await rejects("non-string actor rejected (no coercion)", async () => validateUserToken(await mint((p) => ((p.act as { actor: unknown }).actor = 123)), V), "string token");
await rejects("undotted act.parent rejected", async () => validateUserToken(await mint((p) => ((p.act as { parent?: string }).parent = "notaprincipal")), V), "not a principal");
await rejects("3-token act.parent rejected", async () => validateUserToken(await mint((p) => ((p.act as { parent?: string }).parent = `${owner}.a.b`)), V), "not a principal");
await rejects("nkey-owner act.parent rejected", async () => validateUserToken(await mint((p) => ((p.act as { parent?: string }).parent = `${NKEY}.agent_2`)), V), "derived owner");
{
  const withParent = await validateUserToken(await mint((p) => ((p.act as { parent?: string }).parent = `${owner}.spawner_1`)), V);
  check("valid principal act.parent accepted and round-trips", withParent.act.parent === `${owner}.spawner_1`);
}
await rejects("act.owner != sub rejected", async () => validateUserToken(await mint((p) => ((p.act as { owner: string }).owner = "u_" + "z".repeat(26))), V), "inconsistent");
await rejects("invalid actor rejected", async () => validateUserToken(await mint((p) => ((p.act as { actor: string }).actor = "a.b")), V));
await rejects("nkey-shaped sub rejected", async () => validateUserToken(await mint((p) => {
  p.sub = NKEY;
  (p.act as { owner: string }).owner = NKEY;
}), V), "derived owner");
await rejects("embedded jwk header rejected (key smuggling)", async () => {
  const jwk = await exportJWK(publicKey);
  jwk.kid = await calculateJwkThumbprint(jwk);
  return validateUserToken(await mint(() => {}, { header: { jwk } }), V);
}, "pinned");
await rejects("jku header rejected (key smuggling)", async () => validateUserToken(await mint(() => {}, { header: { jku: "https://evil.test/jwks" } }), V), "pinned");
await rejects("x5u header rejected (key smuggling)", async () => validateUserToken(await mint(() => {}, { header: { x5u: "https://evil.test/cert" } }), V), "pinned");
await rejects("x5c header rejected (key smuggling)", async () => validateUserToken(await mint(() => {}, { header: { x5c: ["MIIB"] } }), V), "pinned");
await rejects("non-EdDSA alg rejected", async () => {
  // HS256 token "signed" with a symmetric key — must die on the alg pin, never reach key use.
  const now = Math.floor(Date.now() / 1000);
  const t = await new SignJWT(baseClaims()).setProtectedHeader({ alg: "HS256" }).setIssuer(ISS).setAudience(SPACE).setIssuedAt(now).setExpirationTime(now + 300).sign(new TextEncoder().encode("k".repeat(32)));
  return validateUserToken(t, V);
}, "EdDSA");

if (failures) {
  console.error(`auth owner-token smoke: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("auth owner-token smoke: all checks passed");
process.exit(0);
