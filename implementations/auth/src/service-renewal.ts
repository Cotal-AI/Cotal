import { SignJWT, decodeProtectedHeader, jwtVerify, type CryptoKey, type JWTVerifyGetKey } from "jose";
import {
  SERVICE_RENEWAL_TTL_SECONDS, parseServiceRegistrationWitness, serviceWitnessDigest,
  type ServiceRegistrationWitness,
} from "@cotal-ai/core";
import type { SigningKey } from "./issuer.js";
import { CLOCK_TOLERANCE_SEC, SERVICE_RENEWAL_TYP } from "./token.js";
export { SERVICE_RENEWAL_TYP } from "./token.js";
export interface ServiceRenewalClaims {
  witness: ServiceRegistrationWitness;
  /** Fixed Unix-second deadline, already bounded by the host's root and approval checks. */
  expiresAt: number;
}
export interface ValidatedServiceRenewal {
  witness: ServiceRegistrationWitness;
  issuedAt: number;
  expiresAt: number;
}
const nowSeconds = () => Math.floor(Date.now() / 1000);
function invalid(): never { throw new Error("service renewal proof is invalid or does not bind this registration"); }

/** Trusted issuer primitive only. The host must establish current approval/root authority before signing. */
export async function issueServiceRenewalProof(key: SigningKey, issuer: string, claims: ServiceRenewalClaims): Promise<string> {
  const witness = parseServiceRegistrationWitness(claims.witness);
  const now = nowSeconds(), exp = claims.expiresAt;
  if (!issuer || !Number.isSafeInteger(exp) || exp <= now || exp > now + SERVICE_RENEWAL_TTL_SECONDS)
    throw new Error("service renewal proof requires a future fixed expiry within its lifetime cap");
  const proof = await new SignJWT({ ver: 1, kind: "service-renewal", witness, witnessDigest: serviceWitnessDigest(witness) })
    .setProtectedHeader({ alg: "EdDSA", kid: key.kid, typ: SERVICE_RENEWAL_TYP })
    .setIssuer(issuer).setAudience(witness.space).setSubject(witness.principal.owner)
    .setIssuedAt(now).setNotBefore(now).setExpirationTime(exp).sign(key.privateKey);
  if (exp <= nowSeconds()) throw new Error("service renewal proof expired before release; its fixed expiry is not extended");
  return proof;
}

/** Signature/registration validation only. Current native approval, root and operation eligibility remain host checks. */
export async function validateServiceRenewalProof(token: string, opts: {
  issuer: string; key: JWTVerifyGetKey | CryptoKey; witness: ServiceRegistrationWitness;
}): Promise<ValidatedServiceRenewal> {
  if (typeof token !== "string" || token.length > 64 * 1024) invalid();
  const expected = parseServiceRegistrationWitness(opts.witness);
  try {
    const header = decodeProtectedHeader(token);
    if (header.typ !== SERVICE_RENEWAL_TYP || header.alg !== "EdDSA" || typeof header.kid !== "string"
      || !header.kid || header.kid.length > 256 || Object.keys(header).some((k) => !["alg", "kid", "typ"].includes(k))) invalid();
    const { payload } = await jwtVerify(token, opts.key as JWTVerifyGetKey, {
      algorithms: ["EdDSA"], issuer: opts.issuer, audience: expected.space, clockTolerance: CLOCK_TOLERANCE_SEC,
    });
    const fields = ["iss", "aud", "sub", "iat", "nbf", "exp", "ver", "kind", "witness", "witnessDigest"];
    if (fields.some((k) => !Object.hasOwn(payload, k)) || Object.keys(payload).some((k) => !fields.includes(k))) invalid();
    const witness = parseServiceRegistrationWitness(payload.witness), now = nowSeconds();
    if (payload.ver !== 1 || payload.kind !== "service-renewal" || payload.aud !== expected.space
      || payload.sub !== witness.principal.owner || typeof payload.iat !== "number" || !Number.isSafeInteger(payload.iat)
      || typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp) || payload.nbf !== payload.iat
      || payload.iat < 0 || payload.iat > now + CLOCK_TOLERANCE_SEC || payload.exp <= now || payload.exp <= payload.iat
      || payload.exp - payload.iat > SERVICE_RENEWAL_TTL_SECONDS || payload.exp > now + SERVICE_RENEWAL_TTL_SECONDS + CLOCK_TOLERANCE_SEC
      || payload.witnessDigest !== serviceWitnessDigest(witness) || payload.witnessDigest !== serviceWitnessDigest(expected)) invalid();
    return { witness, issuedAt: payload.iat, expiresAt: payload.exp };
  } catch {
    return invalid();
  }
}
