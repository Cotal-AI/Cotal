import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Kvm } from "@nats-io/kv";
import * as prompts from "@clack/prompts";
import {
  dialerFor,
  isReachable,
  epAuthBucket,
  recordsBucket,
  mintCreds,
  newIdentity,
  remoteManagerActors,
  remoteManagerRegistrationProof,
  resolveAuthProvider,
  standaloneConnectOpts,
  DEFAULT_SERVER,
  DEFAULT_SPACE,
  DEV_OWNER,
  registry,
  parseCommandArgs,
  token,
  writePrivateRecord,
  type Command,
  type FlagSpec,
  type ParsedArgs,
} from "@cotal-ai/core";
import {
  authDir, canonicalLocalProcessPath, claimServicePid, consumeManagerShutdownIntent, findCotalRoot, getSpaceAuth, hasUserAuthState, isWorkspaceTargetError, listenForLocalStop, loadManagerInstanceIdentity, loadSpaceAccountAuth, parsePositiveIntegerFlag, publishManagerSpareCapability, reclaimDeadPreUpgradeRecord, removePidPair, resolveMeshTarget, soleSpaceOf, userAuthStateDir, workspaceSecretStore, writePidPair,
  c, MANAGER_DELIVERY_AWARE_MARKER, MANAGER_PIDFILE, untilInputEnds,
  brokerAddressForDisplay, CommandFailure, inputDisabledByFlag, isCommandFailure, jsonFlag, plainFlag, presentationOf, renderReport, resolveNativeServiceTarget, terminalWidth, writeResult, type Report,
  refreshRegistrationPolicy, publishServiceStartup, serviceStartupPath, publishServiceStopReceipt, publishServedContract, protectedCredentialReference, readLocalRecordSource, type NativeServiceStopRequest,
  deprecatedDaemonEntry, type MeshEntry,
} from "@cotal-ai/workspace";
import { Manager } from "./manager.js";
import { acceptManagerServiceStop, armManagerServiceObserver, bindManagerServiceIdentity, managerServiceChild, type ManagerServiceChild } from "./service-child.js";
import { MANAGER_ENDPOINT } from "./manager-service-contract.js";
import { makeManagerEndpointHolderEvictor } from "./endpoint-evict.js";
import { makeManagerHolderLivenessProbe } from "./holder-liveness.js";
import { GateReconcileRefused, reconcileEndpointGate } from "./reconcile-gate.js";
import { endpointDeregisterAction } from "./operator-deregister.js";
import { loadRoster } from "./roster.js";
import { loadLaunchSpec, materializePersona, launchAgentToStartOpts } from "./launch.js";
import { type RuntimeMode } from "./runtime/index.js";
import { custodyRoot } from "./runtime/custodial-pty.js";
import { drainSeats } from "@cotal-ai/seat";
import { currentRegistrationProof, loadOrCreateRemoteManagerIdentity, materialCredential, remoteStandingBundleRenewal, remoteManagedAgentEnrollmentMaterial, remoteManagedAgentEnrollmentRequest, remoteManagedAgentPrepareRetirementRequest, remoteManagedAgentRetirementPrepared, remoteManagerAdminAuthorizationRequest, remoteManagerAdminAuthorized, remoteManagerAuthorityRequest, remoteManagerGoalIndexEntries, remoteManagerGoalIndexScanRequest, remoteManagerMaintenanceRequest, remoteManagerMaintenanceResult, remoteRetainedAgentValidationRequest, retainedAgentAuthority, remoteRunHosting } from "./remote-authority.js";
import { registerRemoteManagerAuthority } from "./remote-register.js";
import { managerClusterArtifacts } from "./manager-service-contract.js";

type Values = Record<string, string | undefined>;

/** Read the resume commit token from its protected handoff file once, check it against the
 *  digest named on argv, then unlink it. Errors name the field only; the value is never echoed. */
export function readResumeCommitFile(path: string, sha256: string): string {
  if (!path.startsWith("/") || path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(path) || !/^[0-9a-f]{64}$/.test(sha256)) throw new CommandFailure("refused", "USAGE_INVALID", "--resume-commit-file needs an absolute protected path and --resume-commit-sha256 its full digest");
  protectedCredentialReference(path);
  const bytes = readLocalRecordSource(path, 128, true);
  if (bytes === undefined) throw new CommandFailure("refused", "TARGET_UNAVAILABLE", "the --resume-commit-file handoff is absent; it was not regenerated");
  const value = bytes.toString("utf8");
  if (!/^[a-f0-9]{64}$/.test(value) || createHash("sha256").update(value).digest("hex") !== sha256) throw new CommandFailure("refused", "CONFLICT", "the --resume-commit-file handoff does not match --resume-commit-sha256; its contents were not echoed");
  rmSync(path);
  return value;
}

/** The resume commit token from one input form only. `supervise` keeps the deprecated argv
 *  token for older callers; the native child accepts only the file form. */
function resumeCommitToken(v: Values, allowArgv: boolean): string | undefined {
  const file = v["resume-commit-file"] !== undefined || v["resume-commit-sha256"] !== undefined;
  if (file && v["resume-commit-token"] !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "use either --resume-commit-token or --resume-commit-file with --resume-commit-sha256, not both");
  if (!allowArgv && v["resume-commit-token"] !== undefined) throw new CommandFailure("refused", "USAGE_INVALID", "the native manager child takes the resume commit token only as a protected file");
  if (!file) return v["resume-commit-token"];
  if (v["resume-commit-file"] === undefined || v["resume-commit-sha256"] === undefined) throw new CommandFailure("refused", "USAGE_INVALID", "--resume-commit-file and --resume-commit-sha256 are required together");
  return readResumeCommitFile(v["resume-commit-file"], v["resume-commit-sha256"]);
}

/**
 * RECORD THIS PROCESS as the running manager, and un-record it on a clean exit.
 *
 * The daemon writes its OWN pid because it is the only participant that knows it. Until now the
 * record was written by whoever SPAWNED a manager (`cotal up`'s detached re-exec), so every other
 * route to a running manager — a container entrypoint, cron, an operator typing `cotal supervise` —
 * left `.cotal/manager.pid` untouched. On a box where a supervisor is respawned by anything but the
 * CLI, the file then holds the pid of a manager that died some time ago while the live one runs
 * unlisted, and every reader of that file is answering about a process that no longer exists.
 *
 * The returned release is pid-CHECKED. A manager that exits must not delete a record that already
 * belongs to its successor (a fast restart writes the new pid before the old process finishes
 * unwinding), so the record is removed only while it still names this process — the same rule the
 * rest of the pidfile contract keeps: never delete a record you cannot prove is yours.
 *
 * A folder with no `.cotal/` is not a workspace and gets no record: creating one here would plant a
 * stray workspace root wherever a manager happened to be started.
 */
export function recordManagerPid(root: string, space: string): () => void {
  const dir = join(root, ".cotal");
  if (!existsSync(dir)) {
    console.error(c.dim(`• no ${dir} here, so this manager is not recorded in a pidfile (nothing local will find it by pid)`));
    return () => {};
  }
  // The names are `{space}` TEMPLATES, so they go through the local-process expansion rather than
  // `join`: a `join(dir, MANAGER_PIDFILE)` would now write a file literally called
  // `manager.{space}.pid` that no reader resolves. The CANONICAL path, and the pre-upgrade record is
  // reclaimed first so an upgraded root does not end up holding both names.
  const ctx = { root, space };
  reclaimDeadPreUpgradeRecord(MANAGER_PIDFILE, ctx);
  reclaimDeadPreUpgradeRecord(MANAGER_DELIVERY_AWARE_MARKER, ctx);
  const pidPath = canonicalLocalProcessPath(MANAGER_PIDFILE, ctx);
  const markerPath = canonicalLocalProcessPath(MANAGER_DELIVERY_AWARE_MARKER, ctx);
  const mine = String(process.pid);
  // #969/#1238: publish the pair by rename so a later teardown never sees a torn pairing.
  // Both records are created 0o600 under fresh names and renamed into place (writePidPair).
  writePidPair(pidPath, process.pid);
  // Written together and removed together: the marker proves the LIVE pid is a non-hosting build,
  // and it is only meaningful while it names that same pid. A symlink at the marker is refused.
  writePrivateRecord(markerPath, mine);
  return () => {
    for (const p of [markerPath, pidPath]) {
      try {
        if (p === pidPath) removePidPair(pidPath, mine);
        else if (readFileSync(p, "utf8").trim() === mine) rmSync(p, { force: true });
      } catch {
        /* already gone, or unreadable: leaving a record we cannot prove is ours is the safe error */
      }
    }
  };
}

/** The space to operate on: explicit `--space`, else this folder's `.cotal/auth` space, else the
 *  default — so a manually-run manager matches the folder's mesh instead of assuming the default. */
function spaceFor(v: Values, root = findCotalRoot()): string {
  return v.space ?? soleSpaceOf(authDir(root)) ?? DEFAULT_SPACE;
}

/**
 * Resolve the public supervisor's target without ever recasting a registered participant as the
 * hosting root. A local user-auth marker is the host proof; only when it is absent can a matching
 * registry record contribute the remote broker address. An explicit `--server` may repeat that
 * address, but never override it silently — a supervisor that accepted a mismatched dial would
 * describe one mesh while attempting to control another.
 *
 * This intentionally stops BEFORE manager construction for registered remote user meshes. The
 * current Manager is a host signer: it mints endpoint-service and provisioning credentials from
 * `getSpaceAuth`. A participant's registry material has only a user bearer/sentinel, not that
 * signer. Do not turn this into a partial startup that later fails on a broker permission error;
 * the public command owns the honest, actionable refusal below.
 */
export function superviseTarget(v: Values, root = findCotalRoot()): { space: string; server: string; remoteUser: boolean; tlsRequired: boolean; eventsRequired: boolean; policy?: MeshEntry["policy"]; agentBearerExchangeUrl?: string } {
  // COTAL_SPACE / COTAL_SERVER stand in for the flags when the manager runs as a service: a
  // service unit's ExecStart stays bare (command lines are a publication surface on a multi-user
  // host) and the mesh facts arrive through a 0600 EnvironmentFile instead. An explicit flag
  // still wins over the environment, so nothing changes for an operator typing the command.
  const ve: Values = { ...v, space: v.space ?? process.env.COTAL_SPACE, server: v.server ?? process.env.COTAL_SERVER };
  const localSpace = spaceFor(ve, root);
  if (hasUserAuthState(root, localSpace)) {
    // Preserve the historical host path's missing/stale-registry diagnostics in Manager.start():
    // a local marker proves this machine HOSTS the state, but not that its registry is healthy.
    // When the record resolves, however, it is the broker authority and an explicit mismatch is
    // rejected here before a process can describe one mesh while dialing another.
    try {
      const target = resolveMeshTarget(root, { space: localSpace });
      if (ve.server !== undefined && ve.server !== target.server)
        throw new Error(`--server ${ve.server} does not match hosting space "${localSpace}" at ${target.server} - supervise refuses to split its local auth state from its broker`);
      return { space: localSpace, server: target.server, remoteUser: false, tlsRequired: target.tlsRequired, eventsRequired: target.policy?.events === "required", ...(target.policy ? { policy: target.policy } : {}) };
    } catch (error) {
      if (!isWorkspaceTargetError(error)) throw error;
      return { space: localSpace, server: ve.server ?? DEFAULT_SERVER, remoteUser: false, tlsRequired: false, eventsRequired: false };
    }
  }

  try {
    const target = resolveMeshTarget(root, { space: localSpace });
    if (target.mode === "user" && target.userAuth?.remote === true) {
      if (ve.server !== undefined && ve.server !== target.server)
        throw new Error(`--server ${ve.server} does not match registered space "${target.space}" at ${target.server} - supervise refuses to use a different broker than the meshes entry`);
      return {
        space: target.space, server: target.server, remoteUser: true, tlsRequired: target.tlsRequired,
        eventsRequired: target.policy?.events === "required",
        ...(target.policy ? { policy: target.policy } : {}),
        agentBearerExchangeUrl: target.userAuth.endpoints?.url,
      };
    }
    // The marker is absent, but this is a local/static/open record or a malformed user entry. Let
    // the normal manager validation retain its mode-specific diagnostics rather than rewording a
    // state this helper has not proved is the registered-participant case.
    if (ve.server !== undefined && ve.server !== target.server)
      throw new Error(`--server ${ve.server} does not match registered space "${target.space}" at ${target.server} - supervise refuses to use a different broker than the meshes entry`);
    return { space: target.space, server: target.server, remoteUser: false, tlsRequired: target.tlsRequired, eventsRequired: target.policy?.events === "required", ...(target.policy ? { policy: target.policy } : {}) };
  } catch (error) {
    // `resolveMeshTarget(...,{space})` distinguishes every known registry fault. Only an absent
    // record gets the host-or-join wording; a corrupt/ambiguous record remains its own loud error.
    if (isWorkspaceTargetError(error) && error.code === "unknown-space") {
      // A hosting root that predates a registry entry (or whose entry was pruned) still holds this
      // space's account record on disk, beside any other space it hosts: `.cotal/auth` is the host
      // proof `resolveMeshTarget` cannot see without a record. The broker address then comes from
      // the flag/env, exactly what a service unit's EnvironmentFile supplies.
      if (loadSpaceAccountAuth(authDir(root), localSpace))
        return { space: localSpace, server: ve.server ?? DEFAULT_SERVER, remoteUser: false, tlsRequired: false, eventsRequired: false };
      throw new Error(`neither hosting '${localSpace}' (no cotal up root here) nor registered to it (no meshes entry) — \`cotal up\` to host, or \`cotal meshes add\` to join`);
    }
    throw error;
  }
}

// The supervisor's output IS `.cotal/manager.<key>.log` when detached (manager-proc.ts opens that
// file and redirects this process's stdio onto it), and a log whose only temporal information is
// line order cannot say when a seat was reaped without opening every seat's private connector log
// (#1423). Stamping here, once, covers every `console.log`/`console.error` call in this daemon
// process, including the 100+ sites in manager.ts that already run through the global console. A
// multi-line message (the `manager up` banner) stamps its first line only, since that is where the
// event is. No environment switch, no TTY check, no flag: a foreground `cotal supervise` prints the
// same stamps, and that is fine.
function stampConsole(): void {
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  console.log = (...args: unknown[]) => originalLog(new Date().toISOString(), ...args);
  console.error = (...args: unknown[]) => originalError(new Date().toISOString(), ...args);
}

function superviseExecution(v: Values): "runtime" | "none" {
  if (v.execution !== undefined && v.execution !== "runtime" && v.execution !== "none")
    throw new CommandFailure("refused", "USAGE_INVALID", '--execution must be "runtime" or "none"');
  if (v.execution === "none" && ["runtime", "spawn", "roster", "launch", "resume-attempt", "resume-commit-token", "resume-commit-file", "resume-commit-sha256"].some((key) => v[key] !== undefined))
    throw new CommandFailure("refused", "USAGE_INVALID", "execution: none forbids runtime and startup workload flags");
  return v.execution ?? "runtime";
}

/** Run a manager daemon in this process (the long-lived supervisor), then block.
 *  `pty` ships with the manager; every other runtime needs a registered provider. The published
 *  CLI lazy-loads installed providers, while library roots import their integrations explicitly.
 *
 *  The operator CLIENTS of this daemon — detached launch (`cotal spawn --detach`), `stop`, `ps`,
 *  `attach` — live in `@cotal-ai/cli` since stage 2a of the CLI rework: they are thin control-plane
 *  request/reply commands, not daemon code. This package registers only the daemon runner. */
// `--runtime` forces the manager runtime; honored only on the `supervise` path (default
// pty). `cmux` gives each teammate its own cmux tab — `cotal supervise --runtime cmux` is
// the cmux-tab manager.
async function runManager(args: ParsedArgs, defaultRuntime: RuntimeMode, service?: ManagerServiceChild): Promise<void> {
  stampConsole();
  const v = args.values as Values;
  const managerRoot = service?.root ?? findCotalRoot();
  const execution = superviseExecution(v);
  let runtime: RuntimeMode | undefined = execution === "none" ? undefined : defaultRuntime;
  if (defaultRuntime === "auto" && v.runtime) {
    runtime = v.runtime as RuntimeMode;
  }
  let target: ReturnType<typeof superviseTarget>;
  try {
    target = superviseTarget(v, managerRoot);
    if (execution === "none" && target.remoteUser)
      throw new Error("execution: none on supervise requires a genuine hosting user-auth root, not a participant registration");
  } catch (e) {
    if (service) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native manager child did not confirm startup; inspect the original protected launch records before another start");
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  const { space, server } = target;
  // Claim before hosted registration/issuance or local endpoint initialization. Starting
  // custody proves only this process; no startup/serving phase exists and no contender is adopted.
  const releaseStartingCustody = service ? claimServicePid({ root: managerRoot, space }, MANAGER_PIDFILE) : undefined;
  let remoteAuthority: NonNullable<ConstructorParameters<typeof Manager>[0]["remoteAuthority"]> | undefined;
  if (target.remoteUser) {
    try {
      const root = managerRoot;
      const state = loadOrCreateRemoteManagerIdentity(root, space);
      const provider = resolveAuthProvider();
      // Every provider call shares this one context: a call that resolved the root again could land on
      // a different `.cotal/` than the one the identity above was loaded from.
      const providerCall = { store: workspaceSecretStore(root), dir: userAuthStateDir(root, space) };
      if (!provider.managerServiceAuthority)
        throw new Error(`the registered auth provider "${provider.name}" does not implement the typed manager-service authority protocol`);
      if (!provider.maintainRemoteManager)
        throw new Error(`the registered auth provider "${provider.name}" does not implement host-owned manager registration maintenance`);
      if (!provider.validateRemoteRetainedAgent)
        throw new Error(`the registered auth provider "${provider.name}" does not implement the typed remote retained-agent validation protocol`);
      if (!provider.scanRemoteManagerGoalIndex)
        throw new Error(`the registered auth provider "${provider.name}" does not implement the host-owned manager goal-index scan protocol`);
      if (!provider.authorizeRemoteManagerAdmin)
        throw new Error(`the registered auth provider "${provider.name}" does not implement the host-owned manager admin authorization protocol`);
      if (!provider.requestRemoteRunAdmission || !provider.requestRemoteRunAttempt)
        throw new Error(`the registered auth provider "${provider.name}" does not implement both closed hosted-run admission and issuance calls`);
      const request = remoteManagerAuthorityRequest(state, "cli", "prepare");
      const agentBearerExchangeUrl = target.agentBearerExchangeUrl;
      if (typeof agentBearerExchangeUrl !== "string" || !agentBearerExchangeUrl)
        throw new Error(`registered space "${space}" has no pinned public exchange URL for retained managed agents`);
      const material = await provider.managerServiceAuthority({ ...providerCall, request });
      const actors = remoteManagerActors(state.instanceId);
      if (material.owner.length === 0 || material.instanceId !== state.instanceId || material.lifecycleUid !== state.lifecycleUid ||
          JSON.stringify(material.actors) !== JSON.stringify(actors))
        throw new Error("the host returned manager-service material for different lifecycle coordinates");
      const maintain = async (operation: "evict-family-principal" | "reconcile-registration", targetInstanceId: string, principals?: string[]) => {
        const maintenanceRequest = remoteManagerMaintenanceRequest(state, "cli", operation, targetInstanceId, principals);
        const response = await provider.maintainRemoteManager!({ ...providerCall, request: maintenanceRequest });
        return remoteManagerMaintenanceResult(response, maintenanceRequest, material.owner);
      };
      const registered = await registerRemoteManagerAuthority({
        space,
        server,
        owner: material.owner,
        instanceId: state.instanceId,
        serveActor: actors.serve,
        prepareCreds: materialCredential(material, "executor", state.identities.executor),
        tlsRequired: target.tlsRequired,
        evict: async (principals) => (await maintain("evict-family-principal", state.instanceId, [...principals])).evictions!.map((e) => e.verifiedGone),
        reconcileForeignRegistration: async (instanceId) => { await maintain("reconcile-registration", instanceId); },
      });
      const artifacts = managerClusterArtifacts();
      // Registration already published every command-schema artifact through the scoped executor.
      // Activation carries only the canonical cluster document and its closure manifest: these are
      // the bounded values the host validates to reconstruct the serve grant. Re-sending the full
      // schema closure here exceeded the typed protocol's 64-artifact cap as the command set grew.
      const contractArtifacts = [artifacts.document, artifacts.manifest];
      const registrationProof = remoteManagerRegistrationProof(material.owner, state, contractArtifacts);
      const activate = await provider.managerServiceAuthority({
        ...providerCall,
        request: remoteManagerAuthorityRequest(state, "cli", "activate", { registrationProof, contractArtifacts }),
      });
      const retainedRegistrationProof = currentRegistrationProof(activate);
      const supervisorCreds = materialCredential(material, "supervisor", state.identities.supervisor);
      // The closed all-duty family renewal over the same registration, proof and store. Without it
      // the manager renews its executor alone and the serve, goal-writer and session-ledger
      // connections die at their expiry.
      const standing = remoteStandingBundleRenewal({
        state, owner: material.owner, registrationProof: retainedRegistrationProof, supervisorCreds,
        call: (renewalRequest) => provider.managerServiceAuthority!({ ...providerCall, request: renewalRequest }),
      });
      remoteAuthority = {
        ...standing,
        owner: material.owner,
        actors,
        instanceId: state.instanceId,
        lifecycleUid: state.lifecycleUid,
        identities: state.identities,
        supervisorCreds,
        executorCreds: materialCredential(material, "executor", state.identities.executor),
        renewExecutor: async () => {
          const renewed = await provider.managerServiceAuthority!({
            ...providerCall,
            request: remoteManagerAuthorityRequest(state, "cli", "renew", { registrationProof: retainedRegistrationProof }),
          });
          return materialCredential(renewed, "executor", state.identities.executor);
        },
        serveCreds: materialCredential(activate, "serve", state.identities.serve),
        goalWriterCreds: materialCredential(activate, "goalWriter", state.identities.goalWriter),
        sessionLedgerCreds: materialCredential(activate, "sessionLedger", state.identities.sessionLedger),
        runHosting: remoteRunHosting({
          state, owner: material.owner, registrationProof: retainedRegistrationProof,
          accountPublicKey: standing.accountPublicKey, processEpoch: registered.processEpoch,
          requestRunAdmission: (request) => provider.requestRemoteRunAdmission!({ ...providerCall, request }),
          requestRunAttempt: (request) => provider.requestRemoteRunAttempt!({ ...providerCall, request }),
          requestRunRevoke: async (request) => {
            if (provider.requestRemoteRunRevoke === undefined) throw new Error(`the registered auth provider "${provider.name}" does not implement closed hosted-run revoke`);
            return provider.requestRemoteRunRevoke({ ...providerCall, request });
          },
          call: (request) => provider.managerServiceAuthority!({ ...providerCall, request }),
        }),
        serveGrant: registered.serveGrant,
        agentBearerExchangeUrl,
        mintSessionServing: async (session) => {
          const sessionMaterial = await provider.managerServiceAuthority!({
            ...providerCall,
            request: remoteManagerAuthorityRequest(state, "cli", "session", {
              registrationProof: remoteManagerRegistrationProof(material.owner, state),
              session: {
                id: session.identity.id,
                endpoint: session.endpoint,
                sessionId: session.sessionId,
                epoch: session.epoch,
                exp: session.exp,
              },
            }),
          });
          return materialCredential(sessionMaterial, "sessionServing", session.identity);
        },
        mintRetirementRequester: async ({ identity, target: retirementTarget, opId, serveEpoch }) => {
          const retirementMaterial = await provider.managerServiceAuthority!({
            ...providerCall,
            request: remoteManagerAuthorityRequest(state, "cli", "retire", {
              registrationProof: remoteManagerRegistrationProof(material.owner, state),
              retirement: {
                id: identity.id,
                target: retirementTarget,
                opId,
                serveEpoch,
              },
            }),
          });
          if (retirementMaterial.retirement?.opId !== opId ||
              JSON.stringify(retirementMaterial.retirement?.target) !== JSON.stringify(retirementTarget) ||
              retirementMaterial.retirement?.serveEpoch !== serveEpoch)
            throw new Error("manager-service retirement material does not echo the requested target, operation, and serve epoch");
          return materialCredential(retirementMaterial, "retirementRequester", identity);
        },
        mintTransferReader: async (identity) => {
          const readerMaterial = await provider.managerServiceAuthority!({
            ...providerCall,
            request: remoteManagerAuthorityRequest(state, "cli", "transferReader", {
              registrationProof: remoteManagerRegistrationProof(material.owner, state),
              transferReader: { id: identity.id },
            }),
          });
          return materialCredential(readerMaterial, "transferReader", identity);
        },
        // #1972: the host-owned halves of the managed agent lifecycle. Both ride the one verified
        // manager-authority transport, and both are present only when the registered provider
        // implements them — a provider without the hosted storage composition leaves the hook absent,
        // and the manager then refuses a detached user-mode spawn rather than authoring a local grant
        // the host knows nothing about.
        ...(provider.enrollRemoteManagedAgent
          ? {
              enrollManagedAgent: async ({ target }) => {
                const request = remoteManagedAgentEnrollmentRequest(
                  state,
                  "cli",
                  retainedRegistrationProof,
                  registered.processEpoch,
                  target,
                );
                const result = await provider.enrollRemoteManagedAgent!({ ...providerCall, request });
                return remoteManagedAgentEnrollmentMaterial(result, request);
              },
            }
          : {}),
        prepareAgentRetirement: async ({ target: retirementTarget, opId }) => {
          if (!provider.prepareRemoteManagedAgentRetirement)
            throw new Error(`the registered auth provider "${provider.name}" does not implement host-owned managed agent retirement preparation, so remote participant supervision cannot terminally retire a hosted managed agent`);
          const request = remoteManagedAgentPrepareRetirementRequest(
            state,
            "cli",
            retainedRegistrationProof,
            registered.processEpoch,
            retirementTarget,
            opId,
          );
          const result = await provider.prepareRemoteManagedAgentRetirement({ ...providerCall, request });
          remoteManagedAgentRetirementPrepared(result, request);
        },
        validateRetainedAgent: async ({ owner: targetOwner, actor, lifecycleUid, actorToken, sentinelCreds }) => {
          const request = remoteRetainedAgentValidationRequest(
            state,
            "cli",
            retainedRegistrationProof,
            registered.processEpoch,
            { owner: targetOwner, actor, lifecycleUid },
            actorToken,
            sentinelCreds,
          );
          const result = await provider.validateRemoteRetainedAgent!({ ...providerCall, request });
          return retainedAgentAuthority(result, request);
        },
        scanGoalIndex: async () => {
          const request = remoteManagerGoalIndexScanRequest(
            state,
            "cli",
            retainedRegistrationProof,
            registered.processEpoch,
          );
          const result = await provider.scanRemoteManagerGoalIndex!({ ...providerCall, request });
          return remoteManagerGoalIndexEntries(result, request, material.owner);
        },
        authorizeAdmin: async (caller) => {
          const request = remoteManagerAdminAuthorizationRequest(
            state,
            "cli",
            retainedRegistrationProof,
            registered.processEpoch,
            caller,
          );
          const result = await provider.authorizeRemoteManagerAdmin!({ ...providerCall, request });
          return remoteManagerAdminAuthorized(result, request, material.owner);
        },
      };
    } catch (e) {
      if (service) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native manager child did not confirm hosted authority preparation; it was not retried");
      console.error(c.red(
        `✗ remote supervision for space "${space}" was refused: ${(e as Error).message}. ` +
        `Foreground \`cotal spawn\` remains available; detached/managed agents require a live host-approved manager-service authority.`,
      ));
      process.exit(1);
    }
  }
  // Parse the roster + launch spec before touching the network — a malformed file should fail fast,
  // before the manager comes up or any agent is spawned.
  const roster = service ? service.roster ?? [] : v.roster ? loadRoster(v.roster) : [];
  const launchSpec = service ? service.launchSpec : v.launch ? loadLaunchSpec(v.launch) : undefined;
  if (v["resume-attempt"] && (v.roster || v.launch || v.spawn)) {
    console.error(c.red("✗ --resume-attempt cannot be combined with --roster, --launch, or --spawn; retained agents resume only through the attempt-bound admin control op"));
    process.exit(1);
  }
  if ((v["resume-commit-token"] || v["resume-commit-file"] || v["resume-commit-sha256"]) && !v["resume-attempt"]) {
    console.error(c.red("✗ a resume commit token requires --resume-attempt"));
    process.exit(1);
  }
  let resumeDurableCommitToken: string | undefined;
  try { resumeDurableCommitToken = resumeCommitToken(v, !service); }
  catch (e) {
    if (service) throw e;
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  // The registration policy is read AFTER every local refusal above and before the first dial: a
  // pre-policy manual entry learns it from its pinned exchange, and a refusal there must never
  // pre-empt the `--server` mismatch or the missing-login sentence the operator can act on.
  let eventsRequired = target.eventsRequired;
  try {
    eventsRequired = (await refreshRegistrationPolicy(target))?.events === "required";
  } catch (e) {
    if (service) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native manager child did not confirm startup; inspect the original protected launch records before another start");
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  if (!(await isReachable(server))) {
    console.error(c.red(`Can't reach NATS at ${server}. Run: cotal up`));
    process.exit(1);
  }
  const consolePort = v["console-port"] ? Number(v["console-port"]) : undefined;
  // The broker ws listener port (loopback) `cotal up` allocated — the console's mesh
  // session client builds its wsUrl from it. Absent ⇒ no console session client (POST /session 503s).
  const wsPort = v["ws-port"] ? Number(v["ws-port"]) : undefined;
  // Where the console face binds. Absent → loopback, so a bare `cotal supervise` keeps a
  // machine-local console. `cotal up` passes the address it bound the broker to when the operator
  // asked for an exposed console; the terminal itself rides the mesh either way.
  const attachHost = v["console-host"];
  let maxSessions: number | undefined;
  try {
    maxSessions = parsePositiveIntegerFlag("--max-sessions", v["max-sessions"]);
  } catch (e) {
    if (service) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native manager child did not confirm startup; inspect the original protected launch records before another start");
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  // Construction resolves the runtime (createRuntime) — which fails loud on an unusable env, e.g. the
  // pty runtime under Bun. Render that as one actionable line, not a raw stack (this also lands in
  // `.cotal/manager.log` for a detached `cotal up` daemon).
  let mgr: Manager;
  try {
    // The published-binary supervisor resolves connectors from the operator manifest (seeded +
    // `ext add`ed), NOT from static imports — `bin/cotal.ts` no longer registers any. A direct
    // library `Manager` keeps the registry-only default (opt-in preserved).
    mgr = new Manager({
      space,
      servers: server,
      eventsRequired,
      runtime,
      execution,
      consolePort,
      wsPort,
      attachHost,
      maxSessions,
      installedExtensions: true,
      resumeAttemptId: v["resume-attempt"],
      resumeDurableCommitToken,
      remoteAuthority,
      ...(service ? { workspaceRoot: managerRoot, onServiceIdentity: bindManagerServiceIdentity(service) } : {}),
    });
  } catch (e) {
    if (service) throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native manager child did not confirm startup; inspect the original protected launch records before another start");
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  const managerContext = { root: managerRoot, space };
  // Until the settled record exists, a release only drops a managed child's exact starting slot.
  // A failed start or a stop that wins the start leaves no settled legacy record behind.
  let releaseSettledRecord: (() => void) | undefined;
  const releasePidRecord = () => { releaseSettledRecord?.(); releaseStartingCustody?.(); };
  // Signals and cooperative requests share the sparing default. Only the process-bound
  // `cotal down --with-agents` intent authorizes an agent reap; a managed child accepts only its
  // request-bound native stop handoff.
  let shuttingDown = false;
  // A start that failed under a pending stop leaves the exit to its own error once that stop settles.
  let startFailed = false;
  let stopped: Promise<void> | undefined;
  let disposeObserver: (() => void) | undefined;
  const shutdown = () => {
    if (shuttingDown) return;
    let request: NativeServiceStopRequest | undefined;
    let withAgents: boolean;
    if (service) {
      try { request = acceptManagerServiceStop(mgr, service); withAgents = request.withAgents; }
      catch { console.error(c.yellow("! the managed manager stop handoff was not accepted; inspect its original request and phase records")); return; }
    } else {
      const decision = consumeManagerShutdownIntent({ root: managerRoot, space });
      if (decision.warning) console.error(c.yellow(`! ${decision.warning}`));
      withAgents = decision.withAgents;
    }
    shuttingDown = true;
    disposeObserver?.();
    stopped = mgr.stop({ withAgents })
    .then(() => {
      publishManagerSpareCapability(managerContext, false);
      releasePidRecord();
      if (service && request) publishServiceStopReceipt(service.context, request, "completed");
      if (!startFailed) process.exit(0);
    })
    .catch((e) => {
      // The record is NOT released here: the stop did not complete, so a seat may still be running
      // under this instance's lease. A record removed under a failed stop is the orphan defect the
      // pidfile contract exists to prevent. The process still exits: stop() has closed what it could,
      // and the shuttingDown latch would otherwise leave it deaf to every later signal (#2290).
      if (service) {
        if (request) {
          try { publishServiceStopReceipt(service.context, request, "failed"); }
          catch { /* Missing terminal evidence stays unknown to the original controller. */ }
        }
        console.error(c.red("✗ the native managed manager stop did not confirm completion; its phase evidence was retained"));
      } else console.error(c.red(`✗ ${(e as Error).message}`));
      if (!startFailed) process.exit(1);
    });
  };
  const disposeLocalStop = process.platform === "win32"
    ? listenForLocalStop(canonicalLocalProcessPath(MANAGER_PIDFILE, managerContext), () => {
      console.error(`• manager: received local stop request, exiting (space ${space})`);
      shutdown();
    })
    : undefined;
  // Listen before start: start() acquires the liveness lease early, and a signal that took Node's
  // default action there would strand the row for its whole TTL. stop() waits for start to settle.
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try { await mgr.start(); }
  catch (error) {
    disposeLocalStop?.();
    // The CLI exits as soon as this throws. A stop requested during start runs only after start
    // settles, so wait for it to release the lease first; the start error still decides the exit.
    startFailed = true;
    await stopped;
    throw error;
  }
  // A stop that arrived during start owns the exit; this process never announces itself ready.
  if (shuttingDown) return;
  // The control capability precedes the pid record, so a stop cannot observe a ready manager
  // before its cooperative endpoint exists. A failed start still publishes no pid record. A
  // managed child already owns its exact starting PID slot; it settles that same process here.
  releaseSettledRecord = recordManagerPid(managerRoot, space);
  publishManagerSpareCapability(managerContext, mgr.spareSeats);
  if (!service) console.log(
    c.green("✓ manager up") +
      c.dim(` (space ${space} · ${mgr.runtimeKind})`) +
      `\n  console: ${mgr.consoleUrl}` +
      c.dim("\n  spawn: cotal spawn --detach <persona>   ·   stop: cotal stop --name <n>   (Ctrl-C to shut down)"),
  );
  if (service) {
    // The served-contract binding precedes the serving receipt, so a serving child always has it.
    const served = managerClusterArtifacts();
    publishServedContract(service.context, { endpoint: MANAGER_ENDPOINT, clusterDigest: served.closureDigest, document: served.document });
    publishServiceStartup(serviceStartupPath(service.context), { phase: "manager-serving", ...service.context });
    disposeObserver = armManagerServiceObserver(mgr, service);
  }
  // Declarative boot: bring up each rostered agent through the same spawn path as a detached spawn.
  // A failed entry is logged but non-fatal — healthy agents stay up and the operator can
  // fix the roster without the supervisor crash-looping.
  for (const entry of roster) {
    const reply = await mgr.startAgent(entry);
    // Log the spawned IDENTITY (the persona's name:), which can differ from entry.name (the file ref).
    const spawned = (reply.data as { name?: string } | undefined)?.name ?? entry.name;
    if (reply.ok) console.log(c.green(`✓ started ${c.bold(spawned)}`) + c.dim(` (${entry.agent})`));
    else console.error(c.red(`✗ ${entry.name}: ${reply.error}`));
  }
  // Pre-spawn teammates the manager owns (e.g. the demo's david/sven), so they're despawnable.
  // Stagger them: wait for each to register presence before launching the next, so several heavy
  // Claude cold-starts don't boot simultaneously and spike memory. The last one needs no wait.
  if (v.spawn) {
    const names = v.spawn.split(",").map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < names.length; i++) {
      const ref = names[i];
      const reply = await mgr.startByName(ref);
      if (!reply.ok) {
        console.error(c.red(`✗ couldn't spawn ${ref}: ${reply.error ?? "unknown error"}`));
        continue;
      }
      // The peer joins under its persona's name: (the spawned identity), which may differ from the
      // ref filename — wait on (and log) THAT, or staggering blocks the full timeout on a name that
      // never appears (e.g. ref review-critic → identity socrates).
      const spawned = (reply.data as { name?: string } | undefined)?.name ?? ref;
      console.log(c.green(`✓ spawned ${spawned}`));
      if (i < names.length - 1) {
        const joined = await mgr.waitForPresence(spawned);
        console.log(c.dim(joined ? `  ${spawned} joined; starting next` : `  ${spawned} still starting; continuing`));
      }
    }
  }
  // Declarative manifest boot (`cotal up -f` / `spawn -f`): materialize each resolved agent's
  // transient persona, then spawn it with its resolved ACLs/identity. Staggered like `--spawn` so
  // heavy cold-starts don't pile up. A failed entry is logged, non-fatal — healthy agents stay up.
  if (launchSpec) {
    const root = managerRoot;
    for (let i = 0; i < launchSpec.agents.length; i++) {
      const la = launchSpec.agents[i];
      let configPath: string;
      try {
        configPath = materializePersona(root, launchSpec.runId, la);
      } catch (e) {
        console.error(c.red(`✗ ${la.name}: ${(e as Error).message}`));
        continue;
      }
      const reply = await mgr.startAgent(launchAgentToStartOpts(la, configPath, launchSpec.owner, launchSpec.runId));
      if (!reply.ok) {
        console.error(c.red(`✗ ${la.name}: ${reply.error}`));
        continue;
      }
      const spawned = (reply.data as { name?: string } | undefined)?.name ?? la.name;
      console.log(c.green(`✓ launched ${spawned}`) + c.dim(` (${la.agent})`));
      if (i < launchSpec.agents.length - 1) {
        const joined = await mgr.waitForPresence(spawned);
        console.log(c.dim(joined ? `  ${spawned} joined; starting next` : `  ${spawned} still starting; continuing`));
      }
    }
  }
  await new Promise<void>(() => {});
}

function validateMaintenanceArguments(args: ParsedArgs, mode: "reconcile" | "seats"): void {
  presentationOf(args.values);
  if (args.positionals.length) throw new CommandFailure("refused", "USAGE_INVALID", `manager ${mode} takes named options, not additional positional targets`);
  if (mode === "seats" && !args.values.drain && (args.values.yes !== undefined || args.values["dry-run"] !== undefined)) throw new CommandFailure("refused", "USAGE_INVALID", "manager seats --yes and --dry-run require --drain");
  for (const key of mode === "reconcile" ? ["endpoint", "instance"] : []) {
    const value = args.values[key];
    if (value !== undefined && (typeof value !== "string" || !value || value.length > 200 || token(value) !== value)) throw new CommandFailure("refused", "USAGE_INVALID", `--${key} needs one full native token; prefixes and normalized replacements are not used`);
  }
}

async function confirmMaintenance(args: ParsedArgs, target: unknown, review: Report, question: string): Promise<boolean> {
  if (args.values.yes === true) return true;
  const presentation = presentationOf(args.values);
  if (presentation === "json" || !process.stdin.isTTY || !process.stdout.isTTY || inputDisabledByFlag() || process.env.COTAL_NO_PROMPT === "1") throw new CommandFailure("refused", "USAGE_INVALID", "manager maintenance requires --yes outside an interactive terminal", { target, remedy: "inspect the same operation with --dry-run before confirming its scope" });
  console.log(renderReport(review, presentation, terminalWidth(process.stdout)));
  const answer = await untilInputEnds((signal) => prompts.confirm({ message: question, initialValue: false, signal }));
  if (!prompts.isCancel(answer) && answer) return true;
  writeResult(presentation, { command: "manager", target, result: { kind: "manager-maintenance-cancelled", changed: false }, noOp: true }, (): Report => ({ sections: [{ title: "Manager maintenance cancelled", blocks: [{ kind: "lines", lines: ["The maintenance action was not submitted. No repair or seat drain was performed."] }] }] }));
  return false;
}

/**
 * `cotal manager reconcile` — the guarded exit from an issuance gate left FROZEN by a crashed
 * re-registration whose freeze-holder is dead (#391).
 *
 * WHY THIS IS A CLI COMMAND AND NOT AN ADMIN VERB ON THE MANAGER ENDPOINT: the wedged state IS
 * "the manager cannot complete registration", so anything the manager endpoint serves is
 * unreachable in exactly the state it would exist to repair. This runs operator-locally against
 * the auth KV and the delivery daemon, needing nothing from the wedged endpoint.
 *
 * Read-only until the guard passes: it observes and probes before it constructs the barrier.
 */
async function runReconcileGate(args: ParsedArgs): Promise<void> {
  validateMaintenanceArguments(args, "reconcile");
  const v = args.values as Values;
  const presentation = presentationOf(args.values), root = findCotalRoot(), space = spaceFor(v, root);
  const selected = resolveNativeServiceTarget(root, space, v.server);
  const endpoint = v.endpoint ?? MANAGER_ENDPOINT;
  const instanceId = v.instance ?? loadManagerInstanceIdentity(root, space)?.instanceId;
  if (!instanceId || instanceId.length > 200 || token(instanceId) !== instanceId) throw new CommandFailure("refused", "TARGET_NOT_FOUND", "no full persisted manager instance resolves this repair target", { target: { root, space, endpoint }, remedy: "choose --instance with the full native service instance ID from this root" });
  const target = { root: selected.root, space: selected.space, endpoint, instanceId };
  const review: Report = { space: selected.space, sections: [{ title: "Review issuance-gate repair", blocks: [{ kind: "fields", rows: [["Space", space], ["Signing root", root], ["Endpoint", endpoint], ["Full instance", instanceId], ["Broker", brokerAddressForDisplay(selected.server) ?? "private broker address"], ["Frozen registration", "not checked"], ["Holder liveness", "not checked"], ["Effects", "revoke and verify-evict the dead registration family, then reopen its pinned gate"]] }, { kind: "lines", lines: ["The native guard must prove the freeze-holder gone. Unknown liveness refuses. This command does not start a manager or discard the gate. A failed repair may retain partial progress in its native cursor."] }] }] };
  if (args.values["dry-run"]) {
    writeResult(presentation, { command: "manager", target, result: { kind: "manager-gate-repair-preview", dryRun: true, submitted: false, guardEvidence: "not-checked", credentialIssued: false } }, () => review);
    return;
  }
  if (!await confirmMaintenance(args, target, review, "Attempt the displayed gate repair under its native liveness guard?")) return;
  let auth: Awaited<ReturnType<typeof getSpaceAuth>>;
  try { auth = await getSpaceAuth(workspaceSecretStore(root), space); }
  catch (error) { if (isCommandFailure(error)) throw error; throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "this root's space signing material could not be read; no gate repair was submitted", { target }); }
  if (!auth) throw new CommandFailure("refused", "PERMISSION_DENIED", "gate repair requires this root's native space signing material; no participant or broader caller was substituted", { target });
  let nc: Awaited<ReturnType<ReturnType<typeof dialerFor>>>;
  try {
    const identity = newIdentity();
    const creds = await mintCreds(auth, identity, "endpoint-serve-executor", { endpointServeExecutor: { endpoint, instanceId } });
    nc = await dialerFor(selected.server)({ servers: selected.server, ...standaloneConnectOpts({ creds, tls: selected.tlsRequired }), maxReconnectAttempts: 0 });
  } catch {
    throw new CommandFailure("refused", "DEPENDENCY_UNAVAILABLE", "the scoped repair connection could not be established; no gate repair was submitted and no alternate broker was tried", { target });
  }
  try {
    const kv = await new Kvm(nc).open(epAuthBucket(space));
    const recordsKv = await new Kvm(nc).open(recordsBucket(space));
    const native = await reconcileEndpointGate({
      kv, space, endpoint, instanceId, recordsKv,
      probeHolder: makeManagerHolderLivenessProbe({ space, servers: selected.server, tlsRequired: selected.tlsRequired, auth, log: () => {} }),
      evictHolders: makeManagerEndpointHolderEvictor({ space, servers: selected.server, tlsRequired: selected.tlsRequired, auth, log: () => {} }),
      log: () => {},
    });
    const result = { kind: "manager-gate-repair", opId: native.opId, freezeToken: native.freezeToken, holderPrincipal: native.holderPrincipal, liveness: native.liveness.state, before: native.before, after: native.after, familyRows: native.familyRows, revokedCredentialIds: native.revoked, holdersVerifiedBeforeAttempt: native.holdersVerifiedBeforeAttempt, holdersVerifiedThisAttempt: native.holdersVerifiedThisAttempt, holdersRemaining: native.holdersRemaining, reopenedAtGeneration: native.reopenedAtGeneration, repairCursorCleanup: native.repairCursorCleanup, managerStarted: false };
    writeResult(presentation, { command: "manager", target, result, ...(native.repairCursorCleanup === "retained" ? { completeness: "partial" as const, partial: { message: "The native gate reopened, but its freeze-bound repair cursor was retained. No cursor cleanup success was inferred." } } : {}) }, (row): Report => ({ sections: [{ title: "Issuance gate reopened", blocks: [{ kind: "fields", rows: [["Space", space], ["Endpoint", endpoint], ["Full instance", instanceId], ["Native operation", row.opId], ["Holder", row.holderPrincipal], ["Liveness", row.liveness], ["Gate generation", String(row.reopenedAtGeneration)], ["Process epoch", String(row.after.processEpoch)], ["Registration revision", String(row.after.registrationRevision)], ["Revoked this attempt", String(row.revokedCredentialIds.length)], ["Verified this attempt", String(row.holdersVerifiedThisAttempt.length)], ["Already verified", String(row.holdersVerifiedBeforeAttempt.length)], ["Unverified holders", String(row.holdersRemaining.length)], ["Repair cursor", row.repairCursorCleanup], ["Manager", "not started"]] }, { kind: "lines", lines: ["This receipt describes the native gate repair. It does not establish that a manager is now running or serving."] }] }] }));
  } catch (error) {
    if (isCommandFailure(error)) throw error;
    const beforeEffects = error instanceof GateReconcileRefused && ["no-gate", "not-frozen", "wrong-op-kind", "holder-alive", "holder-unknown", "liveness-unestablishable"].includes(error.condition);
    // The guard's own sentence names the freeze-holder and the next step for this condition.
    if (beforeEffects) throw new CommandFailure("refused", "LIFECYCLE_BLOCKED", `the native gate-repair guard refused (${error.condition}); the repair did not pass its pre-effect guard`, { target: { ...target, condition: error.condition }, native: { code: error.condition, detail: error.message }, remedy: "inspect the selected gate and the delivery liveness oracle; a timeout is not proof that its holder is gone" });
    throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native gate repair did not confirm completion; revocation, eviction or reopen work may have occurred. No mutation was retried", { target: { ...target, ...(error instanceof GateReconcileRefused ? { condition: error.condition } : {}) }, remedy: "re-observe this gate and its operation-bound native repair cursor before another explicit repair" });
  } finally { await nc.drain().catch(() => nc.close()); }
}

/** List local custodian records; drain only through the native creation-identity guards. */
async function runSeats(args: ParsedArgs): Promise<void> {
  validateMaintenanceArguments(args, "seats");
  const root = custodyRoot(), presentation = presentationOf(args.values), drain = args.values.drain === true;
  const target = { scope: "local-custody-store", root };
  const view = (result: { entries: Array<{ id: string; name: string | null; state: string; custodianPid: number | null; childPid: number | null }>; preview: boolean }): Report => ({ sections: [
    { title: result.preview ? "Review local seat drain" : "Retained local seats", blocks: result.entries.length ? [{ kind: "table", columns: [{ key: "name", label: "Agent" }, { key: "state", label: "Observed state" }, { key: "id", label: "Full seat identity" }, { key: "custodian", label: "Custodian PID" }, { key: "child", label: "Child PID" }], rows: result.entries.map((entry) => ({ name: entry.name ?? "not reported", state: { text: entry.state, tone: entry.state === "refused" ? "failed" : entry.state === "childless" ? "waiting" : "label" }, id: entry.id, custodian: entry.custodianPid === null ? "not reported" : String(entry.custodianPid), child: entry.childPid === null ? "not reported" : String(entry.childPid) })) }] : [{ kind: "lines", lines: ["No retained seat records were found in this local store."] }] },
    { blocks: [{ kind: "fields", rows: [["Store", root], ["Scope", "all safely childless records in this store when the native drain runs"], ["Live children", "kept"], ["Native diagnostic bodies", "omitted"]] }, { kind: "lines", lines: ["A custody record is not agent progress or mesh membership. The native drain re-reads creation identities; the review is not a reservation. A refused drain can include an unconfirmed custodian effect."] }] },
  ] });
  const project = (entries: Awaited<ReturnType<typeof drainSeats>>) => entries.map((entry) => ({ id: entry.id, name: entry.name ?? null, state: entry.state, custodianPid: entry.custodianPid ?? null, childPid: entry.childPid ?? null }));
  let before: ReturnType<typeof project>;
  try { before = project(await drainSeats(root)); }
  catch { throw new CommandFailure("refused", process.platform === "linux" ? "DEPENDENCY_UNAVAILABLE" : "UNSUPPORTED", "the native local custody inventory could not be read; no drain was submitted", { target }); }
  const refused = before.some((entry) => entry.state === "refused");
  if (!drain || args.values["dry-run"] || refused) {
    writeResult(presentation, { command: "manager", target, result: { kind: drain ? "manager-seat-drain-preview" : "manager-seat-census", entries: before, preview: drain, drainSubmitted: false }, ...(refused ? { completeness: "partial" as const, ...(drain ? { failure: new CommandFailure("refused", "LIFECYCLE_BLOCKED", "some native custody records are unresolved; no drain was submitted", { target, remedy: "inspect those full seat IDs before requesting a drain" }) } : { partial: { message: "Some native custody records are unresolved; this is an incomplete local observation, not proof that those seats are gone." } }) } : {}) }, view);
    return;
  }
  if (!before.some((entry) => entry.state === "childless")) {
    writeResult(presentation, { command: "manager", target, result: { kind: "manager-seat-drain", entries: before, preview: false, drainSubmitted: false }, noOp: true }, view);
    return;
  }
  if (!await confirmMaintenance(args, target, view({ entries: before, preview: true }), "Drain all safely childless records in the displayed local store? Live children stay.")) return;
  let entries: ReturnType<typeof project>;
  try { entries = project(await drainSeats(root, { drain: true })); }
  catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native seat drain did not return its complete census; effects were not retried", { target, remedy: "re-read the local seat census before another drain" }); }
  const incomplete = entries.some((entry) => entry.state === "refused"), changed = entries.filter((entry) => entry.state === "drained").map((entry) => ({ kind: "seat-record-drained", id: entry.id }));
  writeResult(presentation, { command: "manager", target, result: { kind: "manager-seat-drain", entries, preview: false, drainSubmitted: true }, ...(incomplete ? { completeness: "partial" as const, failure: new CommandFailure("unknown", "OPERATION_UNKNOWN", "some native drains did not confirm completion; confirmed removals are retained, but an unresolved custodian effect was not treated as unchanged", { target, changed, remedy: "re-read the full seat IDs; no drain was retried" }) } : { noOp: changed.length === 0 }) }, view);
}

const maintenanceOutputFlags = [jsonFlag, plainFlag,
  { name: "yes", short: "y", type: "boolean", description: "confirm the selected guarded gate repair or childless-seat drain" },
  { name: "dry-run", type: "boolean", description: "review the selected maintenance scope without submitting repair or drain effects" },
] as const satisfies readonly FlagSpec[];

/** The manager's commands: the `supervise` daemon runner, and the guarded `reconcile-gate` repair.
 *  Self-registered on import; the `cotal` binary resolves them from the registry. */
const managerCommands: Command[] = [
  {
    kind: "command",
    name: "__service-manager",
    hidden: true,
    prepareMeshTarget: false,
    group: "Manager",
    summary: "native manager child with protected launch identity and request-bound stop receipts",
    flags: [
      { name: "root", type: "string", description: "explicit registered mesh root" },
      { name: "space", type: "string", description: "explicit registered space" },
      { name: "server", type: "string", description: "registered broker URL without credentials" },
      { name: "runtime", type: "string", description: "explicit native seat runtime" },
      { name: "console-port", type: "string", description: "explicit native console port; zero allocates a port" },
      { name: "console-host", type: "string", description: "explicit native console bind host" },
      { name: "ws-port", type: "string", description: "the prepared broker websocket port" },
      { name: "max-sessions", type: "string", description: "explicit positive native session ceiling" },
      { name: "launch", type: "string", description: "private native launch spec for this selected space" },
      { name: "launch-sha256", type: "string", description: "full digest pinned by the saved service definition" },
      { name: "roster", type: "string", description: "absolute roster file whose agents start at launch" },
      { name: "service-instance", type: "string", description: "full controller-assigned instance ID" },
      { name: "launch-request", type: "string", description: "full original launch request ID" },
      { name: "state-directory", type: "string", description: "owned private launch state directory" },
      { name: "resume-attempt", type: "string", description: "maintenance resume attempt this launch serves" },
      { name: "resume-commit-file", type: "string", description: "protected one-read resume commit handoff file" },
      { name: "resume-commit-sha256", type: "string", description: "full digest of the resume commit handoff" },
    ],
    validate: (args) => { managerServiceChild(args); },
    requiredExtensions: (args) => typeof args.values.runtime === "string" && args.values.runtime !== "pty" ? [{ kind: "runtime", name: args.values.runtime }] : [],
    run: async (args) => {
      const service = managerServiceChild(args);
      try { await runManager(args, "auto", service); }
      catch { throw new CommandFailure("unknown", "OPERATION_UNKNOWN", "the native manager child did not establish its complete startup receipt; no replacement was launched and no diagnostic body was copied to stdout"); }
    },
  },
  {
    kind: "command",
    // The manager daemon `up` launches. `supervise` is the same entry for persisted callers, plus the
    // deprecation warning; help and completion list neither.
    name: "__daemon-manager",
    hidden: true,
    group: "Manager",
    summary:
      "run a manager - [--runtime <name>] (default pty; extension runtimes are explicit-only) [--space <s>] [--server <url>] [--console-port <n>] [--max-sessions <n>] [--roster <file>] [--launch <spec>] [--resume-attempt <id>]",
    flags: [
      { name: "space", type: "string", value: "<s>", description: "space to supervise (default: this folder's auth space; env COTAL_SPACE when unset)" },
      { name: "server", type: "string", value: "<url>", description: "broker URL (default: the local mesh; env COTAL_SERVER when unset)" },
      { name: "runtime", type: "string", value: "<name>", description: "agent runtime (default pty; others come from installed extensions)" },
      { name: "execution", type: "string", value: "<runtime|none>", description: "runtime by default; none requires a fresh hosting user-auth control instance and no runtime or startup workload" },
      { name: "console-port", type: "string", value: "<n>", description: "protocol-console port" },
      { name: "console-host", type: "string", value: "<host>", description: "bind host for the console endpoint (default: loopback)" },
      { name: "ws-port", type: "string", value: "<n>", description: "broker ws listener port for the console session client" },
      { name: "max-sessions", type: "string", value: "<n>", description: "live-session ceiling (default 64; one session per console pane, so size for agents × panes)" },
      { name: "roster", type: "string", value: "<file>", description: "declarative roster to boot at startup" },
      { name: "launch", type: "string", value: "<spec>", description: "resolved mesh-manifest launch spec (cotal up -f / spawn -f)" },
      { name: "resume-attempt", type: "string", value: "<id>", description: "maintenance restore attempt accepted by resumePreserved" },
      { name: "resume-commit-token", type: "string", value: "<token>", description: "deprecated: durable resume commit evidence on argv; prefer --resume-commit-file" },
      { name: "resume-commit-file", type: "string", value: "<path>", description: "protected one-read resume commit handoff file" },
      { name: "resume-commit-sha256", type: "string", value: "<hex>", description: "full digest of the resume commit handoff" },
      { name: "spawn", type: "string", value: "<names>", description: "comma-separated personas to pre-spawn at startup" },
    ],
    validate: (args) => { superviseExecution(args.values as Values); },
    requiredExtensions: (args) => {
      if (superviseExecution(args.values as Values) === "none") return [];
      const runtime = args.values.runtime;
      return typeof runtime === "string" && runtime !== "pty" ? [{ kind: "runtime", name: runtime }] : [];
    },
    run: (args) => runManager(args, "auto"),
  },
  {
    kind: "command",
    name: "reconcile-gate",
    group: "Manager",
    outputs: ["json", "plain"],
    prepareMeshTarget: false,
    validate: (args) => validateMaintenanceArguments(args, "reconcile"),
    summary:
      "reconcile an issuance gate left frozen by a crashed re-registration when boot cannot self-heal it - verifies the freeze-holder is gone, then completes the dead op (refuses if it is alive or unprovable) [--space <s>] [--server <url>] [--endpoint <e>] [--instance <id>]",
    flags: [...maintenanceOutputFlags,
      { name: "space", type: "string", value: "<s>", description: "space to reconcile in (default: this folder's auth space)" },
      { name: "server", type: "string", value: "<url>", description: "broker URL (default: the local mesh)" },
      { name: "endpoint", type: "string", value: "<e>", description: `endpoint whose gate is frozen (default: ${MANAGER_ENDPOINT})` },
      { name: "instance", type: "string", value: "<id>", description: "instance id (default: this folder's persisted manager instance)" },
    ],
    run: runReconcileGate,
  },
  {
    kind: "command",
    name: "deregister-instance",
    group: "Manager", hidden: true, reads: true, prepareMeshTarget: false,
    summary: "legacy spelling; use endpoint deregister <class> <full-instance-id>",
    outputs: ["json", "plain"],
    flags: [jsonFlag, plainFlag,
      { name: "space", type: "string", value: "<s>", description: "space the instance is registered in (default: this folder's auth space)" },
      { name: "server", type: "string", value: "<url>", description: "broker URL (default: the local mesh)" },
      { name: "endpoint", type: "string", value: "<e>", description: `endpoint the instance serves (default: ${MANAGER_ENDPOINT})` },
      { name: "instance", type: "string", value: "<id>", description: "instance id to deregister, the whole id as `cotal ps` prints it (default: this folder's persisted manager instance)" },
    ],
    validate: () => { throw new CommandFailure("refused", "USAGE_INVALID", "the legacy deregistration spelling no longer executes", { remedy: "use cotal endpoint deregister <class> <full-instance-id> [--space <space>] [--yes|--dry-run]" }); },
    run: async () => { throw new CommandFailure("refused", "USAGE_INVALID", "use cotal endpoint deregister <class> <full-instance-id> instead"); },
  },
  {
    kind: "command",
    name: "seats",
    group: "Manager",
    summary:
      "list the pty seat custodians an earlier Linux manager left on this machine - [--drain] retires each seat whose agent has exited and never signals one whose agent still runs",
    outputs: ["json", "plain"],
    reads: true,
    prepareMeshTarget: false,
    flags: [...maintenanceOutputFlags,
      { name: "drain", type: "boolean", description: "retire safely childless records in this local store; live children stay" },
    ],
    validate: (args) => validateMaintenanceArguments(args, "seats"),
    run: runSeats,
  },
];

const maintenance = [
  { name: "reconcile", source: "reconcile-gate", summary: "repair an owned manager issuance gate from its mesh root" },
  { name: "seats", source: "seats", summary: "inspect retained local seats; --drain removes only childless records" },
].map((mode) => {
  const source = managerCommands.find((command) => command.name === mode.source);
  if (!source) throw new Error(`manager command ${mode.source} is not registered`);
  const command: Command = { ...source, flags: source.flags?.map((flag) => flag.name === "space" ? { ...flag, short: "s" } : flag) };
  return { ...mode, command };
});
const maintenanceFlags = new Map<string, FlagSpec>();
for (const mode of maintenance) for (const flag of mode.command.flags ?? []) {
  const shared = maintenanceOutputFlags.some((common) => common.name === flag.name);
  maintenanceFlags.set(flag.name, { ...flag, description: shared ? flag.description : `${mode.name}: ${flag.description ?? ""}` });
}

function managerInvocation(args: ParsedArgs): { command: Command; args: ParsedArgs } | undefined {
  const parsed = parseCommandArgs(managerGroup, [...args.raw]);
  const mode = parsed.positionals[0];
  if (mode === undefined) {
    if (Object.keys(parsed.values).some((key) => !["json", "plain"].includes(key))) throw new CommandFailure("refused", "USAGE_INVALID", "choose manager reconcile or manager seats before its options");
    return undefined;
  }
  const child = maintenance.find((item) => item.name === mode);
  if (!child) throw new CommandFailure("refused", "USAGE_INVALID", "manager takes reconcile or seats");
  const index = parsed.positionalIndices?.[0];
  if (index === undefined) throw new Error("the manager subcommand has no parsed argument index");
  const words = args.raw.filter((_, position) => position !== index);
  return { command: child.command, args: parseCommandArgs(child.command, words) };
}

const managerGroup: Command = {
  kind: "command",
  name: "manager",
  aliases: ["mgr"],
  group: "Manager",
  summary: "inspect retained local seats or repair an owned manager gate",
  usage: "cotal manager [reconcile [--yes|--dry-run] | seats [--drain [--yes|--dry-run]]] [--json|--plain]",
  positionals: "[reconcile | seats]",
  outputs: ["json", "plain"],
  flags: [...maintenanceFlags.values()],
  subcommands: maintenance.map((mode) => ({ name: mode.name, summary: mode.summary, flagNames: mode.command.flags?.map((flag) => flag.name), outputs: mode.command.outputs, usage: mode.name === "seats" ? "cotal manager seats [--drain [--yes|--dry-run]] [--json|--plain]" : "cotal manager reconcile [--space <space>] [--server <url>] [--instance <id>] [--yes|--dry-run] [--json|--plain]" })),
  reads: true,
  prepareMeshTarget: false,
  validate: (args) => { presentationOf(args.values); const invocation = managerInvocation(args); return invocation?.command.validate?.(invocation.args); },
  async run(args) {
    const invocation = managerInvocation(args);
    if (invocation) return invocation.command.run(invocation.args);
    writeResult(presentationOf(args.values), { command: "manager", target: null, result: { kind: "manager-maintenance-commands", operations: maintenance.map(({ name, summary }) => ({ name, summary })), managerStarted: false } }, (): Report => ({ sections: [
      { title: "Manager maintenance", blocks: [{ kind: "commands", items: maintenance.map((mode) => ({ command: `cotal mgr ${mode.name}`, description: mode.summary })) }] },
      { blocks: [{ kind: "lines", lines: [{ text: "These commands start no manager. Repair and drain default to cancellation; scripted maintenance requires --yes. Preview the scope with --dry-run.", tone: "hint" }] }] },
    ] }));
  },
};

const daemonManager = managerCommands.find((command) => command.name === "__daemon-manager")!;
registry.register(...managerCommands.map((command) => command.name === "seats" || command.name === "reconcile-gate" ? { ...command, hidden: true } : command), deprecatedDaemonEntry("supervise", daemonManager), managerGroup, endpointDeregisterAction);
