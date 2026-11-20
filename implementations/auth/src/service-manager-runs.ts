/** The authority plane's manager-run family: the goal-index scan, admin and participation authorization,
 *  run submission, admission, cancellation and revocation, and run-attempt issuance. */
import { drainAndClose } from "@cotal-ai/core";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { dialerFor, admissionBucket, EpEnvelopeError, mintCreds, mintPublicUserJwt, newIdentity, newTakeoverId, openRecordsBucket, readCheckpointStatus, readRunAdmission, readRunRevocation, readRunRecord, replayRunJournal, runDriverCaller, standaloneConnectOpts, withIssuerSession, parseActorLedgerSource, type IssuedSourceRef, type IssuerSession, type SpaceAuth } from "@cotal-ai/core";
import { requireManagerAuthorityHolder } from "./platform-control.js";
import { handleRemoteRunCancel, parseRemoteRunCancelRequest, admitRemoteRun, handleRemoteRunSubmission, authorizeRemoteRunAttempt, parseRemoteRunAdmissionRequest, parseRemoteRunAttemptRequest, parseRemoteRunRevokeRequest, revokeRemoteRun, type ObservedRunRequest } from "./manager-authority.js";
import { authorizeRemoteManagerGoalIndexScan, completeRemoteManagerGoalIndexScan } from "./manager-goal-index.js";
import { authorizeRemoteManagerAdmin } from "./manager-admin-authorization.js";
import { authorizeRemoteManagerParticipation } from "./manager-participation-authorization.js";
import { remoteManagerSurface } from "./manager-contract.js";
import { readLifecycleHeadForOperation, type LifecycleRegistry } from "./lifecycle-registry.js";
import type { RunCancelObservations } from "./run-cancel-observation.js";
import { findActorUnified } from "./ledger.js";
import { readCancellationAdmission, type RunDelegation } from "@cotal-ai/core";
import type { managerGateReads } from "./callout-authority.js";
import type { AuthorityClient, AuthorityClientOpts } from "./authority-client.js";
import type { RecordsScanner } from "./records-scanner.js";
import type { ManagerCluster } from "./manager-contract.js";
import type { AuthAuthorityPlane } from "./service-plane-types.js";
import type { OpenAuthAuthorityPlaneOptions } from "./service.js";

/** What managerRunAuthority reads from the authority-plane closure. Each is a closure constant
 *  or parameter bound once before the plane's operations are built, never reassigned. */
export interface ManagerRunDeps {
  server: OpenAuthAuthorityPlaneOptions["server"];
  space: OpenAuthAuthorityPlaneOptions["space"];
  dataAccount: OpenAuthAuthorityPlaneOptions["dataAccount"];
  cancelObservations: RunCancelObservations;
  standingTtl: number;
  remoteIssuer: AuthorityClient;
  recordsScanner: RecordsScanner;
  barrierReg: LifecycleRegistry;
  recordsJsm: Awaited<ReturnType<typeof jetstreamManager>>;
  observeManagerGate: ReturnType<typeof managerGateReads>["observeManagerGate"];
  observeLegacyManagerGate: ReturnType<typeof managerGateReads>["observeLegacyManagerGate"];
  registeredManagerCluster: (owner: string, instanceId: string, observed: { registrationRevision: number }) => Promise<ManagerCluster>;
  refuseIfFenced: () => void;
  issuerAuth: () => SpaceAuth;
  composedSourceIsLive: (session: IssuerSession) => (source: IssuedSourceRef) => Promise<boolean>;
  ledgerDelegation: (owner: string, actor: string) => RunDelegation | undefined;
  takeObservedRunRequest: (subject: string) => Promise<ObservedRunRequest | undefined>;
  opts: OpenAuthAuthorityPlaneOptions;
  onConnection: AuthorityClientOpts["onConnection"] | undefined;
}

/** The plane's manager run operations (goal-index scan, admin and participation authorization, run
 *  submit, admit, cancel and revoke, and run-attempt issuance), over the closure's deps. */
export function managerRunAuthority(deps: ManagerRunDeps): Pick<AuthAuthorityPlane, "scanManagerGoalIndex" | "authorizeManagerAdmin" | "authorizeManagerParticipation" | "submitManagerRun" | "admitManagerRun" | "cancelManagerRun" | "revokeManagerRun" | "issueManagerRunAttempt"> {
  const { server, space, dataAccount, cancelObservations, standingTtl, remoteIssuer, recordsScanner, barrierReg, recordsJsm, observeLegacyManagerGate, registeredManagerCluster, refuseIfFenced, issuerAuth, composedSourceIsLive, ledgerDelegation, takeObservedRunRequest, opts, onConnection } = deps;
  return {
    scanManagerGoalIndex: async (holder) => {
      refuseIfFenced();
      const { owner } = holder;
      const authorized = await authorizeRemoteManagerGoalIndexScan({
        ...holder, proofSecret: dataAccount.signingSeed, space,
        observeManagerGate: observeLegacyManagerGate,
      });
      return completeRemoteManagerGoalIndexScan(authorized, owner, await recordsScanner.scanManagerGoalIndex(owner));
    },
    authorizeManagerAdmin: async ({ request, ...holder }) => {
      refuseIfFenced();
      return authorizeRemoteManagerAdmin({
        managerOwner: holder.owner,
        ...(holder.holder === "platform" ? { managerAssignment: holder.assignment } : { managerScope: holder.scope }),
        proofSecret: dataAccount.signingSeed,
        space,
        dir: opts.dir,
        request,
        observeManagerGate: observeLegacyManagerGate,
      });
    },
    authorizeManagerParticipation: async ({ request, ...holder }) => {
      refuseIfFenced();
      if (holder.holder === "platform") throw new EpEnvelopeError("permission-denied", "manager participation authorization requires a human owner holder");
      return authorizeRemoteManagerParticipation({
        managerOwner: holder.owner, managerScope: holder.scope, proofSecret: dataAccount.signingSeed,
        space, request, dir: opts.dir, observeManagerGate: observeLegacyManagerGate,
        readLifecycle: (owner, actor) => readLifecycleHeadForOperation(barrierReg, owner, actor),
      });
    },
    submitManagerRun: async ({ request, ...holder }) => {
      refuseIfFenced();
      const { owner } = holder;
      requireManagerAuthorityHolder(holder, String((request as { instanceId?: unknown })?.instanceId), 'keyed run submission needs scope "supervise"');
      return withIssuerSession({ servers: server, space, auth: issuerAuth(), tls: false }, session => handleRemoteRunSubmission({
        request, owner, space, accountPublicKey: dataAccount.pub, proofSecret: dataAccount.signingSeed, endpoint: "manager",
        observeManagerGate: observeLegacyManagerGate, issued: session.store, sourceIsLive: composedSourceIsLive(session),
        takeObserved: takeObservedRunRequest,
        delegationOf: ledgerDelegation,
        registeredCommand: async (instanceId, registrationRevision, command) => {
          const registered = remoteManagerSurface(await registeredManagerCluster(owner, instanceId, { registrationRevision }))[command];
          if (!registered) throw new EpEnvelopeError("failed-precondition", "registered manager has no keyed contract");
          return registered;
        },
        withStore: async (runId, submission, work) => {
          const nc = await dialerFor(server)({ servers: server, ...standaloneConnectOpts({
            creds: await mintCreds(issuerAuth(), newIdentity(), "run-admitter", { runAdmitter: { endpoint: "manager", runId, submission }, expiresInSeconds: 60 }), tls: false,
          }), maxReconnectAttempts: 0 });
          onConnection?.(nc, `cotal:keyed-admitter:${space}`);
          try { return await work(await new Kvm(nc).open(admissionBucket(space)), await jetstreamManager(nc)); }
          finally { await drainAndClose(nc); }
        },
      }));
    },
    admitManagerRun: async ({ request, ...holder }) => {
      refuseIfFenced();
      const { owner } = holder;
      requireManagerAuthorityHolder(holder, String((request as { instanceId?: unknown })?.instanceId), 'manager run admission needs scope "supervise"; spawn/admin do not imply it');
      const parsed = parseRemoteRunAdmissionRequest(request);
      await observeLegacyManagerGate(parsed.instanceId);
      const runId = parsed.run.runId;
      return withIssuerSession({ servers: server, space, auth: issuerAuth(), tls: false }, async (session) => {
        const admitterNc = await dialerFor(server)({
          servers: server,
          ...standaloneConnectOpts({
            creds: await mintCreds(issuerAuth(), newIdentity(), "run-admitter", { runAdmitter: { endpoint: "manager", runId }, expiresInSeconds: 60 }),
            tls: false,
          }),
          maxReconnectAttempts: 0,
        });
        onConnection?.(admitterNc, `cotal:run-admitter:${space}`);
        try {
          return await admitRemoteRun({
            request, owner, space, accountPublicKey: dataAccount.pub, proofSecret: dataAccount.signingSeed, endpoint: "manager",
            observeManagerGate: observeLegacyManagerGate,
            issued: session.store,
            sourceIsLive: composedSourceIsLive(session),
            takeObserved: takeObservedRunRequest,
            delegationOf: ledgerDelegation,
            admissions: await new Kvm(admitterNc).open(admissionBucket(space)),
          });
        } finally {
          await drainAndClose(admitterNc);
        }
      });
    },
    cancelManagerRun: async ({ request, ...holder }) => {
      refuseIfFenced();
      const req = parseRemoteRunCancelRequest(request);
      requireManagerAuthorityHolder(holder, req.instanceId, 'manager run cancellation needs scope "supervise"');
      return withIssuerSession({ servers: server, space, auth: issuerAuth(), tls: false }, session => handleRemoteRunCancel({
        request: req, owner: holder.owner, space, endpoint: "manager", accountPublicKey: dataAccount.pub,
        proofSecret: dataAccount.signingSeed, observeManagerGate: observeLegacyManagerGate,
        observations: cancelObservations, flush: () => remoteIssuer.nc.flush(), assertServing: refuseIfFenced,
        issued: session.store, sourceIsLive: composedSourceIsLive(session),
        interactiveScope: async (caller, sources) => {
          if (sources.length !== 1 || sources[0]!.space !== space) return undefined;
          const source = parseActorLedgerSource(sources[0]!);
          if (!source || source.owner !== caller.owner || source.actor !== caller.actor || source.lifecycleUid !== caller.uid) return undefined;
          const row = findActorUnified(opts.dir, caller.owner, caller.actor);
          return row?.kind === "interactive" && row.lifecycleUid === caller.uid ? [...row.scope] : undefined;
        },
        registeredCommand: async (instanceId, registrationRevision, command) => {
          const registered = remoteManagerSurface(await registeredManagerCluster(holder.owner, instanceId, { registrationRevision }))[command];
          if (!registered) throw new EpEnvelopeError("failed-precondition", "registered manager has no run-cancel contract");
          return registered;
        },
        readAdmission: runId => readCancellationAdmission(recordsJsm, space, "manager", runId),
        readRevocation: runId => readRunRevocation(recordsJsm, space, "manager", runId),
        withStore: async (runId, work) => {
          const nc = await dialerFor(server)({ servers: server, ...standaloneConnectOpts({
            creds: await mintCreds(issuerAuth(), newIdentity(), "run-admitter", { runAdmitter: { endpoint: "manager", runId }, expiresInSeconds: 60 }), tls: false,
          }), maxReconnectAttempts: 0 });
          onConnection?.(nc, `cotal:run-cancel:${space}`);
          try { return await work(await new Kvm(nc).open(admissionBucket(space))); }
          finally { await drainAndClose(nc); }
        },
      }));
    },
    revokeManagerRun: async ({ request, ...holder }) => {
      refuseIfFenced();
      const req = parseRemoteRunRevokeRequest(request);
      await observeLegacyManagerGate(req.instanceId);
      const admitterNc = await dialerFor(server)({
        servers: server,
        ...standaloneConnectOpts({
          creds: await mintCreds(issuerAuth(), newIdentity(), "run-admitter", { runAdmitter: { endpoint: "manager", runId: req.revoke.runId }, expiresInSeconds: 60 }),
          tls: false,
        }),
        maxReconnectAttempts: 0,
      });
      onConnection?.(admitterNc, `cotal:run-revoker:${space}`);
      try {
        return await revokeRemoteRun({
          ...holder, request: req, space, accountPublicKey: dataAccount.pub, proofSecret: dataAccount.signingSeed, endpoint: "manager",
          observeManagerGate: observeLegacyManagerGate,
          readAdmission: (runId) => readRunAdmission(recordsJsm, space, "manager", runId),
          readRevocation: (runId) => readRunRevocation(recordsJsm, space, "manager", runId),
          admissions: await new Kvm(admitterNc).open(admissionBucket(space)),
        });
      } finally {
        await drainAndClose(admitterNc);
      }
    },
    issueManagerRunAttempt: async ({ request, ...holder }) => {
      refuseIfFenced();
      const { owner } = holder;
      requireManagerAuthorityHolder(holder, String((request as { instanceId?: unknown })?.instanceId), 'manager run attempt needs scope "supervise"; spawn/admin do not imply it');
      const req = parseRemoteRunAttemptRequest(request);
      await observeLegacyManagerGate(req.instanceId);
      const recordsKv = await openRecordsBucket(remoteIssuer.nc, space);
      const authorize = (session?: IssuerSession) => authorizeRemoteRunAttempt({
        ...(session ? { issued: session.store, sourceIsLive: composedSourceIsLive(session) } : {}),
        isLiveManagedActor: (owner, actor, lifecycleUid) => {
          const row = findActorUnified(opts.dir, owner, actor);
          return row?.kind === "managed-agent" && row.lifecycleUid === lifecycleUid;
        },
        takeObserved: takeObservedRunRequest,
        registeredCommand: async (instanceId, registrationRevision, command) => {
          const registered = remoteManagerSurface(await registeredManagerCluster(owner, instanceId, { registrationRevision }))[command];
          if (registered === undefined) throw new EpEnvelopeError("failed-precondition", `the registered manager cluster declares no ${command}`);
          return registered;
        },
        request,
        owner,
        space,
        accountPublicKey: dataAccount.pub,
        proofSecret: dataAccount.signingSeed,
        endpoint: "manager",
        observeManagerGate: observeLegacyManagerGate,
        readAdmission: (runId) => readRunAdmission(recordsJsm, space, "manager", runId),
        readRunStatus: async (runId) => (await readRunRecord(recordsKv, "manager", runId))?.status?.value,
        // Replayed under a read operator minted for that one run, the rows the manager's own read rides.
        readJournal: async (runId) => {
          const takeoverId = newTakeoverId();
          const readerNc = await dialerFor(server)({
            servers: server,
            ...standaloneConnectOpts({
              creds: await mintCreds(issuerAuth(), newIdentity(), "run-operator", { runOperator: { endpoint: "manager", takeoverId, runId }, expiresInSeconds: 60 }),
              tls: false,
            }),
            maxReconnectAttempts: 0,
          });
          onConnection?.(readerNc, `cotal:run-attempt-reader:${space}`);
          try {
            return await replayRunJournal(jetstream(readerNc), await jetstreamManager(readerNc), space, runId, takeoverId);
          } finally {
            await drainAndClose(readerNc);
          }
        },
        checkpointWaiting: async (token) => (await readCheckpointStatus(recordsKv, { endpoint: "manager", token }))?.value.state === "waiting",
        checkpointSettled: async (token) => {
          const status = (await readCheckpointStatus(recordsKv, { endpoint: "manager", token }))?.value;
          return status?.state === "resumed" && status.settledAnswerId !== undefined;
        },
      });
      // A served resume or answer resolves its caller's issuance, which needs one issuer window.
      const grant = req.attempt?.served !== undefined || req.operator?.served !== undefined
        ? await withIssuerSession({ servers: server, space, auth: issuerAuth(), tls: false }, (session) => authorize(session))
        : await authorize();
      if (grant.kind === "attempt") {
        const caller = runDriverCaller(grant.driver.runDriver.runId, owner);
        const driver = await mintPublicUserJwt(issuerAuth(), grant.driver.id, "run-driver", {
          principal: { owner, actor: caller.actor },
          lifecycleUid: req.managerLifecycleUid,
          runDriver: grant.driver.runDriver,
          expiresInSeconds: standingTtl,
        });
        const mediator = await mintPublicUserJwt(issuerAuth(), grant.mediator.id, "run-mediator", {
          principal: { owner, actor: caller.actor },
          lifecycleUid: req.managerLifecycleUid,
          runMediator: grant.mediator.runMediator,
          expiresInSeconds: standingTtl,
        });
        return {
          v: 1 as const,
          kind: "manager-run-attempt" as const,
          space,
          owner,
          actor: req.actor,
          instanceId: req.instanceId,
          managerLifecycleUid: req.managerLifecycleUid,
          requestId: req.requestId,
          registrationProof: req.registrationProof,
          accountPublicKey: req.accountPublicKey,
          processEpoch: req.processEpoch,
          identities: req.identities,
          attempt: req.attempt,
          credentials: { driver, mediator },
        };
      }
      const operator = await mintPublicUserJwt(issuerAuth(), grant.operator.id, "run-operator", {
        principal: { owner, actor: req.actor },
        lifecycleUid: req.managerLifecycleUid,
        runOperator: grant.operator.runOperator,
        expiresInSeconds: 60,
      });
      return {
        v: 1 as const,
        kind: "manager-run-attempt" as const,
        space,
        owner,
        actor: req.actor,
        instanceId: req.instanceId,
        managerLifecycleUid: req.managerLifecycleUid,
        requestId: req.requestId,
        registrationProof: req.registrationProof,
        accountPublicKey: req.accountPublicKey,
        processEpoch: req.processEpoch,
        identities: req.identities,
        operator: req.operator,
        credentials: { operator },
      };
    },
  };
}
