/** Broker-free routing checks for authenticated remote manager maintenance operations. */
import assert from "node:assert/strict";
import { credsFromJwt, mintLifecycleUid, newIdentity, remoteManagerActors } from "@cotal-ai/core";
import { Manager } from "../src/manager.js";
import { remoteManagerGoalIndexEntries, renewedRegistrationProof } from "../src/remote-authority.js";

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

const proof = `sha256:${"b".repeat(64)}`;
assert.equal(renewedRegistrationProof({ operation: "renew", registrationProof: proof, nextRegistrationProof: proof } as never, proof), proof);
assert.throws(() => renewedRegistrationProof({ operation: "renew", registrationProof: proof, nextRegistrationProof: `sha256:${"c".repeat(64)}` } as never, proof), /did not preserve/);

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
const renewing = new Manager({
  space: "demo", runtime: "pty",
  remoteAuthority: {
    owner, actors: remoteManagerActors(instanceId), instanceId, lifecycleUid: request.managerLifecycleUid, identities,
    supervisorCreds: old.supervisor, executorCreds: old.executor, serveCreds: old.serve,
    goalWriterCreds: old.goal, sessionLedgerCreds: old.session, registrationProof: proof,
    renew: async () => { renewCalls++; await renewGate; return fresh; },
    serveGrant: {} as never, agentBearerExchangeUrl: "https://auth.example.test",
    mintSessionServing: async () => "", mintRetirementRequester: async () => "",
    prepareAgentRetirement: async () => {}, validateRetainedAgent: async () => { throw new Error("not used"); },
    scanGoalIndex: async () => [],
  },
}) as unknown as {
  ep: { reloadCreds(): Promise<unknown> };
  serviceServe: { creds: string; nc: { reconnect(): Promise<void> } };
  goalWriter: { creds: string; nc: { reconnect(): Promise<void> } };
  sessionLedgerConn: { creds: string; nc: { reconnect(): Promise<void> } };
  remoteSupervisorCreds: string;
  remoteExecutorCreds: string;
  goalWriterCreds: string;
  sessionLedgerCreds: string;
  renewRemoteAuthority(): Promise<void>;
  armRemoteAuthorityRenewal(): void;
};
renewing.ep = {
  reloadCreds: async () => { adoption.push("supervisor-reload"); return {}; },
};
renewing.serviceServe = { creds: old.serve, nc: { reconnect: async () => { adoption.push("serve"); } } };
renewing.goalWriter = { creds: old.goal, nc: { reconnect: async () => { adoption.push("goal"); } } };
renewing.sessionLedgerConn = { creds: old.session, nc: { reconnect: async () => { adoption.push("session"); } } };
renewing.goalWriterCreds = old.goal;
renewing.sessionLedgerCreds = old.session;
renewing.armRemoteAuthorityRenewal = () => {};
const firstRenew = renewing.renewRemoteAuthority();
const joinedRenew = renewing.renewRemoteAuthority();
assert.equal(firstRenew, joinedRenew);
assert.equal(renewCalls, 1);
assert.equal(renewing.remoteExecutorCreds, old.executor);
releaseRenew();
await firstRenew;
assert.equal(renewCalls, 1);
assert.equal(renewing.remoteSupervisorCreds, fresh.supervisorCreds);
assert.equal(renewing.remoteExecutorCreds, fresh.executorCreds);
assert.equal(renewing.serviceServe.creds, fresh.serveCreds);
assert.equal(renewing.goalWriter.creds, fresh.goalWriterCreds);
assert.equal(renewing.sessionLedgerConn.creds, fresh.sessionLedgerCreds);
assert.deepEqual(adoption.sort(), ["goal", "serve", "session", "supervisor-reload"]);

console.log("remote authority operations: 10 passed, 0 failed");
