/** Closed remote retained-agent validation policy cells (broker-free). */
import assert from "node:assert/strict";
import { createSpaceAuth, mintLifecycleUid, newIdentity, remoteManagerActors, type RemoteRetainedAgentValidationRequest } from "@cotal-ai/core";
import { recordMesh, userAuthStateDir, workspaceSecretStore } from "@cotal-ai/workspace";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cotalAuthProvider, ensurePinnedIdp, grantActor, saveAuthServiceInfo, saveIdpSession } from "../src/index.js";
import { dispatchManagerAuthorityRequest } from "../src/service.js";
import { authorizeRemoteRetainedAgentValidation, completeRemoteRetainedAgentValidation, parseRemoteRetainedAgentValidationRequest, remoteManagerCurrentRegistrationProof } from "../src/retained-manager-validation.js";

let pass = 0;
let fail = 0;
async function cell(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (error) { fail++; console.log(`  ✗ FAIL: ${name}`, error); }
}
async function rejects(name: string, fn: () => unknown | Promise<unknown>, pattern: RegExp) {
  await cell(name, async () => {
    let error: unknown;
    try { await fn(); } catch (caught) { error = caught; }
    assert.ok(error instanceof Error, "expected a refusal");
    assert.match(error.message, pattern);
  });
}

const space = "demo";
const owner = `u_${"a".repeat(26)}`;
const otherOwner = `u_${"b".repeat(26)}`;
const instanceId = mintLifecycleUid();
const managerLifecycleUid = mintLifecycleUid();
const target = { owner, actor: "worker", lifecycleUid: mintLifecycleUid() };
const identities = {
  supervisor: { id: newIdentity().id },
  executor: { id: newIdentity().id },
  serve: { id: newIdentity().id },
  goalWriter: { id: newIdentity().id },
  sessionLedger: { id: newIdentity().id },
};
const current = { registrationRevision: 11, processEpoch: 7 };
const proofSecret = "host-account-secret";
const registrationProof = remoteManagerCurrentRegistrationProof(proofSecret, owner, {
  space, actor: "cli", instanceId, managerLifecycleUid, identities,
}, current);
const request: RemoteRetainedAgentValidationRequest = {
  v: 1,
  kind: "manager-retained-agent-validation",
  space,
  actor: "cli",
  instanceId,
  managerLifecycleUid,
  requestId: `req${mintLifecycleUid()}`,
  registrationProof,
  serveEpoch: 7,
  identities,
  target,
  actorToken: "actor-secret",
  sentinelCreds: "sentinel-secret",
};
const authority = {
  ...target,
  scope: ["role:worker"],
  allowSubscribe: ["general"],
  allowPublish: ["general"],
  role: "worker",
  parent: `${owner}.cli`,
};
const resultForClient = (
  candidate: RemoteRetainedAgentValidationRequest,
  candidateOwner: string,
  candidateAuthority: typeof authority,
) => ({
  v: 1 as const,
  kind: "manager-retained-agent-validation" as const,
  space: candidate.space,
  owner: candidateOwner,
  actor: candidate.actor,
  instanceId: candidate.instanceId,
  managerLifecycleUid: candidate.managerLifecycleUid,
  requestId: candidate.requestId,
  registrationProof: candidate.registrationProof,
  serveEpoch: candidate.serveEpoch,
  target: candidate.target,
  authority: candidateAuthority,
});
const gate = { state: "open" as const, principal: `${owner}.${remoteManagerActors(instanceId).serve}`, ...current };
const run = (overrides: Partial<Parameters<typeof authorizeRemoteRetainedAgentValidation>[0]> = {}) => authorizeRemoteRetainedAgentValidation({
  request,
  space,
  owner,
  scope: ["supervise"],
  proofSecret,
  observeManagerGate: async () => gate,
  ...overrides,
});

await rejects("closed parser refuses unknown fields", () => parseRemoteRetainedAgentValidationRequest({ ...request, profile: "provisioner" }), /unknown field/);
await rejects("closed parser refuses extra target fields", () => parseRemoteRetainedAgentValidationRequest({ ...request, target: { ...target, profile: "admin" } }), /target must be exactly/);
await rejects("secret-bearing request is size bounded", () => parseRemoteRetainedAgentValidationRequest({ ...request, actorToken: "x".repeat(4097) }), /bounded wire size/);
await rejects("spawn without supervise cannot validate", () => run({ scope: ["spawn"] }), /scope "supervise"/);
await rejects("another owner cannot be targeted", () => run({ request: { ...request, target: { ...target, owner: otherOwner } } }), /authenticated owner/);
await rejects("another host space cannot be targeted", () => run({ request: { ...request, space: "other" } }), /not this host space/);
await rejects("a stale registration proof is refused", () => run({ request: { ...request, registrationProof: `sha256:${"f".repeat(64)}` } }), /current host registration/);
await rejects("a superseded registration revision is refused", () => run({ observeManagerGate: async () => ({ ...gate, registrationRevision: 12 }) }), /current host registration/);
await rejects("a missing current gate is refused", () => run({ observeManagerGate: async () => null }), /no current open manager gate/);
await rejects("a foreign gate principal is refused", () => run({ observeManagerGate: async () => ({ ...gate, principal: `${owner}.other` }) }), /server-derived serve principal/);
await rejects("a stale serve epoch is refused", () => run({ request: { ...request, serveEpoch: 6 } }), /serve epoch 6 is stale/);
await rejects("host completion cannot return a replacement lifecycle", async () => {
  const retained = await run();
  return completeRemoteRetainedAgentValidation(retained, owner, { ...authority, lifecycleUid: mintLifecycleUid() });
}, /replacement principal or lifecycle/);
await cell("valid host validation returns only bound coordinates and non-secret authority", async () => {
  const retained = await run();
  const result = completeRemoteRetainedAgentValidation(retained, owner, authority);
  assert.deepEqual(result.authority, authority);
  assert.equal(result.owner, owner);
  assert.deepEqual(result.target, target);
  assert.equal(result.requestId, request.requestId);
  const encoded = JSON.stringify(result);
  assert.equal(encoded.includes(request.actorToken), false);
  assert.equal(encoded.includes(request.sentinelCreds), false);
  assert.deepEqual(Object.keys(result).sort(), [
    "actor", "authority", "instanceId", "kind", "managerLifecycleUid", "owner",
    "registrationProof", "requestId", "serveEpoch", "space", "target", "v",
  ]);
});
await cell("actual host dispatcher runs the fixed provider validation and returns no secrets", async () => {
  const root = mkdtempSync(join(tmpdir(), "cotal-retained-rpc-"));
  const dir = userAuthStateDir(root, space);
  const store = workspaceSecretStore(root);
  try {
    ensurePinnedIdp(dir, "http://127.0.0.1:49151/api/auth");
    const auth = await createSpaceAuth(space);
    await cotalAuthProvider.prepareServer({
      store, dir, space, operatorSeed: auth.operator.seed,
      account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    });
    grantActor(dir, { owner, actor: "cli", scope: ["spawn", "supervise", "role:worker"], allowSubscribe: [">"], allowPublish: [">"] });
    const retained = await cotalAuthProvider.grantAgent({
      store, dir, space, owner, actor: target.actor, lifecycleUid: target.lifecycleUid,
      scope: authority.scope, allowSubscribe: authority.allowSubscribe, allowPublish: authority.allowPublish,
      role: authority.role, parent: authority.parent,
    });
    const actualRequest = { ...request, actorToken: retained.actorToken, sentinelCreds: retained.sentinelCreds };
    const result = await dispatchManagerAuthorityRequest({
      space, dir, secrets: store,
      managerServiceAuthority: async () => { throw new Error("wrong dispatcher arm"); },
      scanManagerGoalIndex: async () => { throw new Error("wrong dispatcher arm"); },
      validateRetainedAgent: ({ owner: requestOwner, scope, request: candidate }) =>
        authorizeRemoteRetainedAgentValidation({
          owner: requestOwner, scope, request: candidate, space, proofSecret,
          observeManagerGate: async () => gate,
        }),
    }, owner, { request: actualRequest }) as { authority: typeof authority };
    assert.deepEqual(result.authority, authority);
    const encoded = JSON.stringify(result);
    assert.equal(encoded.includes(retained.actorToken), false);
    assert.equal(encoded.includes(retained.sentinelCreds), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
await cell("provider client sends one authenticated closed request and refuses redirects", async () => {
  const root = mkdtempSync(join(tmpdir(), "cotal-retained-client-"));
  const priorHome = process.env.COTAL_HOME;
  const priorFetch = globalThis.fetch;
  const idpUrl = "http://127.0.0.1:49152/api/auth";
  const dir = userAuthStateDir(root, space);
  try {
    process.env.COTAL_HOME = join(root, "home");
    ensurePinnedIdp(dir, idpUrl);
    saveIdpSession(process.env.COTAL_HOME, idpUrl, { token: "session-secret", expiresAt: Math.floor(Date.now() / 1000) + 60, sub: "human" });
    const auth = await createSpaceAuth(space);
    await cotalAuthProvider.prepareServer({
      store: workspaceSecretStore(root), dir, space, operatorSeed: auth.operator.seed,
      account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
    });
    saveAuthServiceInfo(dir, { url: idpUrl, pid: process.pid, cap: "loopback-cap" });
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      seen.push({ url, init });
      if (url.endsWith("/token")) return Response.json({ token: "fresh-idp-jwt" });
      return new Response("", { status: 307, headers: { location: "https://other.example/steal" } });
    };
    await rejects("provider redirect refusal keeps retained secrets on the pinned host", () =>
      cotalAuthProvider.validateRemoteRetainedAgent!({ store: workspaceSecretStore(root), dir, request }), /redirects are refused/);
    assert.equal(seen.length, 2);
    assert.equal(seen[1]!.url, "http://127.0.0.1:49152/api/auth/manager-service-authority");
    assert.equal(seen[1]!.init?.method, "POST");
    assert.equal(seen[1]!.init?.redirect, "manual");
    assert.equal((seen[1]!.init?.headers as Record<string, string>).authorization, "Bearer loopback-cap");
    assert.deepEqual(JSON.parse(String(seen[1]!.init?.body)), { idpToken: "fresh-idp-jwt", request });
  } finally {
    globalThis.fetch = priorFetch;
    if (priorHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = priorHome;
    rmSync(root, { recursive: true, force: true });
  }
});
await cell("remote provider derives the fixed authority path and refuses insecure exchange pins before fetch", async () => {
  const root = mkdtempSync(join(tmpdir(), "cotal-retained-remote-client-"));
  const priorHome = process.env.COTAL_HOME;
  const priorFetch = globalThis.fetch;
  try {
    process.env.COTAL_HOME = join(root, "home");
    const sentinelPath = join(root, "sentinel.creds");
    mkdirSync(process.env.COTAL_HOME, { recursive: true });
    writeFileSync(sentinelPath, "sentinel-secret", { mode: 0o600 });
    saveIdpSession(process.env.COTAL_HOME, "https://idp.example/api/auth", { token: "session-secret", expiresAt: Math.floor(Date.now() / 1000) + 60, sub: "human" });
    let fetches = 0;
    globalThis.fetch = async (input, init) => {
      fetches++;
      if (String(input).endsWith("/token")) return Response.json({ token: "fresh-idp-jwt" });
      assert.equal(String(input), "https://mesh.example/base/manager-service-authority");
      assert.deepEqual(JSON.parse(String(init?.body)), { idpToken: "fresh-idp-jwt", request });
      return Response.json(resultForClient(request, owner, authority));
    };
    const record = (url: string, managerAuthorityUrl: string) => recordMesh({
      space, server: "wss://mesh.example/nats", root, mode: "user", origin: "manual", ts: new Date().toISOString(),
      userAuth: {
        provider: "cotal", remote: true,
        idp: { url: "https://idp.example/api/auth", issuer: "https://idp.example", audience: "cotal" },
        endpoints: { url, managerAuthorityUrl }, sentinelCredsPath: sentinelPath,
      },
    });
    record("https://mesh.example/base", "https://evil.example/steal");
    const accepted = await cotalAuthProvider.validateRemoteRetainedAgent!({ store: workspaceSecretStore(root), dir: userAuthStateDir(root, space), request });
    assert.equal(accepted.requestId, request.requestId);
    assert.equal(fetches, 2);
    record("http://mesh.example/base", "https://mesh.example/base/manager-service-authority");
    fetches = 0;
    await rejects("plaintext remote exchange pin is refused before any secret-bearing fetch", () =>
      cotalAuthProvider.validateRemoteRetainedAgent!({ store: workspaceSecretStore(root), dir: userAuthStateDir(root, space), request }), /non-HTTPS exchange/);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorHome === undefined) delete process.env.COTAL_HOME;
    else process.env.COTAL_HOME = priorHome;
    rmSync(root, { recursive: true, force: true });
  }
});

const expected = 18;
if (pass !== expected || fail !== 0) {
  console.error(`manager retained validation smoke failed: ${pass}/${expected} passed, ${fail} failed`);
  process.exit(1);
}
console.log(`manager retained validation smoke passed: ${pass}/${expected}`);
