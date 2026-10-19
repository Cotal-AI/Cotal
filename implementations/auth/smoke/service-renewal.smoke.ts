import assert from "node:assert/strict";
import { createAccount } from "@nats-io/nkeys";
import { decodeJwt, decodeProtectedHeader, SignJWT } from "jose";
import { contractDigest, serviceEndpointActor, SERVICE_RENEWAL_TTL_SECONDS, type ServiceRegistrationWitness } from "@cotal-ai/core";
import { createUserTokenIssuer, generateSigningKey } from "../src/issuer.js";
import { validateUserToken } from "../src/token.js";
import { SERVICE_RENEWAL_TYP, validateServiceRenewalProof } from "../src/service-renewal.js";

const identity = { accountPublicKey: createAccount().getPublicKey(), space: "service-renewal", owner: `u_${"a".repeat(26)}`,
  endpoint: "org.example.orders", instanceId: "i".repeat(32) };
const { owner, ...coordinates } = identity;
const witness: ServiceRegistrationWitness = { ...coordinates, principal: { owner, actor: serviceEndpointActor(identity), lifecycleUid: "l".repeat(32) },
  rootCredentialId: "r".repeat(32), approvalDigest: contractDigest({ approval: 1 }), processEpoch: 1, registrationRevision: 2,
  nameAuthorityRevision: 1, registrationRequestId: "a".repeat(32), registrationProof: contractDigest({ completed: 1 }) };
const key = await generateSigningKey(), issuer = createUserTokenIssuer({ issuer: "https://authority.example/service-renewal", key });
const expiresAt = Math.floor(Date.now() / 1000) + 60;
const proof = await issuer.issueServiceRenewal({ witness, expiresAt });
const options = { issuer: issuer.issuer, key: issuer.localKeySet(), witness };
assert.equal(decodeProtectedHeader(proof).typ, SERVICE_RENEWAL_TYP);
assert.equal((await validateServiceRenewalProof(proof, options)).expiresAt, expiresAt);
assert.equal(decodeJwt(proof).act, undefined, "renewal is not an actor/connect token");
await assert.rejects(validateUserToken(proof, { issuer: issuer.issuer, key: issuer.localKeySet(), audience: witness.space }));
for (const change of [{ processEpoch: 2 }, { registrationRevision: 3 }, { registrationRequestId: "b".repeat(32) },
  { registrationProof: contractDigest({ completed: 2 }) }, { rootCredentialId: "s".repeat(32) }])
  await assert.rejects(validateServiceRenewalProof(proof, { ...options, witness: { ...witness, ...change } }));
const bearer = await issuer.issue({ owner: identity.owner, actor: "cli", space: identity.space, ttlSec: 60 });
await assert.rejects(validateServiceRenewalProof(bearer, options));
await assert.rejects(issuer.issueServiceRenewal({ witness, expiresAt: Math.floor(Date.now() / 1000) + SERVICE_RENEWAL_TTL_SECONDS + 10 }));
await assert.rejects(issuer.issueServiceRenewal({ witness, expiresAt: Math.floor(Date.now() / 1000) }));
const claims = decodeJwt(proof), now = Math.floor(Date.now() / 1000);
const signed = (payload: Record<string, unknown>, extraHeader: Record<string, unknown> = {}) => new SignJWT(payload)
  .setProtectedHeader({ alg: "EdDSA", kid: key.kid, typ: SERVICE_RENEWAL_TYP, ...extraHeader }).sign(key.privateKey);
for (const bad of [
  { ...claims, exp: now - 1, iat: now - 60, nbf: now - 60 },
  { ...claims, exp: now + SERVICE_RENEWAL_TTL_SECONDS + 10 },
  { ...claims, act: { owner: identity.owner, actor: "cli" } },
  { ...claims, aud: [identity.space, "other"] },
  { ...claims, witnessDigest: contractDigest({ different: true }) },
]) await assert.rejects(validateServiceRenewalProof(await signed(bad), options));
await assert.rejects(validateServiceRenewalProof(await signed(claims, { jku: "https://untrusted.example/keys" }), options));
const wrongClass = await signed(decodeJwt(bearer));
await assert.rejects(validateUserToken(wrongClass, { issuer: issuer.issuer, key: issuer.localKeySet(), audience: witness.space }), /not a connect bearer/);
const next = await generateSigningKey(); issuer.rotate(next);
const successorProof = await issuer.issueServiceRenewal({ witness, expiresAt });
assert.equal(decodeProtectedHeader(successorProof).kid, next.kid);
await validateServiceRenewalProof(proof, options);
issuer.retire(key.kid);
await assert.rejects(validateServiceRenewalProof(proof, options));
await validateServiceRenewalProof(successorProof, options);
console.log("service renewal: registration binding, strict expiry, token-class separation and key rotation passed; native authorization remains separate");
