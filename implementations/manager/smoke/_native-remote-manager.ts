import { mintLifecycleUid, type RemoteManagerAuthorityMaterial } from "@cotal-ai/core";
import { Manager, managerClusterArtifacts, registerRemoteManagerAuthority, remoteManagerClient as r, type ManagerOptions } from "../dist/index.js";
import { remoteManagerRegistrationProof } from "../../auth/src/authority-client.js";

/** Test composition only. Every duty/callback reaches the real auth-service protocol. */
export async function nativeRemoteManager(args: {
  space: string; servers: string; root: string; exchangeUrl: string;
  execution: "runtime" | "none";
  call: (request: any) => Promise<any>;
}) {
  const state = r.loadOrCreateRemoteManagerIdentity(args.root, args.space);
  const prepared: RemoteManagerAuthorityMaterial = await args.call(r.remoteManagerAuthorityRequest(state, "cli", "prepare"));
  const owner = prepared.owner;
  const registered = await registerRemoteManagerAuthority({ space: args.space, server: args.servers, owner, instanceId: state.instanceId, serveActor: prepared.actors.serve,
    prepareCreds: r.materialCredential(prepared, "executor", state.identities.executor), tlsRequired: false,
    evict: async (principals) => {
      const q = r.remoteManagerMaintenanceRequest(state, "cli", "evict-family-principal", state.instanceId, [...principals]);
      return r.remoteManagerMaintenanceResult(await args.call(q), q, owner).evictions!.map((e) => e.verifiedGone);
    } });
  const artifacts = managerClusterArtifacts(), contractArtifacts = [artifacts.document, artifacts.manifest];
  const active: RemoteManagerAuthorityMaterial = await args.call(r.remoteManagerAuthorityRequest(state, "cli", "activate", { registrationProof: remoteManagerRegistrationProof(owner, state, contractArtifacts), contractArtifacts }));
  const proof = r.currentRegistrationProof(active), epoch = registered.processEpoch;
  const supervisorCreds = r.materialCredential(prepared, "supervisor", state.identities.supervisor);
  const standing = r.remoteStandingBundleRenewal({ state, owner, registrationProof: proof, supervisorCreds, call: args.call });
  const remote: NonNullable<ManagerOptions["remoteAuthority"]> = {
    ...standing, owner, actors: active.actors, instanceId: state.instanceId, lifecycleUid: state.lifecycleUid, identities: state.identities,
    supervisorCreds, executorCreds: r.materialCredential(prepared, "executor", state.identities.executor), serveCreds: r.materialCredential(active, "serve", state.identities.serve), goalWriterCreds: r.materialCredential(active, "goalWriter", state.identities.goalWriter), sessionLedgerCreds: r.materialCredential(active, "sessionLedger", state.identities.sessionLedger), serveGrant: registered.serveGrant,
    agentBearerExchangeUrl: args.exchangeUrl,
    renewExecutor: async () => r.materialCredential(await args.call(r.remoteManagerAuthorityRequest(state, "cli", "renew", { registrationProof: proof })), "executor", state.identities.executor),
    mintSessionServing: async (a) => r.materialCredential(await args.call(r.remoteManagerAuthorityRequest(state, "cli", "session", { registrationProof: remoteManagerRegistrationProof(owner, state), session: { id: a.identity.id, endpoint: a.endpoint, sessionId: a.sessionId, epoch: a.epoch, exp: a.exp } })), "sessionServing", a.identity),
    mintRetirementRequester: async (a) => r.materialCredential(await args.call(r.remoteManagerAuthorityRequest(state, "cli", "retire", { registrationProof: remoteManagerRegistrationProof(owner, state), retirement: { id: a.identity.id, target: a.target, opId: a.opId, serveEpoch: a.serveEpoch } })), "retirementRequester", a.identity),
    prepareAgentRetirement: async (a) => { const q = r.remoteManagedAgentPrepareRetirementRequest(state, "cli", proof, epoch, a.target, a.opId); r.remoteManagedAgentRetirementPrepared(await args.call(q), q); },
    validateRetainedAgent: async (a) => { const q = r.remoteRetainedAgentValidationRequest(state, "cli", proof, epoch, a, a.actorToken, a.sentinelCreds); return r.retainedAgentAuthority(await args.call(q), q); },
    enrollManagedAgent: async ({ target }) => { const q = r.remoteManagedAgentEnrollmentRequest(state, "cli", proof, epoch, target); return r.remoteManagedAgentEnrollmentMaterial(await args.call(q), q); },
    authorizeAdmin: async (caller) => { const q = r.remoteManagerAdminAuthorizationRequest(state, "cli", proof, epoch, caller); return r.remoteManagerAdminAuthorized(await args.call(q), q, owner); },
    scanGoalIndex: async () => { const q = { v: 1 as const, kind: "manager-goal-index-scan" as const, space: args.space, actor: "cli", instanceId: state.instanceId, managerLifecycleUid: state.lifecycleUid, requestId: `scan${mintLifecycleUid()}`, registrationProof: proof, serveEpoch: epoch, identities: r.publicIdentities(state) }; return r.remoteManagerGoalIndexEntries(await args.call(q), q, owner); },
    ...(args.execution === "runtime" ? { runHosting: r.remoteRunHosting({ state, owner, registrationProof: proof, accountPublicKey: standing.accountPublicKey, processEpoch: epoch, requestRunAdmission: args.call, requestRunAttempt: args.call, requestRunRevoke: args.call, call: args.call }) } : {}),
  };
  const manager = new Manager({ space: args.space, servers: args.servers, workspaceRoot: args.root, execution: args.execution,
    ...(args.execution === "none" ? { pooled: true } : { runtime: "pty" }), remoteAuthority: remote });
  await manager.start();
  return { manager, state, owner, epoch, remote };
}
