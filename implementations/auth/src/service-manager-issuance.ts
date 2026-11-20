/** The authority plane's manager-service issuance family: the remote Manager's service authority,
 *  the platform supervisor's end, endpoint deregistration and remote Manager maintenance. */
import { drainAndClose } from "@cotal-ai/core";
import { Kvm } from "@nats-io/kv";
import { dialerFor, commitSiblingIssuance, EpEnvelopeError, epAuthBucket, managedRetirementOpId, mintCreds, mintPublicUserJwt, newIdentity, observeHostedRunAttempt, openRecordsBucket, parseEndpointGate, credentialIdOf, reconcileEndpointGate, recordsBucket, remoteManagerActors, remoteManagerServePrincipal, runDriverCaller, serveIssuanceGateKv, standaloneConnectOpts, withIssuerSession, acceptedReadGrant, connectionAcceptedToken, importNativeSubjectPermissions, mintGeneration, writeAcceptedRow, type IssuedAuthorityRef, type IssuerSession, principalKey, provisionEndpointGateOpen, type EpGateState, type RemoteManagerAuthorityRequest, type SpaceAuth, epgateKey, isCasLoss } from "@cotal-ai/core";
import { decodeJwt } from "jose";
import { platformSupervisorEnded } from "./platform-supervisor.js";
import type { managerGateReads } from "./callout-authority.js";
import { authorizeRemoteManagerRenewal, isRenewal, holdsRunFence, issueRemoteManagerAuthority } from "./manager-authority.js";
import { assertCurrentManagerGate, assertCurrentManagerRegistration, remoteManagerCurrentRegistrationProof } from "./retained-manager-validation.js";
import { authorizeRemoteManagerMaintenance, completeRemoteManagerMaintenance } from "./manager-maintenance.js";
import { deregisterUserEndpoint } from "./endpoint-deregister.js";
import { parsePrincipalKey } from "@cotal-ai/core";
import { reconstructRemoteManagerServeGrant, remoteManagerServeGrantFromCluster, type ManagerCluster } from "./manager-contract.js";
import { remoteManagerRegistrationProof, type AuthorityClient, type AuthorityClientOpts } from "./authority-client.js";
import type { AuthLedgerScanner } from "./ledger-scanner.js";
import { makeDeliveryAdminPrincipalOracle } from "./plane-claim.js";
import { makeDeliveryAdminHolderEvictor } from "./barrier-evict.js";
import type { AuthAuthorityPlane } from "./service-plane-types.js";
import type { OpenAuthAuthorityPlaneOptions } from "./service.js";

type RemoteRetirementGate = Pick<EpGateState, "state" | "principal" | "processEpoch">;

/** Package-internal policy step for the hosted retirement requester. The HTTP production door calls
 * this after deriving the owner and manager actors; broker-free smokes exercise the same decision. */
export function authorizeRemoteManagerRetirement(args: {
  owner: string;
  instanceId: string;
  targetOwner: string;
  serveEpoch: number;
  gate: RemoteRetirementGate | null;
}): void {
  if (args.targetOwner !== args.owner)
    throw new EpEnvelopeError("permission-denied", `manager-service retirement may target only its authenticated owner ${args.owner}, not ${args.targetOwner}`);
  assertCurrentManagerGate(args.gate, args.instanceId, args.serveEpoch, args.owner, "manager-service retirement");
}

/** The accepted-row token one platform supervisor duty's issued generation is recorded under. */
function supervisorAcceptedToken(owner: string, instanceId: string, lifecycleUid: string, duty: "supervisor" | "executor"): string {
  return connectionAcceptedToken(`platform-supervisor:${owner}:${instanceId}:${lifecycleUid}:${duty}`);
}

/** The issued generation recorded for one platform supervisor duty, or undefined when none was.
 *  The accepted store is write-once per key, so the first row is the only row. */
async function supervisorGeneration(session: IssuerSession, space: string, owner: string, instanceId: string, lifecycleUid: string, duty: "supervisor" | "executor"): Promise<IssuedAuthorityRef | undefined> {
  const response = await session.nc.request(acceptedReadGrant(space, supervisorAcceptedToken(owner, instanceId, lifecycleUid, duty)), new Uint8Array(0), { timeout: 3000 });
  const status = response.headers?.get("Status");
  if (response.headers?.code === 404 || status?.startsWith("404")) return undefined;
  if (status) throw new EpEnvelopeError("unavailable", "platform supervisor accepted-row read failed");
  const accepted = JSON.parse(new TextDecoder().decode(response.data)) as { version: number; ref: IssuedAuthorityRef };
  if (accepted.version !== 1 || accepted.ref.space !== space || accepted.ref.owner !== owner || accepted.ref.actor !== remoteManagerActors(instanceId)[duty] || accepted.ref.uid !== lifecycleUid)
    throw new EpEnvelopeError("permission-denied", "platform supervisor accepted row names another owner or lifecycle");
  return accepted.ref;
}

/** What managerIssuanceAuthority reads from the authority-plane closure. Each is a closure constant
 *  or parameter bound once before the plane's operations are built, never reassigned. */
export interface ManagerIssuanceDeps {
  server: OpenAuthAuthorityPlaneOptions["server"];
  space: OpenAuthAuthorityPlaneOptions["space"];
  dataAccount: OpenAuthAuthorityPlaneOptions["dataAccount"];
  log: OpenAuthAuthorityPlaneOptions["log"];
  standingTtl: number;
  remoteIssuer: AuthorityClient;
  scanner: AuthLedgerScanner;
  authKv: Awaited<ReturnType<Kvm["open"]>>;
  managerIssuanceGate: (instanceId: string) => ReturnType<typeof serveIssuanceGateKv>;
  observeManagerGate: ReturnType<typeof managerGateReads>["observeManagerGate"];
  observeLegacyManagerGate: ReturnType<typeof managerGateReads>["observeLegacyManagerGate"];
  registeredManagerCluster: (owner: string, instanceId: string, observed: { registrationRevision: number }) => Promise<ManagerCluster>;
  refuseIfFenced: () => void;
  issuerAuth: () => SpaceAuth;
  onConnection: AuthorityClientOpts["onConnection"] | undefined;
}

/** The plane's manager-service issuance, platform-supervisor end, endpoint deregistration and remote
 *  Manager maintenance operations, over the closure's deps. */
export function managerIssuanceAuthority(deps: ManagerIssuanceDeps): Pick<AuthAuthorityPlane, "issueManagerServiceAuthority" | "endPlatformSupervisor" | "deregisterEndpoint" | "maintainRemoteManager"> {
  const { server, space, dataAccount, log, standingTtl, remoteIssuer, scanner, authKv, managerIssuanceGate, observeManagerGate, observeLegacyManagerGate, registeredManagerCluster, refuseIfFenced, issuerAuth, onConnection } = deps;
  return {
    issueManagerServiceAuthority: async (holder) => {
      refuseIfFenced();
      const { owner } = holder;
      // The ended-assignment fence (SPEC 13.16): read on every call, before anything is signed. The
      // retired gate and the retired generations are terminal rows, so no host view reopens them.
      if (holder.supervisorExpiresAt !== undefined) {
        const gate = await observeLegacyManagerGate(holder.request.instanceId);
        if (gate?.state === "retired") throw platformSupervisorEnded(owner);
        await withIssuerSession({ servers: server, space, auth: issuerAuth(), tls: false }, async (session) => {
          for (const duty of ["supervisor", "executor"] as const) {
            const ref = await supervisorGeneration(session, space, owner, holder.request.instanceId, holder.request.managerLifecycleUid, duty);
            if (ref === undefined) continue;
            try {
              await session.store.resolve(ref, session.sourceIsLive);
            } catch (error) {
              throw platformSupervisorEnded(owner, error instanceof Error ? error.message : String(error));
            }
          }
        });
      }
      const observeManagerRun = async (r: RemoteManagerAuthorityRequest, runId: string) => observeHostedRunAttempt(
        await openRecordsBucket(remoteIssuer.nc, space), "manager", runId,
        { supervisorId: r.identities.supervisor.id, instanceId: r.instanceId },
      );
      const material = await issueRemoteManagerAuthority({
        ...holder,
        authorizeRenewal: ({ owner: o, request: r }) => authorizeRemoteManagerRenewal({
          request: r, owner: o, space, accountPublicKey: dataAccount.pub, proofSecret: dataAccount.signingSeed,
          observeManagerGate: observeLegacyManagerGate,
          observeRun: (runId) => observeManagerRun(r, runId),
        }),
        issue: async ({ actors, request: r }) => {
          const existing = await observeLegacyManagerGate(r.instanceId);
          if (r.operation === "prepare" && existing === null) {
            await provisionEndpointGateOpen(authKv, {
              endpoint: "manager", instanceId: r.instanceId, principal: remoteManagerServePrincipal(owner, r.instanceId),
            });
          }
          const bounded = (opts: Parameters<typeof mintPublicUserJwt>[3]) => {
            if (holder.supervisorExpiresAt === undefined) return opts;
            const now = Math.floor(Date.now() / 1000);
            if (holder.supervisorExpiresAt <= now)
              throw new EpEnvelopeError("permission-denied", `platform supervisor lifecycle has ended for owner ${owner}`);
            const { expiresInSeconds, expiresAt, ...rest } = opts ?? {};
            return { ...rest, expiresAt: Math.min(holder.supervisorExpiresAt, expiresAt ?? now + (expiresInSeconds ?? standingTtl)) };
          };
          const registration = { space: r.space, instanceId: r.instanceId, lifecycleUid: r.managerLifecycleUid, identities: r.identities };
          const credential = async (
            key: keyof RemoteManagerAuthorityRequest["identities"],
            profile: Parameters<typeof mintPublicUserJwt>[2],
            actor: string,
            opts: Parameters<typeof mintPublicUserJwt>[3],
          ) => mintPublicUserJwt(
            issuerAuth(),
            r.identities[key].id,
            profile,
            bounded({ ...opts, principal: { owner, actor }, lifecycleUid: r.managerLifecycleUid }),
          );
          const credentials: import("@cotal-ai/core").RemoteManagerAuthorityMaterial["credentials"] = {};
          const siblingOn = (gate: ReturnType<typeof serveIssuanceGateKv>, observed: EpGateState) => async (key: "goalWriter" | "sessionLedger", profile: "goal-writer" | "session-ledger", actor: string) => {
            const issued = await credential(key, profile, actor, profile === "goal-writer" ? { goalWriter: { endpoint: "manager" }, expiresInSeconds: standingTtl } : { expiresInSeconds: standingTtl });
            await commitSiblingIssuance(gate, observed, {
              credentialId: credentialIdOf(issued.jwt),
              credentialKey: r.identities[key].id,
              holderPrincipal: `${owner}.${actor}`,
              endpoint: "manager",
              lifecycleUid: r.instanceId,
              sourceChain: ["root"],
              state: "active",
              exp: issued.exp,
              generation: observed.generation,
              processEpoch: observed.processEpoch,
              registrationRevision: observed.registrationRevision,
              nameAuthorityRevision: observed.nameAuthorityRevision,
            });
            return issued;
          };
          if (r.operation === "renew") {
            // `renew` carries no epoch on the wire, so its staleness is the proof's to refuse.
            const gate = managerIssuanceGate(r.instanceId);
            await assertCurrentManagerRegistration(r, undefined, {
              owner, proofSecret: dataAccount.signingSeed, observeManagerGate: async () => await gate.observe(),
            }, "manager-service renewal");
          }
          if (r.operation === "prepare" || r.operation === "renew") {
            credentials.supervisor = await credential("supervisor", "remote-manager", actors.supervisor, {
              remoteManager: { instanceId: r.instanceId, owner, actor: actors.supervisor },
              expiresInSeconds: standingTtl,
            });
            // The executor receives the exact instance-scoped registration/maintenance surface under
            // a separate nkey and bounded five-minute lifetime. The participant retains it for the
            // immediate goalidx boot sweep and clean service deregistration, and renews it in place
            // before maintenance or deregistration once its retained credential is unhealthy.
            credentials.executor = await credential("executor", "remote-manager", actors.executor, {
              remoteManager: { instanceId: r.instanceId, owner, actor: actors.executor },
              expiresInSeconds: 5 * 60,
            });
          }
          if (r.operation === "session") {
            const expectedProof = remoteManagerRegistrationProof(owner, registration);
            if (r.registrationProof !== expectedProof)
              throw new EpEnvelopeError("permission-denied", "manager-service session proof does not match this owner/lifecycle");
            const session = r.session!;
            const exp = Math.min(session.exp, Math.floor(Date.now() / 1000) + 24 * 60 * 60);
            credentials.sessionServing = await mintPublicUserJwt(
              issuerAuth(),
              session.id,
              "session-serving",
              {
                principal: { owner, actor: actors.serve },
                lifecycleUid: r.managerLifecycleUid,
                sessionServing: { endpoint: "manager", sessionId: session.sessionId, epoch: session.epoch },
                expiresAt: exp,
              },
            );
            return { credentials };
          }
          if (r.operation === "transferReader") {
            const expectedProof = remoteManagerRegistrationProof(owner, registration);
            if (r.registrationProof !== expectedProof)
              throw new EpEnvelopeError("permission-denied", "manager-service transfer reader proof does not match this owner/lifecycle");
            credentials.transferReader = await mintPublicUserJwt(
              issuerAuth(),
              r.transferReader!.id,
              "transfer-reader",
              { principal: { owner, actor: actors.serve }, lifecycleUid: r.managerLifecycleUid, transferReader: { instanceId: r.instanceId } },
            );
            return { credentials };
          }
          if (r.operation === "retire") {
            const expectedProof = remoteManagerRegistrationProof(owner, registration);
            if (r.registrationProof !== expectedProof)
              throw new EpEnvelopeError("permission-denied", "manager-service retirement proof does not match this owner/lifecycle");
            const retirement = r.retirement!;
            const gate = managerIssuanceGate(r.instanceId);
            const observed = await gate.observe();
            authorizeRemoteManagerRetirement({
              owner, instanceId: r.instanceId,
              targetOwner: retirement.target.owner, serveEpoch: retirement.serveEpoch, gate: observed,
            });
            credentials.retirementRequester = await mintPublicUserJwt(
              issuerAuth(),
              retirement.id,
              "retirement-requester",
              {
                principal: { owner, actor: actors.serve },
                lifecycleUid: r.managerLifecycleUid,
                retirementRequester: {
                  owner,
                  actor: actors.serve,
                  uid: r.managerLifecycleUid,
                  target: retirement.target,
                },
              },
            );
            return { credentials };
          }
          if (isRenewal(r.operation)) {
            // authorizeRenewal fresh-checked account, owner, epoch and the current-registration proof.
            // Re-observe once so both renewals issue against that same gate.
            const gate = managerIssuanceGate(r.instanceId);
            const observed = await gate.observe();
            if (!observed || observed.state !== "open" || observed.processEpoch !== r.processEpoch)
              throw new EpEnvelopeError("conflict", "manager-service renewal gate moved before issuance");
            if (r.operation === "renewStandingBundle") {
              credentials.supervisor = await credential("supervisor", "remote-manager", actors.supervisor, {
                remoteManager: { instanceId: r.instanceId, owner, actor: actors.supervisor },
                expiresInSeconds: standingTtl,
              });
              credentials.executor = await credential("executor", "remote-manager", actors.executor, {
                remoteManager: { instanceId: r.instanceId, owner, actor: actors.executor },
                expiresInSeconds: 5 * 60,
              });
              credentials.serve = await mintPublicUserJwt(
                issuerAuth(),
                r.identities.serve.id,
                "endpoint-serve",
                bounded({
                  principal: { owner, actor: actors.serve },
                  lifecycleUid: r.managerLifecycleUid,
                  expiresInSeconds: standingTtl,
                  endpointServe: remoteManagerServeGrantFromCluster(r, owner, await registeredManagerCluster(owner, r.instanceId, observed), observed),
                  serveIssuance: gate,
                }),
              );
              const sibling = siblingOn(gate, observed);
              credentials.goalWriter = await sibling("goalWriter", "goal-writer", actors.goalWriter);
              credentials.sessionLedger = await sibling("sessionLedger", "session-ledger", actors.sessionLedger);
              return { credentials };
            }
            if (r.operation === "renewRunDriver") {
              if (!holdsRunFence(await observeManagerRun(r, r.run!.runId), r))
                throw new EpEnvelopeError("conflict", "manager-service run renewal authority moved before issuance");

              const caller = runDriverCaller(r.run!.runId, owner);
              const binding = {
                endpoint: "manager",
                runId: r.run!.runId,
                takeoverId: r.run!.takeoverId,
                instanceId: r.instanceId,
                epoch: r.run!.epoch,
                owner,
              };
              credentials.runDriver = await mintPublicUserJwt(issuerAuth(), r.run!.driverId, "run-driver", bounded({
                principal: { owner, actor: caller.actor },
                lifecycleUid: r.managerLifecycleUid,
                runDriver: binding,
                expiresInSeconds: standingTtl,
              }));
              credentials.runMediator = await mintPublicUserJwt(issuerAuth(), r.run!.mediatorId, "run-mediator", bounded({
                principal: { owner, actor: caller.actor },
                lifecycleUid: r.managerLifecycleUid,
                // Renewed with the placement the attempt was issued with (authorizeRemoteRunAttempt).
                runMediator: { ...binding, placement: { instanceId: r.instanceId } },
                expiresInSeconds: standingTtl,
              }));
              return { credentials };
            }
          }
          if (r.operation === "activate") {
            const expectedProof = remoteManagerRegistrationProof(owner, registration, r.contractArtifacts);
            if (r.registrationProof !== expectedProof)
              throw new EpEnvelopeError("permission-denied", "manager-service registration proof does not match this owner/lifecycle/artifact set");
            // The serve JWT is issued from the registered-surface snapshot the participant
            // returned from the branded local core path. That brand is process-local and cannot
            // cross HTTP, so the host independently validates the deterministic proof + canonical
            // artifact set and scopes the JWT to the already-registered instance rails. The grant
            // rows are reconstructed from the canonical manager command set by the host protocol.
            const gate = managerIssuanceGate(r.instanceId);
            const observed = await gate.observe();
            if (!observed) throw new EpEnvelopeError("failed-precondition", "manager-service activation found no issuance gate");
            credentials.serve = await mintPublicUserJwt(
              issuerAuth(),
              r.identities.serve.id,
              "endpoint-serve",
              bounded({
                principal: { owner, actor: actors.serve },
                lifecycleUid: r.managerLifecycleUid,
                expiresInSeconds: standingTtl,
                endpointServe: reconstructRemoteManagerServeGrant(r, owner, observed),
                serveIssuance: gate,
              }),
            );
            const sibling = siblingOn(gate, observed);
            credentials.goalWriter = await sibling("goalWriter", "goal-writer", actors.goalWriter);
            credentials.sessionLedger = await sibling("sessionLedger", "session-ledger", actors.sessionLedger);
            return {
              credentials,
              nextRegistrationProof: remoteManagerCurrentRegistrationProof(dataAccount.signingSeed, owner, r, {
                registrationRevision: observed.registrationRevision,
                processEpoch: observed.processEpoch,
              }),
            };
          }
          return { credentials };
        },
      });
      const supervisorExpiresAt = holder.supervisorExpiresAt;
      if (supervisorExpiresAt !== undefined) {
        await withIssuerSession({ servers: server, space, auth: issuerAuth(), tls: false }, async (session) => {
          for (const duty of ["supervisor", "executor"] as const) {
            const credential = material.credentials[duty];
            if (!credential) continue;
            const payload = decodeJwt(credential.jwt) as { nats?: Record<string, unknown>; sub?: string };
            const permissions = importNativeSubjectPermissions({ pub: payload.nats?.pub, sub: payload.nats?.sub });
            const actor = remoteManagerActors(holder.request.instanceId)[duty as keyof ReturnType<typeof remoteManagerActors>];
            if (!actor || payload.sub !== holder.request.identities[duty as keyof RemoteManagerAuthorityRequest["identities"]]?.id)
              throw new EpEnvelopeError("internal", "platform supervisor issued a duty outside its fixed standing identities");
            const acceptedToken = supervisorAcceptedToken(owner, holder.request.instanceId, holder.request.managerLifecycleUid, duty);
            const existing = await supervisorGeneration(session, space, owner, holder.request.instanceId, holder.request.managerLifecycleUid, duty);
            if (existing === undefined) {
              const ref = { space, owner, actor, uid: holder.request.managerLifecycleUid, generation: mintGeneration(supervisorExpiresAt) };
              const prepared = await session.store.stage({ version: 1, ref, sources: [], permissions, expiresAt: supervisorExpiresAt });
              await session.store.release(prepared, async () => {});
              await writeAcceptedRow(session.accepted, acceptedToken, ref);
            } else {
              await session.store.resolve(existing, session.sourceIsLive);
              await session.store.confirm(existing, permissions);
            }
          }
        });
      }
      return material;
    },
    endPlatformSupervisor: async ({ owner, instanceId, lifecycleUid }) => {
      refuseIfFenced();
      await observeLegacyManagerGate(instanceId);
      // Retire the issued generations first, then the gate. Each step is idempotent, so a retry after
      // a partial end completes it. The retired gate alone refuses a lifecycle that issued nothing.
      await withIssuerSession({ servers: server, space, auth: issuerAuth(), tls: false }, async (session) => {
        for (const duty of ["supervisor", "executor"] as const) {
          const ref = await supervisorGeneration(session, space, owner, instanceId, lifecycleUid, duty);
          if (ref !== undefined) await session.store.retire(ref);
        }
      });
      const key = epgateKey("manager", instanceId);
      const opId = managedRetirementOpId(lifecycleUid);
      for (let attempt = 0; attempt < 4; attempt++) {
        const entry = await authKv.get(key);
        if (entry === null) {
          // No gate yet: create it retired, so a later registration finds the terminal row.
          const row = { state: "retired", generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0, principal: remoteManagerServePrincipal(owner, instanceId), op: { opId, kind: "retirement" } };
          parseEndpointGate(new TextEncoder().encode(JSON.stringify(row)), key);
          try { await authKv.create(key, new TextEncoder().encode(JSON.stringify(row))); return; }
          catch (error) { if (isCasLoss(error)) continue; throw error; }
        }
        if (entry.operation !== "PUT")
          throw new EpEnvelopeError("failed-precondition", `the manager gate ${key} carries a ${entry.operation} marker; a gate is never deleted (SPEC 13.12)`);
        const row = parseEndpointGate(entry.value, key);
        if (row.authorityFamily === "environment-manager")
          throw new EpEnvelopeError("permission-denied", `manager instance ${instanceId} belongs to the environment-manager authority family`);
        if (row.principal !== remoteManagerServePrincipal(owner, instanceId))
          throw new EpEnvelopeError("permission-denied", `the manager gate ${key} belongs to ${row.principal}, not owner ${owner}`);
        if (row.state === "retired") return;
        const { op: _op, ...rest } = row;
        void _op;
        try {
          await authKv.update(key, new TextEncoder().encode(JSON.stringify({ ...rest, state: "retired", op: { opId, kind: "retirement" } })), entry.revision);
          return;
        } catch (error) {
          if (!isCasLoss(error)) throw error;
        }
      }
      throw new EpEnvelopeError("conflict", `ending the platform supervisor of ${owner} lost repeated CAS attempts on ${key}; retry`);
    },
    deregisterEndpoint: async (request, granter) => {
      refuseIfFenced();
      return deregisterUserEndpoint({ request, granter, space, server, auth: issuerAuth(), observeGate: observeManagerGate, onConnection });
    },
    maintainRemoteManager: async (holder) => {
      refuseIfFenced();
      const { owner } = holder;
      await observeLegacyManagerGate(holder.request.instanceId);
      const authorized = await authorizeRemoteManagerMaintenance({
        ...holder,
        space,
        scanner,
        observeManagerGate: observeLegacyManagerGate,
      });
      const evictHolders = makeDeliveryAdminHolderEvictor({ onConnection, space, server, dataAccount, log });
      if (authorized.operation === "evict-family-principal") {
        const evictions = await evictHolders(authorized.principals!);
        return completeRemoteManagerMaintenance(authorized, owner, { evictions });
      }
      if (authorized.operation !== "reconcile-registration") {
        const unhandled: never = authorized.operation;
        throw new EpEnvelopeError("internal", `manager maintenance has no host effect for operation ${unhandled}`);
      }
      const principalOracle = makeDeliveryAdminPrincipalOracle({ onConnection, space, server, dataAccount, log });
      const executorIdentity = newIdentity();
      const executorCreds = await mintCreds(issuerAuth(), executorIdentity, "endpoint-serve-executor", {
        endpointServeExecutor: { endpoint: "manager", instanceId: authorized.targetInstanceId },
        expiresInSeconds: 60,
      });
      const maintenanceNc = await dialerFor(server)({
        servers: server,
        ...standaloneConnectOpts({ creds: executorCreds, tls: false }),
        maxReconnectAttempts: 0,
      });
      onConnection?.(maintenanceNc, `cotal:remote-manager-maintenance:${space}`);
      let report;
      try {
        const maintenanceKvm = new Kvm(maintenanceNc);
        report = await reconcileEndpointGate({
          kv: await maintenanceKvm.open(epAuthBucket(space)),
          recordsKv: await maintenanceKvm.open(recordsBucket(space)),
          space,
          endpoint: "manager",
          instanceId: authorized.targetInstanceId,
          probeHolder: async (principal) => {
            const result = await principalOracle(principal);
            return { state: result.state, detail: result.note ?? `delivery-daemon principal sweep, sweepComplete=${String(result.sweepComplete)}` };
          },
          probeRegistrationExecutor: async (holderPrincipal) => {
            const target = parsePrincipalKey(holderPrincipal);
            if (!target || holderPrincipal !== remoteManagerServePrincipal(target.owner, authorized.targetInstanceId))
              return { state: "unestablishable", detail: "the target gate does not name its canonical remote Manager serve principal" };
            const principal = principalKey(target.owner, remoteManagerActors(authorized.targetInstanceId).executor).key;
            const result = await principalOracle(principal);
            return { state: result.state, detail: `${principal}: ${result.note ?? `delivery-daemon principal sweep, sweepComplete=${String(result.sweepComplete)}`}` };
          },
          evictHolders: async (holders) => (await evictHolders(holders)).map((e) => e.verifiedGone),
          log,
        });
      } finally {
        await drainAndClose(maintenanceNc);
      }
      return completeRemoteManagerMaintenance(authorized, owner, { reconciliation: report });
    },
  };
}
