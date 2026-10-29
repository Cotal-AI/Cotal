/** Broker-free policy checks for native personal workflow participation authorization. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintLifecycleUid, newIdentity, remoteManagerActors, type RemoteManagerParticipationAuthorizationRequest } from "@cotal-ai/core";
import { grantManagedActor } from "../src/ledger.js";
import { authorizeRemoteManagerParticipation } from "../src/manager-participation-authorization.js";
import { remoteManagerCurrentRegistrationProof } from "../src/retained-manager-validation.js";

const owner = `u_${"a".repeat(26)}`;
const instanceId = mintLifecycleUid();
const lifecycleUid = mintLifecycleUid();
const actors = remoteManagerActors(instanceId);
const identities = { supervisor: { id: newIdentity().id }, executor: { id: newIdentity().id }, serve: { id: newIdentity().id }, goalWriter: { id: newIdentity().id }, sessionLedger: { id: newIdentity().id } };
const gate = { state: "open" as const, principal: `${owner}.${actors.serve}`, processEpoch: 7, registrationRevision: 11 };
const secret = "participation-secret";
const dir = mkdtempSync(join(tmpdir(), "cotal-manager-participation-"));
let pass = 0, fail = 0;
async function cell(name: string, fn: () => void | Promise<void>) { try { await fn(); pass++; console.log(`  ✓ ${name}`); } catch (error) { fail++; console.error(`  ✗ ${name}:`, error); } }
function request(actor = `pa_${"b".repeat(22)}`, uid = lifecycleUid): RemoteManagerParticipationAuthorizationRequest {
  const base: RemoteManagerParticipationAuthorizationRequest = { v: 1, kind: "manager-participation-authorization", space: "demo", actor: "cli", instanceId, managerLifecycleUid: mintLifecycleUid(), requestId: `part${mintLifecycleUid()}`, registrationProof: `sha256:${"0".repeat(64)}`, serveEpoch: gate.processEpoch, identities, caller: { owner, actor, lifecycleUid: uid } };
  return { ...base, registrationProof: remoteManagerCurrentRegistrationProof(secret, owner, base, gate) };
}
async function authorize(r: RemoteManagerParticipationAuthorizationRequest, state: "active" | "retired" = "active") {
  return authorizeRemoteManagerParticipation({ request: r, space: "demo", managerOwner: owner, managerScope: ["supervise"], proofSecret: secret, dir, observeManagerGate: async () => gate, readLifecycle: async () => ({ mapping: { lifecycleUid: r.caller.lifecycleUid, state } }) });
}
try {
  await cell("active foreground pa_ lifecycle with run is authorized", async () => {
    const r = request();
    grantManagedActor(dir, { owner, actor: r.caller.actor, lifecycleUid, tokenHash: "0".repeat(64), custody: { kind: "foreground" }, scope: ["run"], allowSubscribe: [], allowPublish: [] });
    assert.equal((await authorize(r)).authorized, true);
  });
  await cell("non-pa, stale lifecycle, missing run, remote custody, and inactive head return false", async () => {
    assert.equal((await authorize(request("agent"))).authorized, false);
    const r = request();
    assert.equal((await authorize(request(r.caller.actor, mintLifecycleUid()))).authorized, false);
    grantManagedActor(dir, { owner, actor: r.caller.actor, lifecycleUid, tokenHash: "0".repeat(64), custody: { kind: "foreground" }, scope: [], allowSubscribe: [], allowPublish: [] });
    assert.equal((await authorize(r)).authorized, false);
    grantManagedActor(dir, { owner, actor: r.caller.actor, lifecycleUid, tokenHash: "0".repeat(64), custody: { kind: "remote-manager", instanceId }, scope: ["run"], allowSubscribe: [], allowPublish: [] });
    assert.equal((await authorize(r)).authorized, false);
    assert.equal((await authorize(r, "retired")).authorized, false);
  });
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(`\nmanager-participation-authorization: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
