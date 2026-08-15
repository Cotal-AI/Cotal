/**
 * m7 defect-2 isolation — NO BROKER, NO NATS, NO CONNECTOR.
 *
 * `m7-usermode` fails `U0` with `auth callout: denied …: signature verification failed` for a
 * bearer signed by the key the callout was pinned to. Two places can produce that: the FIXTURE
 * (the token it mints is not verifiable by the key it hands over) or the PLUMBING (the bearer that
 * reaches `validateUserToken` is not the bearer the fixture wrote).
 *
 * This probe exercises ONLY the first. It mints the byte-identical token m7 mints — same claims,
 * same `signBearer` body — and calls `validateUserToken` directly.
 *
 * REFUTATION, STATED BEFORE THE RESULT:
 *  - A1 RIGHT-KEY passes  → the fixture's token/key pair is sound, so defect 2 is in the PLUMBING
 *    (what reaches the callout), and this file exonerates the fixture.
 *  - A1 RIGHT-KEY fails with `signature verification failed` → the defect is IN THE FIXTURE and
 *    reproduces with no broker at all.
 *  - A2 WRONG-KEY is the inverse control: it MUST fail, and MUST fail with that same string. If it
 *    passes, the validator is not verifying and nothing here means anything. If A1 and A2 fail
 *    identically for a reason that is not the signature (shape, iss, aud, ttl), the arms did not
 *    differ and the run is VOID rather than informative — asserted, not assumed.
 */
import { randomUUID } from "node:crypto";
import { generateKeyPair, SignJWT } from "jose";
import type { CryptoKey } from "jose";
import { deriveOwnerToken } from "./src/index.js";
import { validateUserToken, USER_TOKEN_VER } from "./src/token.js";
import { mintLifecycleUid } from "@cotal-ai/core";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `m7d2-${randomUUID().slice(0, 8)}`;
const uid = mintLifecycleUid();
const ISS = "https://auth.cotal.test";
const OWNER = deriveOwnerToken("s".repeat(32), "better-auth|human-1");
const ACTOR = "agentone";

const { publicKey, privateKey } = await generateKeyPair("EdDSA");
const wrong = await generateKeyPair("EdDSA");

// Byte-identical to m7's `signBearer`.
const signBearer = async (key: CryptoKey): Promise<string> => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: OWNER, ver: USER_TOKEN_VER, act: { owner: OWNER, actor: ACTOR, scope: [], lifecycleUid: uid } })
    .setProtectedHeader({ alg: "EdDSA" }).setIssuer(ISS).setAudience(space).setSubject(OWNER)
    .setIssuedAt(now - 60).setNotBefore(now - 60).setExpirationTime(now + 780)
    .sign(key);
};

const good = await signBearer(privateKey as CryptoKey);
const bad = await signBearer(wrong.privateKey as CryptoKey);

const attempt = async (token: string) => {
  try {
    const v = await validateUserToken(token, { key: publicKey as never, issuer: ISS, audience: space });
    return { ok: true as const, v };
  } catch (e) {
    return { ok: false as const, msg: (e as Error).message };
  }
};

console.log(`[m7d2] no broker, no network. space=${space}`);
const a1 = await attempt(good);
const a2 = await attempt(bad);

console.log(`  A1 RIGHT-KEY : ${a1.ok ? "ACCEPTED" : `REFUSED — ${a1.msg}`}`);
console.log(`  A2 WRONG-KEY : ${a2.ok ? "ACCEPTED" : `REFUSED — ${a2.msg}`}`);

check("A2 CONTROL: a bearer signed by the WRONG key is refused (the validator verifies at all)", !a2.ok, a2);
check("A2 CONTROL: and it is refused for the SIGNATURE, not for shape/iss/aud/ttl",
  !a2.ok && /signature verification failed/i.test(a2.msg ?? ""), a2);
check("A1 the RIGHT key verifies the fixture's own token", a1.ok, a1);

if (!a1.ok && /signature verification failed/i.test(a1.msg ?? "")) {
  console.log("\n>>> DEFECT 2 REPRODUCES WITHOUT A BROKER: the fixture's token/key pair does not verify.");
} else if (a1.ok) {
  console.log("\n>>> FIXTURE EXONERATED: the token/key pair verifies here, so defect 2 is in what REACHES the callout.");
}

console.log(`\nM7D2 ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
