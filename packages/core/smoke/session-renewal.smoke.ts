/** Broker-free independent session credential renewal tests with accelerated clocks. */
import assert from "node:assert/strict";
import {
  CREDENTIAL_LIFETIMES,
  EpEnvelopeError,
  MESH_RELEASE_RENEWAL_OPERATOR_COPY,
  blockedMeshReleaseResponse,
  classifySessionCredentialForRelease,
  createSessionRenewalRequest,
  createSpaceAuth,
  credsClaims,
  identityFromCreds,
  issueSessionRenewalCapability,
  materializeRenewedSessionCreds,
  mintLifecycleUid,
  mintRenewableSessionAgentJwt,
  newIdentity,
  renewIndependentSessionCredential,
  type ResourceKey,
  type SessionRenewalCapability,
  type SessionRenewalRequest,
} from "../src/index.js";

let pass = 0, fail = 0;
async function cell(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ FAIL: ${name}`, e); }
}
async function rejects(name: string, fn: () => unknown | Promise<unknown>, re: RegExp, code?: string) {
  await cell(name, async () => {
    let error: unknown;
    try { await fn(); } catch (e) { error = e; }
    assert.ok(error instanceof Error, "expected refusal");
    assert.match(error.message, re);
    if (code !== undefined) assert.equal(error instanceof EpEnvelopeError ? error.code : undefined, code);
  });
}

const owner = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const actor = "native_session";
const uid = mintLifecycleUid();
const resourceKey: ResourceKey = {
  hostIdentity: "host-1", provider: "com.cotal.claude", nativeOwnerNamespace: "uid:1000",
  stableSessionId: "session-1", resourceGeneration: "created-1",
};
const identity = newIdentity();
const auth = await createSpaceAuth("renewal-test");
const authority = {
  allowSubscribe: ["general", "team.>"],
  allowPublish: ["general"],
  capabilities: ["spawn"],
  role: "writer",
};
const capability = issueSessionRenewalCapability({
  authenticatedOwner: owner,
  capabilityId: `cap${mintLifecycleUid()}`,
  space: auth.space,
  resourceKey,
  owner,
  actor,
  lifecycleUid: uid,
  publicId: identity.id,
  ceiling: authority,
  credentialTtlSeconds: 2,
  issuedAt: 1_000,
  expiresAt: 100_000,
});
const consumed = new Set<string>();
const renewAt = (now: number, request: SessionRenewalRequest, cap: SessionRenewalCapability = capability, current = authority) =>
  renewIndependentSessionCredential({
    request,
    signingAuth: auth,
    resolveCapability: () => cap,
    resolveCurrentAuthority: () => current,
    consumeRequestId: (_cap, id) => !consumed.has(id) && (consumed.add(id), true),
    now: () => now,
  });

console.log("A. closed owner-authorized capability");
await cell("session-agent is auth-service renewable without changing generic agent/profile minting", () => {
  assert.deepEqual(CREDENTIAL_LIFETIMES["session-agent"], {
    class: "standing-renewable", defaultTtlSeconds: 86_400, renewalOwner: "auth-service",
    note: CREDENTIAL_LIFETIMES["session-agent"].note,
  });
  assert.equal(Object.isFrozen(CREDENTIAL_LIFETIMES["session-agent"]), true);
  assert.equal(Object.isFrozen(CREDENTIAL_LIFETIMES), true);
});
await rejects("capability owner must be the authenticated resource owner", () => issueSessionRenewalCapability({
  authenticatedOwner: "u_bbbbbbbbbbbbbbbbbbbbbbbbbb", capabilityId: `cap${mintLifecycleUid()}`, space: auth.space,
  resourceKey, owner, actor, lifecycleUid: uid, publicId: identity.id, ceiling: authority, issuedAt: 1_000, expiresAt: 2_000,
}), /authenticated resource owner/, "permission-denied");
await rejects("supervise is never admitted as renewal authority", () => issueSessionRenewalCapability({
  authenticatedOwner: owner, capabilityId: `cap${mintLifecycleUid()}`, space: auth.space, resourceKey,
  owner, actor, lifecycleUid: uid, publicId: identity.id, ceiling: { ...authority, capabilities: ["supervise"] }, issuedAt: 1_000, expiresAt: 2_000,
}), /must never include supervise/, "permission-denied");
await rejects("closed capability parser refuses profile-like extension fields", async () => {
  const request = createSessionRenewalRequest(identity, {
    capabilityId: capability.capabilityId, space: auth.space, resourceKey, owner, actor, lifecycleUid: uid,
    requestId: `req${mintLifecycleUid()}`, requestedAt: 2_000,
  });
  await renewIndependentSessionCredential({
    request, signingAuth: auth, resolveCapability: () => ({ ...capability, profile: "agent" }),
    resolveCurrentAuthority: () => authority, consumeRequestId: () => true, now: () => 2_000,
  });
}, /unknown field "profile"/);

console.log("B. two accelerated renewals preserve nkey, lifecycle and current ACL ceiling");
let creds = materializeRenewedSessionCreds(await mintMaterialAt(2_000), identity);
const first = credsClaims(creds);
await cell("first accelerated renewal returns a bounded same-nkey session-agent credential", () => {
  assert.equal(identityFromCreds(creds).id, identity.id);
  assert.equal(first.name, "session-agent");
  assert.equal(first.exp, 4);
  assert.equal(first.nats?.pub?.allow?.some((row) => row.includes("general")), true);
  assert.equal(first.nats?.pub?.allow?.some((row) => row.includes("secret")), false);
});
creds = materializeRenewedSessionCreds(await mintMaterialAt(4_000), identity);
const second = credsClaims(creds);
await cell("second accelerated renewal advances expiry while preserving the same local proof identity", () => {
  assert.equal(identityFromCreds(creds).id, identity.id);
  assert.equal(second.exp, 6);
  assert.ok((second.exp ?? 0) > (first.exp ?? 0));
});
await rejects("a replayed renewal request cannot mint a second generation", async () => {
  const request = createSessionRenewalRequest(identity, {
    capabilityId: capability.capabilityId, space: auth.space, resourceKey, owner, actor, lifecycleUid: uid,
    requestId: `req${mintLifecycleUid()}`, requestedAt: 6_000,
  });
  await renewAt(6_000, request);
  await renewAt(6_000, request);
}, /already consumed/, "permission-denied");
await rejects("holder proof is bound to the lifecycle's existing nkey", async () => {
  const wrong = newIdentity();
  const request = createSessionRenewalRequest(wrong, {
    capabilityId: capability.capabilityId, space: auth.space, resourceKey, owner, actor, lifecycleUid: uid,
    requestId: `req${mintLifecycleUid()}`, requestedAt: 7_000,
  });
  await renewAt(7_000, { ...request, publicId: identity.id });
}, /holder proof does not verify/, "permission-denied");
await rejects("fresh current ACL cannot exceed the owner-authorized ceiling", async () => {
  const request = createSessionRenewalRequest(identity, {
    capabilityId: capability.capabilityId, space: auth.space, resourceKey, owner, actor, lifecycleUid: uid,
    requestId: `req${mintLifecycleUid()}`, requestedAt: 8_000,
  });
  await renewAt(8_000, request, capability, { ...authority, allowSubscribe: ["general", "secret"] });
}, /exceeds the owner-authorized ceiling \(secret\)/, "permission-denied");

console.log("C. exhaustive release classification and mandated operator response");
await cell("independent session family is release-ready and manager infrastructure is excluded", () => {
  assert.equal(classifySessionCredentialForRelease("session-agent").status, "independently-renewable");
  for (const family of ["supervisor", "delivery", "membership-rw", "endpoint-serve", "goal-writer", "session-ledger", "run-driver", "run-mediator"] as const)
    assert.equal(classifySessionCredentialForRelease(family).status, "not-session-identity", family);
});
await cell("legacy static and mixed session identity families remain named release blockers", () => {
  for (const family of ["agent", "observer", "admin", "channel-purger", "teardown", "deployer"] as const) {
    const result = classifySessionCredentialForRelease(family);
    assert.equal(result.status, "release-blocker", family);
    assert.ok(result.renewalOwner.length > 0, family);
  }
});
await cell("blocked response carries verbatim operator copy, family, owner, wait and separate leave only", () => {
  const blocked = blockedMeshReleaseResponse("agent");
  assert.equal(blocked.credentialFamily, "agent");
  assert.equal(blocked.renewalOwner, "none (legacy mixed/static)");
  assert.ok(blocked.message.startsWith(MESH_RELEASE_RENEWAL_OPERATOR_COPY));
  assert.deepEqual(blocked.options, ["wait-for-independent-renewal", "separately-authorize-mesh-leave"]);
  assert.match(blocked.message, /Mesh leave is never automatic/);
});
await rejects("a release-ready family cannot be rendered as blocked", () => blockedMeshReleaseResponse("session-agent"), /not a release blocker/);
await rejects("generic public-JWT mint refuses agent/session-agent profile strings", () => mintRenewableSessionAgentJwt(auth, identity.id, {
  principal: { owner, actor }, lifecycleUid: uid, allowSubscribe: [], allowPublish: [], capabilities: ["supervise"], expiresInSeconds: 2,
}), /supervise is forbidden/);

async function mintMaterialAt(now: number) {
  const request = createSessionRenewalRequest(identity, {
    capabilityId: capability.capabilityId, space: auth.space, resourceKey, owner, actor, lifecycleUid: uid,
    requestId: `req${mintLifecycleUid()}`, requestedAt: now,
  });
  return renewAt(now, request);
}

console.log(`\nsession-renewal: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
