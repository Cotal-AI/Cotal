/** Accelerated connector-owned independent session renewal loop tests. */
import assert from "node:assert/strict";
import {
  createSpaceAuth,
  credsClaims,
  issueSessionRenewalCapability,
  mintLifecycleUid,
  mintRenewableSessionAgentJwt,
  newIdentity,
  renewIndependentSessionCredential,
  type ResourceKey,
  type SessionRenewalRequest,
} from "@cotal-ai/core";
import { startIndependentSessionRenewal } from "../src/renewal.js";

let pass = 0, fail = 0;
async function cell(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ FAIL: ${name}`, e); }
}

const auth = await createSpaceAuth("workspace-renewal");
const base = Math.floor(Date.now() / 1000) * 1000;
const baseSec = base / 1000;
const owner = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const actor = "native_session";
const lifecycleUid = mintLifecycleUid();
const identity = newIdentity();
const resourceKey: ResourceKey = {
  hostIdentity: "host-1", provider: "com.cotal.claude", nativeOwnerNamespace: "uid:1000",
  stableSessionId: "session-1", resourceGeneration: "created-1",
};
const authority = { allowSubscribe: ["general"], allowPublish: ["general"], capabilities: [] };
const capability = issueSessionRenewalCapability({
  authenticatedOwner: owner, capabilityId: `cap${mintLifecycleUid()}`, space: auth.space,
  resourceKey, owner, actor, lifecycleUid, publicId: identity.id, ceiling: authority,
  credentialTtlSeconds: 4, issuedAt: base, expiresAt: base + 100_000,
});
const initialJwt = await mintRenewableSessionAgentJwt(auth, identity.id, {
  principal: { owner, actor }, lifecycleUid, ...authority, expiresAt: baseSec + 4,
});
const { credsFromJwt } = await import("@cotal-ai/core");
const initialCreds = credsFromJwt(initialJwt.jwt, identity);

console.log("A. connector performs two renewals over its own exchange and connection seams");
await cell("two accelerated renewals connect and adopt before replacing current credentials", async () => {
  let now = base + 3_000;
  const consumed = new Set<string>();
  let renewals = 0;
  const connected: number[] = [];
  const adopted: number[] = [];
  const controller = new AbortController();
  const loop = startIndependentSessionRenewal({
    initialCreds,
    capabilityId: capability.capabilityId,
    space: auth.space,
    resourceKey,
    owner,
    actor,
    lifecycleUid,
    now: () => now,
    sleep: async (ms) => { now += Math.max(1, ms); },
    requestId: () => `req${mintLifecycleUid()}`,
    renew: async (request: SessionRenewalRequest) => {
      renewals++;
      const result = await renewIndependentSessionCredential({
        request, signingAuth: auth, resolveCapability: () => capability,
        resolveCurrentAuthority: () => authority,
        consumeRequestId: (_cap, id) => !consumed.has(id) && (consumed.add(id), true),
        now: () => now,
      });
      if (renewals === 2) controller.abort();
      return result;
    },
    connect: async (creds) => {
      const exp = credsClaims(creds).exp!;
      connected.push(exp);
      return { exp };
    },
    adopt: async (connection) => { adopted.push(connection.exp); },
    signal: controller.signal,
  });
  await loop.done;
  assert.equal(renewals, 2);
  assert.equal(connected.length, 2);
  assert.ok(connected[0]! > baseSec + 4);
  assert.ok(connected[1]! > connected[0]!);
  assert.deepEqual(adopted, connected);
  assert.equal(credsClaims(loop.currentCreds()).exp, connected[1]);
});

console.log("B. no silent degradation on renewal or adoption failure");
await cell("auth-service refusal rejects the loop and leaves the last adopted generation intact", async () => {
  let now = base + 3_000;
  const loop = startIndependentSessionRenewal({
    initialCreds, capabilityId: capability.capabilityId, space: auth.space, resourceKey, owner, actor, lifecycleUid,
    now: () => now, sleep: async (ms) => { now += Math.max(1, ms); }, requestId: () => `req${mintLifecycleUid()}`,
    renew: async () => { throw new Error("auth-service refused renewal"); },
    connect: async () => ({ ok: true }), adopt: async () => {},
  });
  await assert.rejects(loop.done, /auth-service refused renewal/);
  assert.equal(loop.currentCreds(), initialCreds);
});
await cell("candidate connect/adopt failure is loud, closes candidate, and preserves current creds", async () => {
  let now = base + 3_000;
  let closed = 0;
  const consumed = new Set<string>();
  const loop = startIndependentSessionRenewal({
    initialCreds, capabilityId: capability.capabilityId, space: auth.space, resourceKey, owner, actor, lifecycleUid,
    now: () => now, sleep: async (ms) => { now += Math.max(1, ms); }, requestId: () => `req${mintLifecycleUid()}`,
    renew: (request) => renewIndependentSessionCredential({
      request, signingAuth: auth, resolveCapability: () => capability, resolveCurrentAuthority: () => authority,
      consumeRequestId: (_cap, id) => !consumed.has(id) && (consumed.add(id), true), now: () => now,
    }),
    connect: async () => ({ generation: "candidate" }),
    adopt: async () => { throw new Error("candidate adoption refused"); },
    closeCandidate: async () => { closed++; },
  });
  await assert.rejects(loop.done, /candidate adoption refused/);
  assert.equal(closed, 1);
  assert.equal(loop.currentCreds(), initialCreds);
});

console.log(`\nworkspace-session-renewal: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
