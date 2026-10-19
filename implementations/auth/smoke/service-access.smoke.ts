import assert from "node:assert/strict";
import { createAccount } from "@nats-io/nkeys";
import { decodeJwt, decodeProtectedHeader, SignJWT } from "jose";
import { contractDigest, serviceEndpointActor, type ServiceRegistrationWitness } from "@cotal-ai/core";
import { createUserTokenIssuer, generateSigningKey } from "../src/issuer.js";
import { PUBLIC_EXCHANGE_VIEWS, validateUserToken } from "../src/token.js";
import { createIdpBridge } from "../src/idp.js";
import { calloutPermissions } from "../src/permissions.js";
import { profileFixtures } from "./prototypes/issued-profile-census.js";
import { validateServiceRenewalProof } from "../src/service-renewal.js";

const identity = { accountPublicKey: createAccount().getPublicKey(), space: "service-access", owner: `u_${"a".repeat(26)}`,
  endpoint: "org.example.orders", instanceId: "i".repeat(32) };
const { owner, ...coordinates } = identity;
const witness: ServiceRegistrationWitness = { ...coordinates, principal: { owner, actor: serviceEndpointActor(identity), lifecycleUid: "l".repeat(32) },
  rootCredentialId: "r".repeat(32), approvalDigest: contractDigest({ approval: 1 }), processEpoch: 1, registrationRevision: 2,
  nameAuthorityRevision: 1, registrationRequestId: "a".repeat(32), registrationProof: contractDigest({ completed: 1 }) };
const key = await generateSigningKey(), issuer = createUserTokenIssuer({ issuer: "https://authority.example/service-access", key });
const now = Math.floor(Date.now() / 1000), expiresAt = now + 45;
const bearer = await issuer.issueServiceAccess({ witness, expiresAt });
const options = { issuer: issuer.issuer, key: issuer.localKeySet(), audience: witness.space };
const token = await validateUserToken(bearer, options);
assert.equal(token.exp, expiresAt);
assert.deepEqual(token.act.service, { duty: "serve", witness });
assert.deepEqual(token.scope, []);
assert.deepEqual(token.act.scope, []);
assert.equal(token.act.lifecycleUid, witness.principal.lifecycleUid);
assert.equal(token.credentialId, witness.rootCredentialId);
await assert.rejects(validateServiceRenewalProof(bearer, { issuer: issuer.issuer, key: issuer.localKeySet(), witness }));
assert.equal((PUBLIC_EXCHANGE_VIEWS as readonly string[]).includes("service-endpoint"), false);
await assert.rejects(issuer.issue({ owner, actor: witness.principal.actor, space: witness.space, view: "service-endpoint" }), /dedicated service authority/);
await assert.rejects(issuer.issueServiceAccess({ witness, expiresAt: now }));
await assert.rejects(issuer.issueServiceAccess({ witness, expiresAt: now + 70 }));
let ordinaryReads = 0;
const permissions = calloutPermissions(() => { ordinaryReads++; throw new Error("ordinary ACL must not run"); });
assert.throws(() => permissions(token, "n".repeat(32)), /native service authorization/);
const bridge = createIdpBridge({ space: witness.space, spaceSecret: "x".repeat(32), issuer,
  idp: { issuer: issuer.issuer, audience: witness.space, key: issuer.localKeySet() },
  authorizeActor: () => { ordinaryReads++; throw new Error("ordinary ledger must not run"); },
  mintConnectCredential: async () => { ordinaryReads++; throw new Error("ordinary root mint must not run"); },
});
await assert.rejects(bridge.exchange("not-an-idp-proof", { actor: witness.principal.actor, view: "service-endpoint" }), /dedicated service authority/);
assert.equal(ordinaryReads, 0);
const claims = decodeJwt(bearer), act = claims.act as Record<string, unknown>;
const signed = (payload: Record<string, unknown>, header: Record<string, unknown> = {}) => new SignJWT(payload)
  .setProtectedHeader({ alg: "EdDSA", kid: key.kid, ...header }).sign(key.privateKey);
for (const bad of [
  { ...claims, scope: ["admin"] }, { ...claims, extra: true }, { ...claims, aud: [witness.space] },
  { ...claims, exp: now - 1, iat: now - 45, nbf: now - 45 }, { ...claims, exp: now + 70 },
  { ...claims, exp: expiresAt + 0.5 }, { ...claims, nbf: now - 1 },
  ...["parent", "managerInstanceId", "session", "transferWriter", "extra"].map((k) => ({ ...claims, act: { ...act, [k]: "unsupported" } })),
  ...[{ scope: ["admin"] }, { actor: "other" }, { lifecycleUid: "s".repeat(32) }, { credentialId: "s".repeat(32) },
    { view: "admin" }, { service: { duty: "invoke", witness } }, { service: { duty: "serve", witness, extra: true } },
    { service: undefined }, { service: { duty: "serve", witness: { ...witness, space: "other" } } }]
    .map((change) => ({ ...claims, act: { ...act, ...change } })),
]) await assert.rejects(validateUserToken(await signed(bad), options));
await assert.rejects(validateUserToken(await signed(claims, { typ: "unexpected" }), options));
const next = await generateSigningKey(); issuer.rotate(next);
const successor = await issuer.issueServiceAccess({ witness, expiresAt });
assert.equal(decodeProtectedHeader(successor).kid, next.kid);
await validateUserToken(bearer, options); issuer.retire(key.kid);
await assert.rejects(validateUserToken(bearer, options)); await validateUserToken(successor, options);
assert.ok((await profileFixtures("service-access-census")).length > 0, "ordinary profile census still builds and refuses service view");
console.log("service access: closed witness-bound claims, fixed expiry, rotation and ordinary-path refusal passed; native host authorization remains separate");
