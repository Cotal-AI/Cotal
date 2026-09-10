/** Closed remote manager-service authority policy cells (broker-free). */
import assert from "node:assert/strict";
import { managedRetirementOpId, newIdentity, mintLifecycleUid, permissionsFor, remoteManagerActors } from "@cotal-ai/core";
import { remoteManagerIssuerGrants } from "@cotal-ai/auth";
import { issueRemoteManagerAuthority, parseRemoteManagerAuthorityRequest, USER_TOKEN_VIEWS } from "@cotal-ai/auth";
import { authorizeRemoteManagerRetirement } from "../src/service.js";

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
const registrationProof = `sha256:${"a".repeat(64)}`;
const retirementTarget = { owner: "u_aaaaaaaaaaaaaaaaaaaaaaaaaa", actor: "worker", lifecycleUid: mintLifecycleUid() };
const retirement = {
  id: newIdentity().id,
  target: retirementTarget,
  opId: managedRetirementOpId(retirementTarget.lifecycleUid),
  serveEpoch: 7,
};
const retireRequest = { ...request, operation: "retire" as const, registrationProof, retirement };

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
await rejects("retire requires its closed operation object", () => parseRemoteManagerAuthorityRequest({ ...retireRequest, retirement: undefined }), /retire requires retirement exactly/);
await rejects("retire refuses unknown operation fields", () => parseRemoteManagerAuthorityRequest({ ...retireRequest, retirement: { ...retirement, profile: "admin" } }), /exactly/);
await rejects("retire requires a stable lifecycle opId", () => parseRemoteManagerAuthorityRequest({ ...retireRequest, retirement: { ...retirement, opId: "not-valid" } }), /opId/);
await rejects("retire refuses a different valid opId for the same lifecycle", () => parseRemoteManagerAuthorityRequest({ ...retireRequest, retirement: { ...retirement, opId: mintLifecycleUid() } }), /derived terminal operation id/);
await rejects("retire requires a non-negative safe serve epoch", () => parseRemoteManagerAuthorityRequest({ ...retireRequest, retirement: { ...retirement, serveEpoch: -1 } }), /serveEpoch/);
await rejects("retire requires a derived target owner", () => parseRemoteManagerAuthorityRequest({ ...retireRequest, retirement: { ...retirement, target: { ...retirementTarget, owner: "local" } } }), /derived owner/);
await rejects("retire requires a subject-safe target actor", () => parseRemoteManagerAuthorityRequest({ ...retireRequest, retirement: { ...retirement, target: { ...retirementTarget, actor: "bad.actor" } } }), /single NATS-safe token/);
await rejects("missing identity family members are refused", () => parseRemoteManagerAuthorityRequest({ ...request, identities: { supervisor: identities.supervisor } }), /identities must contain exactly/);
await rejects("the retirement requester nkey cannot collapse into a standing identity", () => issueRemoteManagerAuthority({
  request: { ...retireRequest, retirement: { ...retirement, id: identities.serve.id } }, owner: retirementTarget.owner, scope: ["supervise"],
  issue: async () => ({ credentials: { retirementRequester: { jwt: "a.b.c", exp: 200 } } }),
}), /identities must be distinct/);
await cell("retire returns only the one-shot requester and echoes the terminal coordinates", async () => {
  const material = await issueRemoteManagerAuthority({
    request: retireRequest, owner: retirementTarget.owner, scope: ["supervise"], now: () => 10,
    issue: async ({ owner, actors, request: parsed }) => {
      assert.equal(owner, retirementTarget.owner);
      assert.equal(actors.serve, `manager_serve_${instanceId}`);
      assert.deepEqual(parsed.retirement, retirement);
      return { credentials: { retirementRequester: { jwt: "a.b.c", exp: 200 } } };
    },
  });
  assert.deepEqual(Object.keys(material.credentials), ["retirementRequester"]);
  assert.deepEqual(material.retirement, retirement);
  assert.equal(material.expiresAt, 200_000);
});
await cell("retirement-requester grants only its server-derived caller and exact target", () => {
  const actors = remoteManagerActors(instanceId);
  const perms = permissionsFor("retirement-requester", "demo", {
    owner: retirementTarget.owner, actor: actors.serve, connId: retirement.id, lifecycleUid,
  }, {
    retirementRequester: {
      owner: retirementTarget.owner, actor: actors.serve, uid: lifecycleUid, target: retirementTarget,
    },
  }) as { pub: { allow: string[] }; sub: { allow: string[] } };
  const rows = [...perms.pub.allow, ...perms.sub.allow];
  assert.equal(rows.some((row) => row.includes(retirementTarget.lifecycleUid)), true);
  assert.equal(rows.some((row) => row === ">" || row.includes("$KV") || row.includes("STREAM.")), false);
  assert.equal(rows.some((row) => row.includes("another-worker")), false);
});
const serveActor = remoteManagerActors(instanceId).serve;
const currentGate = { state: "open" as const, principal: `${retirementTarget.owner}.${serveActor}`, processEpoch: retirement.serveEpoch };
await cell("current server-derived manager gate authorizes retirement requester issuance", () => {
  authorizeRemoteManagerRetirement({ owner: retirementTarget.owner, serveActor, instanceId, targetOwner: retirementTarget.owner, serveEpoch: retirement.serveEpoch, gate: currentGate });
});
await rejects("a foreign target owner is refused", () => authorizeRemoteManagerRetirement({
  owner: retirementTarget.owner, serveActor, instanceId, targetOwner: "u_bbbbbbbbbbbbbbbbbbbbbbbbbb", serveEpoch: retirement.serveEpoch, gate: currentGate,
}), /authenticated owner/);
await rejects("an absent manager gate is refused", () => authorizeRemoteManagerRetirement({
  owner: retirementTarget.owner, serveActor, instanceId, targetOwner: retirementTarget.owner, serveEpoch: retirement.serveEpoch, gate: null,
}), /no current open manager gate/);
await rejects("a retired manager gate is refused", () => authorizeRemoteManagerRetirement({
  owner: retirementTarget.owner, serveActor, instanceId, targetOwner: retirementTarget.owner, serveEpoch: retirement.serveEpoch, gate: { ...currentGate, state: "retired" },
}), /no current open manager gate/);
await rejects("a frozen manager gate is refused", () => authorizeRemoteManagerRetirement({
  owner: retirementTarget.owner, serveActor, instanceId, targetOwner: retirementTarget.owner, serveEpoch: retirement.serveEpoch, gate: { ...currentGate, state: "frozen" },
}), /no current open manager gate/);
await rejects("a foreign-principal manager gate is refused", () => authorizeRemoteManagerRetirement({
  owner: retirementTarget.owner, serveActor, instanceId, targetOwner: retirementTarget.owner, serveEpoch: retirement.serveEpoch, gate: { ...currentGate, principal: `${retirementTarget.owner}.manager_serve_foreign` },
}), /server-derived serve principal/);
await rejects("a stale manager serve epoch is refused", () => authorizeRemoteManagerRetirement({
  owner: retirementTarget.owner, serveActor, instanceId, targetOwner: retirementTarget.owner, serveEpoch: retirement.serveEpoch - 1, gate: currentGate,
}), /serve epoch .* is stale/);
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
