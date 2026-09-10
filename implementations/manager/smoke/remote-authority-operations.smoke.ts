/** Broker-free routing checks for authenticated remote manager maintenance operations. */
import assert from "node:assert/strict";
import { mintLifecycleUid, newIdentity, remoteManagerActors } from "@cotal-ai/core";
import { Manager } from "../src/manager.js";
import { remoteManagerAdminAuthorizationRequest, remoteManagerAdminAuthorized, remoteManagerGoalIndexEntries } from "../src/remote-authority.js";

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

console.log("remote authority operations: 31 passed, 0 failed");
