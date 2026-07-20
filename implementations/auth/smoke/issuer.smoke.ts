/**
 * Plane-1 issuer smoke (broker-free) — proves the user-bearer ISSUER and the strict validator agree
 * end-to-end (plan §"Plane 1"), and pins rotation + JWKS hygiene + the mint-side cap.
 *
 * The load-bearing check: every token this issuer mints MUST pass {@link validateUserToken} (issuer
 * ↔ validator are inverses). Plus: kid-driven rotation (sign newest, verify any live kid, retired
 * kid stops verifying), JWKS never leaks `d`, mint refuses an overlong TTL / bad owner / bad parent,
 * and the pinned resolver rejects a non-https non-loopback origin.
 * Run: pnpm smoke:auth-issuer
 */
import { SignJWT, decodeProtectedHeader } from "jose";
import { assertDerivedOwnerToken } from "@cotal-ai/core";
import {
  MAX_TOKEN_TTL_SEC,
  USER_TOKEN_ALG,
  USER_TOKEN_VER,
  createUserTokenIssuer,
  deriveOwnerToken,
  exportSigningKey,
  generateSigningKey,
  importSigningKey,
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

const ISS = "https://auth.cotal.test";
const SPACE = "demo";
const owner = deriveOwnerToken("s".repeat(32), "better-auth|human-42");

const key1 = await generateSigningKey();
const issuer = createUserTokenIssuer({ issuer: ISS, key: key1 });
// The verifier the callout would use — the issuer's own live key set (validateUserToken's key path).
const V = { key: issuer.localKeySet(), issuer: ISS, audience: SPACE };

// ---- issuer ↔ validator round-trip (the loop) ----
const t1 = await issuer.issue({ owner, space: SPACE, actor: "agent_1", scope: ["chat"] });
const v1 = await validateUserToken(t1, V);
check("minted bearer validates; owner/space/actor/scope/ver round out",
  v1.owner === owner && v1.space === SPACE && v1.act.actor === "agent_1" && v1.scope.join() === "chat" && v1.ver === USER_TOKEN_VER);
check("minted header pins alg=EdDSA and carries a kid", (() => {
  const h = decodeProtectedHeader(t1);
  return h.alg === USER_TOKEN_ALG && h.kid === issuer.activeKid() && h.kid === key1.kid;
})());
{
  const tp = await issuer.issue({ owner, space: SPACE, actor: "agent_2", parent: `${owner}.spawner_1` });
  const vp = await validateUserToken(tp, V);
  check("parent audit link round-trips as a principal", vp.act.parent === `${owner}.spawner_1`);
}

// ---- rotation ----
const key2 = await generateSigningKey();
issuer.rotate(key2);
check("rotate makes the new kid active", issuer.activeKid() === key2.kid && key2.kid !== key1.kid);
check("JWKS publishes BOTH kids after rotate", (() => {
  const kids = issuer.jwks().keys.map((k) => k.kid);
  return kids.includes(key1.kid) && kids.includes(key2.kid) && kids.length === 2;
})());
const t2 = await issuer.issue({ owner, space: SPACE, actor: "agent_1" });
check("new-key token validates", (await validateUserToken(t2, V)).act.actor === "agent_1");
check("old-key token still validates while its kid is published", (await validateUserToken(t1, V)).owner === owner);
issuer.retire(key1.kid);
check("retire drops the old kid from the JWKS", !issuer.jwks().keys.some((k) => k.kid === key1.kid));
await rejects("a token signed by a retired kid no longer verifies", () => validateUserToken(t1, V), "kid");
await rejects("retiring the ACTIVE kid is refused", () => Promise.resolve(issuer.retire(key2.kid)), "active");

// ---- JWKS hygiene: public members only, well-formed ----
check("JWKS leaks no private material and is well-formed", issuer.jwks().keys.every((k) =>
  (k as Record<string, unknown>).d === undefined && k.kty === "OKP" && k.crv === "Ed25519" && k.use === "sig" && k.alg === USER_TOKEN_ALG && typeof k.kid === "string"));

// ---- persistence round-trip ----
{
  const ser = await exportSigningKey(key2);
  const restored = await importSigningKey(ser);
  check("exported/imported signing key keeps its kid", restored.kid === key2.kid);
  const issuer2 = createUserTokenIssuer({ issuer: ISS, key: restored });
  const tr = await issuer2.issue({ owner, space: SPACE, actor: "agent_1" });
  check("a token from the restored key validates against the restored key set",
    (await validateUserToken(tr, { key: issuer2.localKeySet(), issuer: ISS, audience: SPACE })).owner === owner);
  await rejects("import rejects a kid-tampered blob", () => importSigningKey({ ...ser, kid: "sha256:bogus" }), "mismatch");
}

// ---- mint-side fail-loud ----
await rejects("overlong TTL is refused at mint (the cap is enforced both sides)",
  () => issuer.issue({ owner, space: SPACE, actor: "agent_1", ttlSec: MAX_TOKEN_TTL_SEC + 1 }), "cap");
await rejects("zero/negative TTL refused", () => issuer.issue({ owner, space: SPACE, actor: "agent_1", ttlSec: 0 }), "range");
await rejects("a raw nkey owner is refused at mint",
  () => issuer.issue({ owner: "UDOE2PE4P2EC4MBDNHSUYHIXF3FUWZMHLD6O7IA727W5UWW7RA7HIUB5", space: SPACE, actor: "agent_1" }));
await rejects("a dotted actor is refused at mint", () => issuer.issue({ owner, space: SPACE, actor: "a.b" }));
await rejects("a non-principal parent is refused at mint", () => issuer.issue({ owner, space: SPACE, actor: "agent_1", parent: "nope" }), "principal");
await rejects("a missing space is refused at mint", () => issuer.issue({ owner, space: "", actor: "agent_1" }), "space");
// Untyped-caller matrix: TS types don't guard a JSON/IdP boundary — every mis-shaped claim must
// fail at MINT, never sign a bearer the validator would reject (the inverse holds at runtime).
await rejects("a non-string actor is refused at mint (RegExp.test coercion closed)",
  () => issuer.issue({ owner, space: SPACE, actor: 123 as unknown as string }));
await rejects("a non-string owner is refused at mint",
  () => issuer.issue({ owner: 123 as unknown as string, space: SPACE, actor: "agent_1" }));
await rejects("a scope with a non-string entry is refused at mint",
  () => issuer.issue({ owner, space: SPACE, actor: "agent_1", scope: ["ok", 123] as unknown as string[] }), "scope");
await rejects("a non-array scope is refused at mint",
  () => issuer.issue({ owner, space: SPACE, actor: "agent_1", scope: "chat" as unknown as string[] }), "scope");
await rejects("a non-string parent is refused at mint",
  () => issuer.issue({ owner, space: SPACE, actor: "agent_1", parent: 123 as unknown as string }), "parent");
await rejects("a non-numeric ttl is refused at mint",
  () => issuer.issue({ owner, space: SPACE, actor: "agent_1", ttlSec: "5" as unknown as number }), "range");
await rejects("a non-string space is refused at mint",
  () => issuer.issue({ owner, space: 123 as unknown as string, actor: "agent_1" }), "space");
check("issued owner is a well-formed derived token", assertDerivedOwnerToken(v1.owner) === v1.owner);

// ---- credential-ledger claim (R1 deny-new): mint ↔ validate inverse on `act.credentialId` ----
{
  const tc = await issuer.issue({ owner, space: SPACE, actor: "agent_1", credentialId: "root0001" });
  const vc = await validateUserToken(tc, V);
  check("a credentialId claim round-trips through issue ↔ validate (both act + hoisted)",
    vc.act.credentialId === "root0001" && vc.credentialId === "root0001");
  const tnone = await issuer.issue({ owner, space: SPACE, actor: "agent_1" });
  check("a bearer without a credentialId validates with the claim absent (pre-cut path)",
    (await validateUserToken(tnone, V)).credentialId === undefined);
  const tdot = await issuer.issue({ owner, space: SPACE, actor: "agent_1", credentialId: "sess_9a.c" });
  check("a dotted credentialId (the session `<sid>.c` shape) round-trips",
    (await validateUserToken(tdot, V)).credentialId === "sess_9a.c");
  // Mint-side inverse: a garbled credid must fail at MINT, never sign a bearer the validator rejects.
  await rejects("a credentialId with a wildcard is refused at mint", () => issuer.issue({ owner, space: SPACE, actor: "agent_1", credentialId: "root.*" }), "credentialId");
  await rejects("an empty-segment credentialId is refused at mint", () => issuer.issue({ owner, space: SPACE, actor: "agent_1", credentialId: "a..b" }), "credentialId");
  await rejects("a non-string credentialId is refused at mint", () => issuer.issue({ owner, space: SPACE, actor: "agent_1", credentialId: 7 as unknown as string }), "credentialId");
  // Validate-side: a raw bearer forged with a garbled credid (bypassing the mint assert) is refused.
  const now = Math.floor(Date.now() / 1000);
  const forged = await new SignJWT({ scope: [], ver: USER_TOKEN_VER, act: { owner, actor: "agent_1", credentialId: "bad/seg" } })
    .setProtectedHeader({ alg: USER_TOKEN_ALG, kid: key2.kid })
    .setSubject(owner).setIssuer(ISS).setAudience(SPACE)
    .setIssuedAt(now).setNotBefore(now).setExpirationTime(now + 60)
    .sign(key2.privateKey);
  await rejects("a bearer carrying a KV-unsafe credentialId is rejected at validation", () => validateUserToken(forged, V), "credentialId");
}

// ---- exact-audience: a multi-aud bearer signed by the REAL active key must still be rejected ----
{
  const t = Math.floor(Date.now() / 1000);
  const multiAud = await new SignJWT({ scope: [], ver: USER_TOKEN_VER, act: { owner, actor: "agent_1" } })
    .setProtectedHeader({ alg: USER_TOKEN_ALG, kid: key2.kid })
    .setSubject(owner).setIssuer(ISS).setAudience([SPACE, "other-space"])
    .setIssuedAt(t).setNotBefore(t).setExpirationTime(t + 60)
    .sign(key2.privateKey);
  await rejects("a multi-audience bearer is rejected — aud must be exactly the space, not contain it",
    () => validateUserToken(multiAud, V), "aud");
}

// ---- pinned JWKS resolver origin guard ----
check("pinned resolver accepts https", !!pinnedJwksResolver("https://auth.cotal.test/.well-known/jwks.json"));
check("pinned resolver accepts loopback http (dev)", !!pinnedJwksResolver("http://127.0.0.1:4599/jwks"));
try { pinnedJwksResolver("http://auth.cotal.test/jwks"); check("pinned resolver rejects non-loopback http", false); }
catch { check("pinned resolver rejects non-loopback http", true); }

console.log(`\nissuer smoke: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
