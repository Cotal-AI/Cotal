/** Broker-free host policy checks for the closed remote manager admin authorization relay. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mintLifecycleUid, newIdentity, remoteManagerActors, type RemoteManagerAdminAuthorizationRequest } from "@cotal-ai/core";
import { grantActor, revokeActor } from "../src/ledger.js";
import { authorizeRemoteManagerAdmin, parseRemoteManagerAdminAuthorizationRequest } from "../src/manager-admin-authorization.js";
import { remoteManagerCurrentRegistrationProof } from "../src/retained-manager-validation.js";

const owner = `u_${"a".repeat(26)}`;
const otherOwner = `u_${"b".repeat(26)}`;
const instanceId = mintLifecycleUid();
const managerLifecycleUid = mintLifecycleUid();
const callerUid = mintLifecycleUid();
const actors = remoteManagerActors(instanceId);
const identities = {
  supervisor: { id: newIdentity().id }, executor: { id: newIdentity().id }, serve: { id: newIdentity().id },
  goalWriter: { id: newIdentity().id }, sessionLedger: { id: newIdentity().id },
};
const secret = "host-proof-secret";
const gate = { state: "open" as const, principal: `${owner}.${actors.serve}`, processEpoch: 7, registrationRevision: 11 };
const dir = mkdtempSync(join(tmpdir(), "cotal-manager-admin-"));
let pass = 0;
let fail = 0;
async function cell(name: string, fn: () => void | Promise<void>) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (error) { fail++; console.error(`  ✗ ${name}:`, error); }
}

function request(overrides: Partial<RemoteManagerAdminAuthorizationRequest> = {}): RemoteManagerAdminAuthorizationRequest {
  const base: RemoteManagerAdminAuthorizationRequest = {
    v: 1, kind: "manager-admin-authorization", space: "demo", actor: "cli", instanceId,
    managerLifecycleUid, requestId: `admin${mintLifecycleUid()}`, registrationProof: `sha256:${"0".repeat(64)}`,
    serveEpoch: gate.processEpoch, identities,
    caller: { owner, actor: "operator", lifecycleUid: callerUid },
  };
  const merged = { ...base, ...overrides };
  merged.registrationProof = overrides.registrationProof ?? remoteManagerCurrentRegistrationProof(secret, owner, merged, gate);
  return merged;
}

async function authorize(r: RemoteManagerAdminAuthorizationRequest, opts: { dir?: string; gate?: typeof gate | null; scope?: string[] } = {}) {
  return authorizeRemoteManagerAdmin({
    request: r, space: "demo", managerOwner: owner, managerScope: opts.scope ?? ["supervise"],
    proofSecret: secret, dir: opts.dir ?? dir, observeManagerGate: async () => opts.gate === undefined ? gate : opts.gate,
  });
}

try {
  await cell("parser refuses unknown request and caller fields", () => {
    assert.throws(() => parseRemoteManagerAdminAuthorizationRequest({ ...request(), extra: true }), /unknown field/);
    assert.throws(() => parseRemoteManagerAdminAuthorizationRequest({ ...request(), caller: { ...request().caller, extra: true } }), /caller must contain exactly/);
  });
  await cell("current same-owner same-lifecycle admin row returns only authorized true", async () => {
    grantActor(dir, { owner, actor: "operator", lifecycleUid: callerUid, scope: ["spawn", "admin"], allowSubscribe: [], allowPublish: [] });
    const r = request();
    assert.deepEqual(await authorize(r), { ...r, owner, authorized: true });
  });
  await cell("narrowing and revoking are observed fresh on the next call", async () => {
    grantActor(dir, { owner, actor: "operator", lifecycleUid: callerUid, scope: ["spawn"], allowSubscribe: [], allowPublish: [] });
    assert.equal((await authorize(request())).authorized, false);
    grantActor(dir, { owner, actor: "operator", lifecycleUid: callerUid, scope: ["admin"], allowSubscribe: [], allowPublish: [] });
    assert.equal((await authorize(request())).authorized, true);
    revokeActor(dir, owner, "operator");
    assert.equal((await authorize(request())).authorized, false);
  });
  await cell("absent, wrong-owner, and stale-lifecycle callers share false without a reason", async () => {
    grantActor(dir, { owner, actor: "operator", lifecycleUid: callerUid, scope: ["admin"], allowSubscribe: [], allowPublish: [] });
    assert.equal((await authorize(request({ caller: { owner, actor: "absent", lifecycleUid: mintLifecycleUid() } }))).authorized, false);
    assert.equal((await authorize(request({ caller: { owner: otherOwner, actor: "operator", lifecycleUid: callerUid } }))).authorized, false);
    assert.equal((await authorize(request({ caller: { owner, actor: "operator", lifecycleUid: mintLifecycleUid() } }))).authorized, false);
  });
  await cell("closed gate, stale epoch, gate principal drift, proof drift, identity drift, and missing supervise throw", async () => {
    const r = request();
    await assert.rejects(authorize(r, { gate: null }), /no current open manager gate/);
    await assert.rejects(authorize({ ...r, serveEpoch: 6 }), /serve epoch 6 is stale/);
    await assert.rejects(authorize(r, { gate: { ...gate, principal: `${owner}.wrong` } }), /gate belongs/);
    await assert.rejects(authorize({ ...r, registrationProof: `sha256:${"f".repeat(64)}` }), /proof does not match/);
    const drift = { ...r, identities: { ...r.identities, serve: { id: newIdentity().id } } };
    await assert.rejects(authorize(drift), /proof does not match/);
    await assert.rejects(authorize(r, { scope: [] }), /needs manager scope/);
  });
  await cell("corrupt and unavailable authoritative ledger state throw", async () => {
    const corrupt = mkdtempSync(join(tmpdir(), "cotal-manager-admin-corrupt-"));
    mkdirSync(join(corrupt, "actors"), { recursive: true });
    writeFileSync(join(corrupt, "actors", `${owner}.operator.json`), "not-json");
    await assert.rejects(authorize(request(), { dir: corrupt }), /unreadable actor grant/);
    rmSync(corrupt, { recursive: true, force: true });
    const unavailable = mkdtempSync(join(tmpdir(), "cotal-manager-admin-unavailable-"));
    writeFileSync(join(unavailable, "actors"), "not-a-directory");
    await assert.rejects(authorize(request(), { dir: unavailable }), /must be a real directory/);
    rmSync(unavailable, { recursive: true, force: true });
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nmanager-admin-authorization: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
