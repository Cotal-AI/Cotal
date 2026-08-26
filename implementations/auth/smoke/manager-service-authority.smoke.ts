/** Closed remote manager-service authority policy cells (broker-free). */
import assert from "node:assert/strict";
import { newIdentity, mintLifecycleUid, permissionsFor, remoteManagerActors } from "@cotal-ai/core";
import { remoteManagerIssuerGrants } from "@cotal-ai/auth";
import { issueRemoteManagerAuthority, parseRemoteManagerAuthorityRequest, USER_TOKEN_VIEWS } from "@cotal-ai/auth";

let pass = 0;
let fail = 0;
async function cell(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ FAIL: ${name}`, e); }
}
async function rejects(name: string, fn: () => unknown | Promise<unknown>, re: RegExp) {
  await cell(name, async () => {
    let error: unknown;
    try { await fn(); } catch (e) { error = e; }
    assert.ok(error instanceof Error, "expected a refusal");
    assert.match(error.message, re);
  });
}

const instanceId = mintLifecycleUid();
const lifecycleUid = mintLifecycleUid();
const identities = {
  supervisor: { id: newIdentity().id },
  executor: { id: newIdentity().id },
  serve: { id: newIdentity().id },
  goalWriter: { id: newIdentity().id },
  sessionLedger: { id: newIdentity().id },
};
const request = {
  v: 1 as const,
  kind: "manager-service-authority" as const,
  operation: "prepare" as const,
  space: "demo",
  actor: "cli",
  instanceId,
  managerLifecycleUid: lifecycleUid,
  requestId: `req${mintLifecycleUid()}`,
  identities,
};
const credentials = {
  supervisor: { jwt: "a.b.c", exp: 200 },
  executor: { jwt: "a.b.c", exp: 150 },
};

await rejects("spawn-only cannot issue manager-service authority", () => issueRemoteManagerAuthority({
  request, owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", scope: ["spawn"], issue: async () => credentials,
}), /scope "supervise"/);
await rejects("admin without supervise cannot issue manager-service authority", () => issueRemoteManagerAuthority({
  request, owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", scope: ["admin"], issue: async () => credentials,
}), /scope "supervise"/);
await cell("supervise alone passes the dedicated gate", async () => {
  const material = await issueRemoteManagerAuthority({
    request, owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", scope: ["supervise"], now: () => 10,
    issue: async () => ({ credentials }),
  });
  assert.equal(material.owner, "u_aaaaaaaaaaaaaaaaaaaaaaaaaa");
  assert.deepEqual(material.actors, remoteManagerActors(instanceId));
  assert.equal(material.expiresAt, 150_000);
});
await rejects("raw profile/view strings are refused by the core permission builder", () =>
  permissionsFor("manager-service" as never, "demo", { owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", actor: "cli", connId: newIdentity().id }, {}), /not a generic profile/);
await cell("manager-service is a closed view name but cannot become a connect profile", () => {
  assert.equal(USER_TOKEN_VIEWS.includes("manager-service"), true);
});
await rejects("unknown request fields are refused", () => parseRemoteManagerAuthorityRequest({ ...request, profile: "provisioner" }), /unknown field/);
await rejects("unknown operations are refused", () => parseRemoteManagerAuthorityRequest({ ...request, operation: "mint" }), /operation must/);
await rejects("missing identity family members are refused", () => parseRemoteManagerAuthorityRequest({ ...request, identities: { supervisor: identities.supervisor } }), /identities must contain exactly/);
await cell("supervise authority carries no admin messaging god-view", () => {
  const perms = permissionsFor("remote-manager", "demo", {
    owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", actor: `manager_${instanceId}`, connId: newIdentity().id, lifecycleUid,
  }, { remoteManager: { instanceId, owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", actor: `manager_${instanceId}` } }) as { pub: { allow: string[] }; sub: { allow: string[] } };
  const all = [...perms.pub.allow, ...perms.sub.allow];
  assert.equal(all.some((row) => row.includes(".inst.>") || row.includes(".svc.>") || row.includes(".chat.>")), false);
});
await cell("supervise authority has no arbitrary stream/KV/static mint surface", () => {
  const perms = permissionsFor("remote-manager", "demo", {
    owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", actor: `manager_${instanceId}`, connId: newIdentity().id, lifecycleUid,
  }, { remoteManager: { instanceId, owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", actor: `manager_${instanceId}` } }) as { pub: { allow: string[] }; sub: { allow: string[] } };
  const all = [...perms.pub.allow, ...perms.sub.allow];
  assert.equal(all.some((row) => row.includes("STREAM.CREATE") || row.includes("STREAM.DELETE") || row.includes("$KV.>")), false);
  assert.equal(all.every((row) => !row.includes("epgate.manager.") || row.includes(instanceId)), true);
});
await cell("host issuer grant has no signer or generic profile endpoint", () => {
  const grants = remoteManagerIssuerGrants("demo", newIdentity().id);
  assert.equal(grants.publish.some((row) => row === ">" || row === "$JS.>" || row === "$KV.>"), false);
});
await cell("manager actors are fixed by the server-selected instance coordinate", () => {
  assert.deepEqual(remoteManagerActors(instanceId), {
    supervisor: `manager_${instanceId}`,
    executor: `manager_exec_${instanceId}`,
    serve: `manager_serve_${instanceId}`,
    goalWriter: `manager_goal_${instanceId}`,
    sessionLedger: `manager_session_${instanceId}`,
  });
});

console.log(`\nmanager-service-authority: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
