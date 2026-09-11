/** Broker-free routing checks for authenticated remote manager maintenance operations. */
import assert from "node:assert/strict";
import { credsFromJwt, mintLifecycleUid, newIdentity, remoteManagerActors } from "@cotal-ai/core";
import { Manager } from "../src/manager.js";
import { remoteManagerAdminAuthorizationRequest, remoteManagerAdminAuthorized, remoteManagerGoalIndexEntries, renewedRegistrationProof } from "../src/remote-authority.js";

const instanceId = mintLifecycleUid();
const identities = {
  supervisor: newIdentity(), executor: newIdentity(), serve: newIdentity(),
  goalWriter: newIdentity(), sessionLedger: newIdentity(),
};
let hostScans = 0;
const manager = new Manager({
  space: "demo",
  runtime: "pty",
  remoteAuthority: {
    owner: `u_${"a".repeat(26)}`,
    actors: remoteManagerActors(instanceId),
    instanceId,
    lifecycleUid: mintLifecycleUid(),
    identities,
    supervisorCreds: "", executorCreds: "", serveCreds: "", goalWriterCreds: "", sessionLedgerCreds: "",
    registrationProof: `sha256:${"a".repeat(64)}`,
    renew: async () => { throw new Error("not used"); },
    serveGrant: {} as never,
    agentBearerExchangeUrl: "https://auth.example.test",
    mintSessionServing: async () => "",
    mintRetirementRequester: async () => "",
    prepareAgentRetirement: async () => {},
    validateRetainedAgent: async () => { throw new Error("not used"); },
    scanGoalIndex: async () => { hostScans++; return []; },
    authorizeAdmin: async () => false,
  },
}) as unknown as {
  managerInstanceId: string;
  goalWriter: unknown;
  dial(opts: unknown): Promise<never>;
  withEndpointServeExecutor<T>(fn: unknown): Promise<T>;
  withOpenServeConnection<T>(fn: unknown): Promise<T>;
  deregisterServiceOnStop(): Promise<void>;
  reconcileGoalIndex(): Promise<void>;
};
manager.managerInstanceId = instanceId;

let scoped = 0;
let bare = 0;
manager.withEndpointServeExecutor = async () => {
  scoped++;
  return { removed: false, reason: "absent" } as never;
};
manager.withOpenServeConnection = async () => {
  bare++;
  throw new Error("remote authority must not use a bare connection");
};
await manager.deregisterServiceOnStop();
assert.deepEqual({ scoped, bare, hostScans }, { scoped: 1, bare: 0, hostScans: 0 });

manager.goalWriter = {};
manager.dial = async () => {
  bare++;
  throw new Error("remote authority must not dial anonymously for the goal-index sweep");
};
manager.withEndpointServeExecutor = async () => {
  scoped++;
  return [] as never;
};
await manager.reconcileGoalIndex();
assert.deepEqual({ scoped, bare, hostScans }, { scoped: 1, bare: 0, hostScans: 1 });

const guarded = new Manager({
  space: "demo", runtime: "pty",
  remoteAuthority: {
    owner: `u_${"a".repeat(26)}`, actors: remoteManagerActors(instanceId), instanceId,
    lifecycleUid: mintLifecycleUid(), identities,
    supervisorCreds: "", executorCreds: "", serveCreds: "", goalWriterCreds: "", sessionLedgerCreds: "",
    registrationProof: `sha256:${"a".repeat(64)}`,
    renew: async () => { throw new Error("not used"); },
    serveGrant: {} as never, agentBearerExchangeUrl: "https://auth.example.test",
    mintSessionServing: async () => "", mintRetirementRequester: async () => "",
    prepareAgentRetirement: async () => {}, validateRetainedAgent: async () => { throw new Error("not used"); },
    scanGoalIndex: async () => [],
    authorizeAdmin: async () => false,
  },
}) as unknown as { withOpenServeConnection<T>(fn: unknown): Promise<T> };
await assert.rejects(guarded.withOpenServeConnection(async () => undefined), /authenticated mesh must use the scoped endpoint-serve executor/);

const owner = `u_${"a".repeat(26)}`;
const request = {
  v: 1 as const, kind: "manager-goal-index-scan" as const, space: "demo", actor: "cli", instanceId,
  managerLifecycleUid: mintLifecycleUid(), requestId: `scan${mintLifecycleUid()}`,
  registrationProof: `sha256:${"a".repeat(64)}`, serveEpoch: 7,
  identities: Object.fromEntries(Object.entries(identities).map(([name, identity]) => [name, { id: identity.id }])) as {
    supervisor: { id: string }; executor: { id: string }; serve: { id: string };
    goalWriter: { id: string }; sessionLedger: { id: string };
  },
};
const entry = { v: 1 as const, endpoint: "manager", owner, actor: "cli", uid: mintLifecycleUid(), goalId: `goal${mintLifecycleUid()}`, iid: instanceId };
const result = {
  v: 1 as const, kind: "manager-goal-index-scan" as const, space: request.space, owner, actor: request.actor,
  instanceId: request.instanceId, managerLifecycleUid: request.managerLifecycleUid, requestId: request.requestId,
  registrationProof: request.registrationProof, serveEpoch: request.serveEpoch, entries: [entry],
};
assert.deepEqual(remoteManagerGoalIndexEntries(result, request, owner), [entry]);
assert.throws(() => remoteManagerGoalIndexEntries({ ...result, extra: true } as never, request, owner), /non-closed result/);
assert.throws(() => remoteManagerGoalIndexEntries({ ...result, actor: "other" }, request, owner), /different lifecycle coordinates/);
assert.throws(() => remoteManagerGoalIndexEntries({ ...result, entries: [{ ...entry, owner: `u_${"b".repeat(26)}` }] }, request, owner), /invalid entry 0/);
assert.throws(() => remoteManagerGoalIndexEntries({ ...result, entries: [{ ...entry, extra: true } as never] }, request, owner), /invalid entry 0/);

const state = { v: 1 as const, space: "demo", instanceId, lifecycleUid: request.managerLifecycleUid, identities };
const caller = { owner, actor: "operator", lifecycleUid: mintLifecycleUid() };
const adminRequest = remoteManagerAdminAuthorizationRequest(state, "cli", request.registrationProof, 7, caller);
assert.deepEqual(adminRequest.caller, caller);
const adminResult = { ...adminRequest, owner, authorized: true };
assert.equal(remoteManagerAdminAuthorized(adminResult, adminRequest, owner), true);
assert.throws(() => remoteManagerAdminAuthorized({ ...adminResult, extra: true } as never, adminRequest, owner), /non-closed result/);
assert.throws(() => remoteManagerAdminAuthorized({ ...adminResult, caller: { ...caller, lifecycleUid: mintLifecycleUid() } }, adminRequest, owner), /different lifecycle/);
assert.throws(() => remoteManagerAdminAuthorized({ ...adminResult, owner: `u_${"b".repeat(26)}` }, adminRequest, owner), /different lifecycle/);
assert.throws(() => remoteManagerAdminAuthorized({ ...adminResult, authorized: "yes" } as never, adminRequest, owner), /different lifecycle/);

let remoteChecks = 0;
let adminDecision: true | Error = true;
const remoteOnly = new Manager({
  space: "demo", runtime: "pty",
  remoteAuthority: {
    owner, actors: remoteManagerActors(instanceId), instanceId, lifecycleUid: request.managerLifecycleUid, identities,
    supervisorCreds: "", executorCreds: "", serveCreds: "", goalWriterCreds: "", sessionLedgerCreds: "",
    registrationProof: request.registrationProof,
    renew: async () => { throw new Error("not used"); },
    serveGrant: {} as never, agentBearerExchangeUrl: "https://auth.example.test",
    mintSessionServing: async () => "", mintRetirementRequester: async () => "", prepareAgentRetirement: async () => {},
    validateRetainedAgent: async () => { throw new Error("not used"); }, scanGoalIndex: async () => [],
    authorizeAdmin: async (seen) => {
      remoteChecks++;
      assert.deepEqual(seen, caller);
      if (adminDecision instanceof Error) throw adminDecision;
      return adminDecision;
    },
  },
}) as unknown as {
  userMode: boolean;
  epAdminReach(caller: { owner: string; actor: string; uid: string }): Promise<boolean>;
  authorizeNamed(target: { name: string; spawner: string; userOwner?: string }, principal: string, admin: boolean, caller: { owner: string; actor: string; uid: string }): Promise<string | undefined>;
  managerServiceDefs(): Array<{ command: string; handler(ctx: unknown): Promise<unknown> | unknown }>;
  serveGated<T>(ctx: unknown, fn: () => T | Promise<T>): Promise<T>;
  findManagedByTarget(): unknown;
  despawnAuthorized(): { ok: true; data: unknown };
  attachAuthorized(): Promise<{ ok: true; data: unknown }>;
  inputAuthorized(): unknown;
  serveTurnGoal(): unknown;
};
remoteOnly.userMode = true;
assert.equal(await remoteOnly.epAdminReach({ owner: caller.owner, actor: caller.actor, uid: caller.lifecycleUid }), true);
assert.equal(remoteChecks, 1);
const epCaller = { owner: caller.owner, actor: caller.actor, uid: caller.lifecycleUid };
assert.equal(await remoteOnly.authorizeNamed({ name: "foreign", spawner: "other.actor", userOwner: `u_${"b".repeat(26)}` }, `${caller.owner}.${caller.actor}`, false, epCaller), undefined);
assert.equal(remoteChecks, 2);
assert.equal(await remoteOnly.authorizeNamed({ name: "owned", spawner: "other.actor", userOwner: caller.owner }, `${caller.owner}.${caller.actor}`, false, epCaller), undefined);
assert.equal(remoteChecks, 2);

// Drive the real typed handlers, not only their policy helper. Every changed owner-mode handler must
// relay the exact subject caller to the host before its operation effect, and a host-state fault must
// escape without running that effect.
const foreignTarget = { name: "foreign", spawner: "other.actor", userOwner: `u_${"b".repeat(26)}` };
const effects: string[] = [];
remoteOnly.serveGated = async (_ctx, fn) => fn();
remoteOnly.findManagedByTarget = () => foreignTarget;
remoteOnly.despawnAuthorized = () => { effects.push("despawn"); return { ok: true, data: {} }; };
remoteOnly.attachAuthorized = async () => { effects.push("attach"); return { ok: true, data: {} }; };
remoteOnly.inputAuthorized = () => { effects.push("input"); return {}; };
remoteOnly.serveTurnGoal = () => { effects.push("turn"); return {}; };
const handlers = new Map(remoteOnly.managerServiceDefs().map((def) => [def.command, def.handler]));
const handlerContext = {
  subject: { caller: epCaller, target: { mode: "owner" } },
  request: { args: {}, target: { owner: foreignTarget.userOwner, actor: "worker", lifecycleUid: mintLifecycleUid() } },
};
for (const command of ["despawn", "attach", "input", "turn"]) {
  await handlers.get(command)!(handlerContext);
}
assert.deepEqual(effects, ["despawn", "attach", "input", "turn"]);
assert.equal(remoteChecks, 6);
adminDecision = new Error("host authority unavailable");
effects.length = 0;
for (const command of ["despawn", "attach", "input", "turn"]) {
  await assert.rejects(Promise.resolve(handlers.get(command)!(handlerContext)), /host authority unavailable/);
}
assert.deepEqual(effects, []);
assert.equal(remoteChecks, 10);

const proof = `sha256:${"b".repeat(64)}`;
const renewalCredential = (identity: typeof identities.supervisor) => ({
  jwt: [Buffer.from("{}").toString("base64url"), Buffer.from(JSON.stringify({ sub: identity.id, exp: 2_000_000_000 })).toString("base64url"), "sig"].join("."),
  exp: 2_000_000_000,
});
const renewalRequest = {
  v: 1 as const,
  kind: "manager-service-authority" as const,
  operation: "renew" as const,
  space: "demo",
  actor: "cli",
  instanceId,
  managerLifecycleUid: request.managerLifecycleUid,
  requestId: `renew${mintLifecycleUid()}`,
  registrationProof: proof,
  identities: Object.fromEntries(Object.entries(identities).map(([name, identity]) => [name, { id: identity.id }])) as {
    supervisor: { id: string }; executor: { id: string }; serve: { id: string };
    goalWriter: { id: string }; sessionLedger: { id: string };
  },
};
const renewalResult = {
  v: 1 as const,
  kind: "manager-service-authority" as const,
  operation: "renew" as const,
  space: renewalRequest.space,
  owner,
  actor: renewalRequest.actor,
  instanceId: renewalRequest.instanceId,
  lifecycleUid: renewalRequest.managerLifecycleUid,
  requestId: renewalRequest.requestId,
  registrationProof: proof,
  issuedAt: 1_900_000_000_000,
  expiresAt: 2_000_000_000_000,
  actors: remoteManagerActors(instanceId),
  identities: renewalRequest.identities,
  nextRegistrationProof: proof,
  credentials: {
    supervisor: renewalCredential(identities.supervisor),
    executor: renewalCredential(identities.executor),
    serve: renewalCredential(identities.serve),
    goalWriter: renewalCredential(identities.goalWriter),
    sessionLedger: renewalCredential(identities.sessionLedger),
  },
};
assert.equal(renewedRegistrationProof(renewalResult, renewalRequest, owner), proof);
assert.throws(() => renewedRegistrationProof({ ...renewalResult, extra: true } as never, renewalRequest, owner), /non-closed result/, "unknown renewal result fields are refused");
assert.throws(() => renewedRegistrationProof({ ...renewalResult, v: 2 } as never, renewalRequest, owner), /different request/, "altered renewal protocol version is refused");
assert.throws(() => renewedRegistrationProof({ ...renewalResult, kind: "manager-service-authority-old" } as never, renewalRequest, owner), /different request/, "altered renewal result kind is refused");
assert.throws(() => renewedRegistrationProof({ ...renewalResult, operation: "activate" } as never, renewalRequest, owner), /different request/, "altered renewal operation is refused");
assert.throws(() => renewedRegistrationProof({ ...renewalResult, space: "other" }, renewalRequest, owner), /different request/, "altered renewal space is refused");
assert.throws(() => renewedRegistrationProof({ ...renewalResult, owner: `u_${"c".repeat(26)}` }, renewalRequest, owner), /different request/, "altered renewal owner is refused");
assert.throws(() => renewedRegistrationProof({ ...renewalResult, actor: "other" }, renewalRequest, owner), /different request/, "altered renewal actor is refused");
assert.throws(() => renewedRegistrationProof({ ...renewalResult, instanceId: mintLifecycleUid() }, renewalRequest, owner), /different request/, "altered renewal instance is refused");
assert.throws(() => renewedRegistrationProof({ ...renewalResult, lifecycleUid: mintLifecycleUid() }, renewalRequest, owner), /different request/, "altered renewal lifecycle is refused");
assert.throws(() => renewedRegistrationProof({ ...renewalResult, requestId: `renew${mintLifecycleUid()}` }, renewalRequest, owner), /different request/, "a still-live response from an earlier renewal request is refused");
assert.throws(() => renewedRegistrationProof({ ...renewalResult, registrationProof: `sha256:${"c".repeat(64)}` }, renewalRequest, owner), /different request/, "altered renewal current proof is refused");
assert.throws(() => renewedRegistrationProof({ ...renewalResult, nextRegistrationProof: `sha256:${"c".repeat(64)}` }, renewalRequest, owner), /different request/, "a renewal response with a different next proof is refused");
assert.throws(() => renewedRegistrationProof({ ...renewalResult, actors: { ...renewalResult.actors, executor: "other" } }, renewalRequest, owner), /different request/, "altered renewal actors are refused");
assert.throws(() => renewedRegistrationProof({ ...renewalResult, identities: { ...renewalResult.identities, executor: { id: newIdentity().id } } }, renewalRequest, owner), /different request/, "a renewal response for a different identity family is refused");
assert.throws(() => renewedRegistrationProof({ ...renewalResult, identities: { ...renewalResult.identities, extra: { id: newIdentity().id } } } as never, renewalRequest, owner), /different request/, "an extra renewal identity is refused");
assert.throws(() => renewedRegistrationProof({ ...renewalResult, retirement: { id: newIdentity().id } } as never, renewalRequest, owner), /non-closed result/, "retirement coordinates on renewal are refused");
const { executor: _missingExecutor, ...missingExecutor } = renewalResult.credentials;
assert.throws(() => renewedRegistrationProof({ ...renewalResult, credentials: missingExecutor } as never, renewalRequest, owner), /non-closed credential family/, "a missing renewal credential family member is refused");
assert.throws(() => renewedRegistrationProof({ ...renewalResult, credentials: { ...renewalResult.credentials, extra: renewalCredential(newIdentity()) } } as never, renewalRequest, owner), /non-closed credential family/, "an extra renewal credential family member is refused");
assert.throws(() => renewedRegistrationProof({ ...renewalResult, credentials: { ...renewalResult.credentials, executor: { ...renewalResult.credentials.executor, extra: true } } } as never, renewalRequest, owner), /non-closed credential family/, "an extra field inside a renewal credential is refused");

function fakeCred(identity: typeof identities.supervisor, iat: number, exp: number, generation: string): string {
  const jwt = [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(JSON.stringify({ sub: identity.id, iat, exp, generation })).toString("base64url"),
    "sig",
  ].join(".");
  return credsFromJwt(jwt, identity);
}
const now = Math.floor(Date.now() / 1000);
const old = {
  supervisor: fakeCred(identities.supervisor, now, now + 600, "old-supervisor"),
  executor: fakeCred(identities.executor, now, now + 600, "old-executor"),
  serve: fakeCred(identities.serve, now, now + 600, "old-serve"),
  goal: fakeCred(identities.goalWriter, now, now + 600, "old-goal"),
  session: fakeCred(identities.sessionLedger, now, now + 600, "old-session"),
};
const fresh = {
  registrationProof: proof,
  supervisorCreds: fakeCred(identities.supervisor, now, now + 1200, "fresh-supervisor"),
  executorCreds: fakeCred(identities.executor, now, now + 1200, "fresh-executor"),
  serveCreds: fakeCred(identities.serve, now, now + 1200, "fresh-serve"),
  goalWriterCreds: fakeCred(identities.goalWriter, now, now + 1200, "fresh-goal"),
  sessionLedgerCreds: fakeCred(identities.sessionLedger, now, now + 1200, "fresh-session"),
};
let renewCalls = 0;
let releaseRenew!: () => void;
const renewGate = new Promise<void>((resolve) => { releaseRenew = resolve; });
const adoption: string[] = [];
let renewing!: {
  ep: { reloadCreds(): Promise<unknown> };
  serviceServe: { creds: string; nc: { reconnect(): Promise<void> } };
  goalWriter: { creds: string; nc: { reconnect(): Promise<void> } };
  sessionLedgerConn: { creds: string; nc: { reconnect(): Promise<void> } };
  remoteSupervisorCreds: string;
  remoteExecutorCreds: string;
  remoteAuthority: { registrationProof: string };
  goalWriterCreds: string;
  sessionLedgerCreds: string;
  renewRemoteAuthority(): Promise<void>;
  armRemoteAuthorityRenewal(): void;
  probeStaticCredential(creds: string): Promise<{ ok: boolean; reason: string }>;
};
renewing = new Manager({
  space: "demo", runtime: "pty",
  remoteAuthority: {
    owner, actors: remoteManagerActors(instanceId), instanceId, lifecycleUid: request.managerLifecycleUid, identities,
    supervisorCreds: old.supervisor, executorCreds: old.executor, serveCreds: old.serve,
    goalWriterCreds: old.goal, sessionLedgerCreds: old.session, registrationProof: proof,
    renew: async () => { renewCalls++; await renewGate; return fresh; },
    serveGrant: {} as never, agentBearerExchangeUrl: "https://auth.example.test",
    mintSessionServing: async () => "", mintRetirementRequester: async () => "",
    prepareAgentRetirement: async () => {}, validateRetainedAgent: async () => { throw new Error("not used"); },
    scanGoalIndex: async () => [], authorizeAdmin: async () => false,
  },
}) as unknown as typeof renewing;
renewing.ep = {
  reloadCreds: async () => {
    assert.ok(renewing.remoteSupervisorCreds === fresh.supervisorCreds, "supervisor adoption saw fresh credential");
    adoption.push("supervisor-reload");
    return {};
  },
};
renewing.serviceServe = { creds: old.serve, nc: { reconnect: async () => {
  assert.ok(renewing.serviceServe.creds === fresh.serveCreds, "serve adoption saw fresh credential");
  adoption.push("serve");
} } };
renewing.goalWriter = { creds: old.goal, nc: { reconnect: async () => {
  assert.ok(renewing.goalWriterCreds === fresh.goalWriterCreds, "goal adoption saw fresh field");
  assert.ok(renewing.goalWriter.creds === fresh.goalWriterCreds, "goal adoption saw fresh holder");
  adoption.push("goal");
} } };
renewing.sessionLedgerConn = { creds: old.session, nc: { reconnect: async () => {
  assert.ok(renewing.sessionLedgerCreds === fresh.sessionLedgerCreds, "session adoption saw fresh field");
  assert.ok(renewing.sessionLedgerConn.creds === fresh.sessionLedgerCreds, "session adoption saw fresh holder");
  adoption.push("session");
} } };
renewing.goalWriterCreds = old.goal;
renewing.sessionLedgerCreds = old.session;
renewing.armRemoteAuthorityRenewal = () => {};
renewing.probeStaticCredential = async () => ({ ok: true, reason: "ok" });
const firstRenew = renewing.renewRemoteAuthority();
const joinedRenew = renewing.renewRemoteAuthority();
assert.equal(firstRenew, joinedRenew);
assert.equal(renewCalls, 1);
assert.ok(renewing.remoteExecutorCreds === old.executor, "blocked renewal leaves the executor credential unchanged");
releaseRenew();
await firstRenew;
assert.equal(renewCalls, 1);
assert.ok(renewing.remoteSupervisorCreds === fresh.supervisorCreds, "fresh supervisor credential was installed");
assert.ok(renewing.remoteExecutorCreds === fresh.executorCreds, "fresh executor credential was installed");
assert.equal(renewing.remoteAuthority.registrationProof, fresh.registrationProof, "fresh registration proof was installed");
assert.ok(renewing.serviceServe.creds === fresh.serveCreds, "fresh serve credential was installed");
assert.ok(renewing.goalWriterCreds === fresh.goalWriterCreds, "fresh goal-writer credential field was installed");
assert.ok(renewing.goalWriter.creds === fresh.goalWriterCreds, "fresh goal-writer holder credential was installed");
assert.ok(renewing.sessionLedgerCreds === fresh.sessionLedgerCreds, "fresh session-ledger credential field was installed");
assert.ok(renewing.sessionLedgerConn.creds === fresh.sessionLedgerCreds, "fresh session-ledger holder credential was installed");
assert.equal(adoption.filter((value) => value === "supervisor-reload").length, 1, "supervisor holder adopted the fresh credential");
assert.equal(adoption.filter((value) => value === "serve").length, 1, "serve holder adopted the fresh credential");
assert.equal(adoption.filter((value) => value === "goal").length, 1, "goal-writer holder adopted the fresh credential");
assert.equal(adoption.filter((value) => value === "session").length, 1, "session-ledger holder adopted the fresh credential");

console.log("remote authority operations: 70 passed, 0 failed");
