import { UserProvision, userProvisionDeps, type ProvisionUserAgentOpts, type ProvisionedUserAgent, type UserAgentRefusal } from "./user-provision.js";
import { TurnRelay, goalKey, TURN_ANSWER_RETENTION_MS, type PendingTurn, type OnceRetire, type TurnAcceptance } from "./turn-relay.js";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { CotalEndpoint, accountFromCreds, DEFAULT_SERVER, DEV_OWNER, injectedSecretStoreIdentity, type DeprovisionResourceAccounting, type IssuedBinding, type IssuedStore, mintLifecycleUid, parsePrincipalKey, principalKey, probeConnect, resolveAuthProvider } from "@cotal-ai/core";
import { retainConnectorSeat } from "@cotal-ai/workspace";
import { agentSecretKeyForFile, DEFAULT_SEAT_CAP, findCotalRoot, loadManagerInstanceIdentity, manifestExtensionNames, materializeFromManifest, runtimeInstallHint, spaceKey, userAuthStateDir, workspaceSecretStore, type ManagerInstanceIdentity, type SeatCap } from "@cotal-ai/workspace";
import type { PersonaEndpoint, RunAdmission, Connector, LaunchModes, ControlReply, EpCaller, LaunchSpec, Presence, RuntimeProvider, RuntimeReference, SecretStore, SpaceAuth, StartupOutcome } from "@cotal-ai/core";
import {
  createRuntime,
  isCustodialRuntime,
  requireRuntimeAdopt,
  type AgentHandle,
  type Runtime,
  type RuntimeMode,
} from "./runtime/index.js";
import { Retirement, retirementDeps, type TeardownTarget } from "./retirement.js";
import type { ManagedAgent, SpawnHooks, StartAgentOpts } from "./seat-types.js";
export type { ManagedAgent, SpawnAcceptance, SpawnHooks, StartAgentOpts } from "./seat-types.js";
import { ServePlane, servePlaneDeps } from "./serve-plane.js";
import { NamesCapacity, namesCapacityDeps, type Occupancy } from "./names-capacity.js";
import { AttachEndpoint } from "./attach-endpoint.js";
import { ManagedStaticLifecycle, managedStaticLifecycleDeps, STATIC_RECONCILE_RETRY_DELAYS_MS } from "./managed-static-lifecycle.js";
export { STATIC_RECONCILE_RETRY_DELAYS_MS } from "./managed-static-lifecycle.js";
export { credRenewIntervalMs } from "./credential-renewal.js";
import { LeaseKeeper, leaseKeeperDeps } from "./lease-keeper.js";
export { ManagerInstanceLeaseHeld } from "./lease-keeper.js";
import { SessionRecovery, sessionRecoveryDeps } from "./session-recovery.js";
import { SeatCustody, seatCustodyDeps, watchConnectorHolder } from "./seat-custody.js";
import { GoalWriter, goalWriterDeps } from "./goal-writer.js";
import { SeatStop, seatStopDeps } from "./seat-stop.js";
import { CommandDispatch, commandDispatchDeps, participantKey } from "./command-dispatch.js";
import { SpawnGoal, spawnGoalDeps } from "./spawn-goal.js";
import { PersonaCatalog, personaCatalogDeps } from "./persona-catalog.js";
import { TerminalInput, terminalInputDeps } from "./terminal-input.js";
import { StatusAndModels, statusAndModelsDeps, MANAGER_VERSION } from "./status-and-models.js";
import { ReadinessWait, readinessWaitDeps } from "./readiness-wait.js";
import { BrokerTransport, brokerTransportDeps } from "./broker-transport.js";
import { StartDoors, startDoorsDeps } from "./start-doors.js";
import { HarnessResolution, harnessResolutionDeps } from "./harness-resolution.js";
import { ConnectorInventory } from "./connector-inventory.js";
import type { ManagerParts } from "./manager-parts.js";
import type { ManagerStartState } from "./manager-start-state.js";
import { Preservation, preservationDeps } from "./preservation.js";
import { PreservedResume, preservedResumeDeps } from "./preserved-resume.js";
export { PASTE_END, PASTE_START, RUNTIME_NO_TERMINAL_DETAIL } from "./terminal-input.js";
import { CredentialRenewal, credentialRenewalDeps } from "./credential-renewal.js";
import { SeatLaunch, seatLaunchDeps, type SpawnRun, type StaticSpawnBound } from "./seat-launch.js";
import { ManagerBoot, bootDeps } from "./boot.js";
import { withTimeout } from "./manager-timeout.js";
import { inlineSnapshotPath } from "./launch.js";
import { authorizeNamedControl } from "./authorize.js";
import { RunHosting } from "./run-hosting.js";
import { IdleExit, type IdleExitOptions } from "./idle-exit.js";
import { rejectionText, attemptCleanup, type CleanupFailure } from "@cotal-ai/core";
import { readReleasedSeatReference, type SeatRecord } from "./resume.js";
import { TranscriptReceiver } from "./transcript-receive.js";
// The static §13.1 lifecycle executor: the shared grammar/stores from core plus the
// manager-side adapter (transport + slot orchestration + the terminal) — see static-lifecycle.ts.
import { type LifecycleStateTransport, type StaticManagedSlotRow } from "@cotal-ai/core";
// The manager's ONE §13.6 session plane — offer mint + one-use redeem + PTY-bridge
// standup for `attach`, over a dedicated standing session-LEDGER connection (the byte rails ride
// per-session credentials on their own short-lived connections).
// The manager as an ordinary v0.4 `service` endpoint — the §13.1
// endpoint-serve credential subsystem (gate provisioning, registration barrier, mint fence) plus
// the register/authorize/serve seams, all driven over a scoped one-shot executor connection.
import { readEndpointGateGeneration, deregisterServiceInstance, type ServiceDeregistration, type GoalIndexEntry, turnNoticeSubject, EpEnvelopeError, type EpServeContext, type EpServeGrant, type EpServeHandle, type GoalRef, type Identity } from "@cotal-ai/core";
import { MANAGER_ENDPOINT, type ManagerStaticReconciliationStatus, type ManagerStopImpact } from "./manager-service-contract.js";
import type { NatsConnection } from "@nats-io/transport-node";
import type { KV } from "@nats-io/kv";
import type { ManagerConfig } from "./manager-config.js";

/** The bound on one {@link Connector.retireAfterExit} call. An expired bound is not proof: the debt
 *  stays and the turn sweep asks again. */
const ONCE_RETIRE_MS = 60_000;
/** Backstop for the detached-launch readiness race (#159 B1). `startAgent` waits on two REAL outcomes —
 *  the assigned id joining the mesh (presence) = started, the child process exiting = failed — NOT a
 *  liveness-inferring timer. This is only the last-resort bound for "neither happened in time": the launch
 *  is then reported UNCERTAIN (a non-success reply that does NOT deprovision — it may still be booting, or
 *  stuck before connector startup). Generous, since a real cold agent join can take several seconds. Held
 *  on the Manager's config ({@link ManagerConfig.readinessTimeoutMs}) so a test can shorten it. Exported so the
 *  launch-parity smoke can assert every launch client's request timeout OUTLIVES this window — the tier
 *  rule forbids the clients importing it directly. */
export const READINESS_TIMEOUT_MS = 30_000;
/** How long a once seat whose connector needs a confirmed startup waits for its startup watch to end,
 *  from its launch: the watch's 15s for the confirm prompt and 15s for its notice, plus 5s for the
 *  last read. The readiness window applies when it is longer. */
const STARTUP_OUTCOME_MS = 35_000;
/** At most this many retirements run at once (#4965). A retirement dials up to four fresh broker
 *  connections in turn and queues an eviction and an inventory on the delivery daemon's admin rail,
 *  each against a fixed deadline. A stop that started all 50 seats' retirements together lost most of
 *  them: on a shared 12-core host at load 41-58, 9 to 46 of 50 dials hit the broker's 2 s auth
 *  timeout, and up to 26 inventories waited past 5 s behind the other seats' evictions. Measured there
 *  at load about 51, 50 dials from one process: 35 failed when all ran at once, none at 16 (median
 *  1.9 s, near the 2 s limit), none at 8 with the shortest total (3.7 s, against 4.8 s at 4). At 8,
 *  one manager queues at most 8 evictions on the daemon, about 3 s of its work at that load. */
const RETIREMENT_CONCURRENCY = 8;
/** A hard preservation stop should settle quickly. The manager still waits and reports a partial
 * cut rather than pretending a child is gone. Held in ManagerOptions so fake runtimes can shorten it. */
const PRESERVE_STOP_TIMEOUT_MS = 10_000;

export interface ManagerOptions {
  space: string;
  /** Assert the embedding generation matches this Manager. Installed first-party connectors
   *  always use the Manager's captured generation, even when this assertion is omitted. */
  expectedConnectorGeneration?: string;
  /** Hosted pooled control requires signerless authority and either an explicit non-custodial
   * runtime or explicit execution: none. It never borrows local signing authority. */
  pooled?: boolean;
  /** Explicit seat/workflow execution capability. Omitted preserves runtime execution.
   * `none` accepts genuine hosting user-auth authority or pooled remote authority, never both,
   * and refuses any runtime. Local NONE requires a fresh or previously classified instance. */
  execution?: "runtime" | "none";
  servers?: string;
  name?: string;
  /** Spawn backend. `auto` (default) → pty; external runtimes are explicit-only. */
  runtime?: RuntimeMode;
  workspaceRoot?: string;
  /** Trusted embedding hook after native identity selection, before endpoint construction.
   *  It receives no key, credential or readiness claim. A rejection aborts this start. */
  onServiceIdentity?: (identity: ManagerServiceIdentity) => void | Promise<void>;
  /** The selected registration requires every launched connector session to publish events. */
  eventsRequired?: boolean;
  /** Trusted registration policy withholds tool payloads for every seat. */
  eventPayloadsWithheld?: boolean;
  /** Port for the console + attach HTTP/WS endpoint. 0 → ephemeral. */
  consolePort?: number;
  /** The broker's WebSocket listener port (loopback), allocated by `cotal up`. When set,
   *  the console page becomes a mesh §13.6 session client — `POST /session/<name>` returns the grant +
   *  a per-session cred + this ws URL. Absent ⇒ no console session client (the route 503s). */
  wsPort?: number;
  /** Bind address for the console endpoint, and the host it advertises in {@link Manager.consoleUrl}.
   *  Defaults to loopback, which keeps the console reachable only from this machine. Set it only if
   *  you intend to expose the console (see the security note on {@link AttachEndpoint}). A wildcard
   *  here binds every interface and still advertises loopback, since a wildcard is not an address a
   *  client can dial. The TERMINAL is unaffected either way: it rides the mesh session, not this face. */
  attachHost?: string;
  /** Internal/test override for the preservation child-exit deadline. */
  preserveStopTimeoutMs?: number;
  /** Internal/test override for the endpoint registration executor lifetime. */
  endpointServeExecutorExpiresInSeconds?: number;
  /** Restore attempt this fresh manager will accept for the admin resumePreserved control op. */
  resumeAttemptId?: string;
  /** Fsynced coordinator evidence recovered after commit but before finalize. */
  resumeDurableCommitToken?: string;
  /** Resolve connectors from the installed `cotal ext` manifest (lazy import + live-remove honored),
   *  as the published binary does. A library composition leaves this off and resolves only what its
   *  composition root imported — a direct `new Manager()` never implicitly reads the machine manifest. */
  installedExtensions?: boolean;
  /** The machine daemon's command for repairing host setup. Absent outside daemon hosting. */
  machineSetupCommand?: string;
  /** The {@link SecretStore} for EVERY secret this manager touches — the daemon-cred renewal write side
   *  (`remintDaemonCreds`) AND the per-agent standing-secret kinds (static creds / actor tokens /
   *  sentinel creds). ONE store, so a hosted composition (KMS/Vault) can never end up with the manager
   *  re-signing daemon creds into one store while it reads/writes agent creds through another (split
   *  authority). Defaults to the workstation FS store over `workspaceRoot`, so a local `cotal up` is
   *  unchanged. It must be the SAME store the delivery daemon reads (`runDelivery(args, store)`).
   *  `start()` and every later remint challenge the daemon's `reloadStoreIdentity` and refuse
   *  naming both stores when they diverge. No bound daemon is not a named store, so start
   *  proceeds and remint writes this store; a later daemon on a foreign store is refused on
   *  the next remint rather than certified by the earlier absence. A hung rail (request
   *  timeout) fails closed. An injected store declares its identity, or both processes set
   *  `COTAL_SECRET_STORE` to the same coordinate. */
  secretStore?: SecretStore;
  /** The global ceiling on concurrently live §13.6 sessions this manager will serve.
   *  Defaults to {@link MAX_LIVE_SESSIONS_DEFAULT}. Each session mints a credential and opens its
   *  own connection, and establishment is caller-triggered, so this is the process-level resource
   *  bound; exceeding it refuses `resource-exhausted` before either happens. Operator-set because
   *  the right number is deployment-shaped — the browser console holds one session per open pane,
   *  so size for agents × panes, not agent count. Set it with `cotal supervise --max-sessions` or
   *  `cotal up --max-sessions` (recorded on the mesh so a repair does not silently drop to 64).
   *  {@link ManagerSessionPlaneDeps.maxSessions} carries the per-caller-scoping residual. */
  maxSessions?: number;
  /** The ceiling on live seats this manager supervises for ONE owner. Defaults to
   *  {@link DEFAULT_SEAT_CAP}, under which {@link MAX_AGENTS} stays the only bound, so a
   *  single-owner mesh keeps every slot it had. An operator hosting several owners on one manager
   *  sets a number with `cotal supervise --seat-cap <n>`, so one owner cannot take the whole host;
   *  the value is recorded for the root, so a restart keeps it. A launch over the ceiling refuses
   *  `resource-exhausted` before the reserve, carrying the owner's count and the cap.
   *
   *  It is deliberately NOT the global ceiling in another spelling: {@link MAX_AGENTS} bounds the
   *  host, this bounds one tenant's share of it, and the two refusals name different remedies. */
  seatCap?: SeatCap;
  /** Stop once the manager has been idle for `afterMs`: it holds no seat, no spawn or control call
   *  is in flight, it drives no hosted workflow run, and no preservation or resume is open. The
   *  clock starts when `start()` returns and restarts whenever any of those appears. Off when absent. */
  idleExit?: IdleExitOptions;
  /** Remote manager-service prepare material. The participant owns every private seed; the host
   * returned only scoped JWTs. When present, local signer/static trust is forbidden and the
   * manager follows the remote authority path. */
  remoteAuthority?: {
    owner: string;
    actors: import("@cotal-ai/core").RemoteManagerActors;
    instanceId: string;
    lifecycleUid: string;
    identities: {
      supervisor: Identity;
      executor: Identity;
      serve: Identity;
      goalWriter: Identity;
      sessionLedger: Identity;
    };
    supervisorCreds: string;
    executorCreds: string;
    renewExecutor: () => Promise<string>;
    /** Host-issued, fully staged five-identity family. The callback validates response echoes
     * before returning, and the manager preflights all five before adopting any. */
    renewStandingBundle?: (processEpoch: number) => Promise<{
      supervisor: string; executor: string; serve: string; goalWriter: string; sessionLedger: string;
    }>;
    /** Immutable assigned data-account nkey. Pooled control never infers it from a slug. */
    accountPublicKey?: string;
    serveCreds: string;
    goalWriterCreds: string;
    sessionLedgerCreds: string;
    serveGrant: EpServeGrant;
    mintSessionServing: (args: { identity: Identity; endpoint: string; sessionId: string; epoch: number; exp: number }) => Promise<string>;
    /** One host-issued transfer reader over this instance's own transfer bucket, for one
     *  `transcript-receive` or sweep (docs/design/resume-transfer.md section 6). Absent: this
     *  manager refuses `transcript-receive`. */
    mintTransferReader?: (identity: Identity) => Promise<string>;
    mintRetirementRequester: (args: {
      identity: Identity;
      target: { owner: string; actor: string; lifecycleUid: string };
      opId: string;
      serveEpoch: number;
    }) => Promise<string>;
    /** Host-owned prerequisite for terminal retirement. It revokes the managed grant and completes
     * the host's resumable release/sweep while preserving this UID. Success means the terminal auth
     * barrier may start; failure keeps the alias held and is retried with the same operation id. */
    prepareAgentRetirement: (args: {
      target: { owner: string; actor: string; lifecycleUid: string };
      opId: string;
    }) => Promise<void>;
    /** Host-owned enrollment of a FRESH managed agent (#1972). The participant generates the standing
     * actorToken, writes it at 0600, and passes only its digest. The HOST picks the lifecycle UID —
     * it alone can see the retirement tombstones that make a UID unusable — so there is deliberately
     * no `lifecycleUid` input here, and the returned uid is what the spawn records. Absent on a
     * composition with no hosted storage: a signerless manager then refuses a user-mode spawn rather
     * than authoring a local grant the host knows nothing about. */
    enrollManagedAgent?: (args: {
      /** Stable across retries of an unlaunched enrollment, including a later spawn. */
      requestId?: string;
      target: {
        actor: string;
        tokenHash: string;
        role?: string;
        label?: string;
        capabilities?: string[];
        subscribe?: string[];
        allowSubscribe?: string[];
        allowPublish?: string[];
      };
      /** The served spawn request this enrollment answers, when a caller asked for it. The host
       *  makes the caller it saw publish that subject the helper's parent, or the run's starter for
       *  a run's spawn (SPEC 13.6). */
      spawn?: { served: string; runId?: string };
    }) => Promise<{
      owner: string;
      actor: string;
      lifecycleUid: string;
      sentinelCreds: string;
      subscribe: string[];
      allowSubscribe: string[];
      allowPublish: string[];
      agentBearerExchangeUrl: string;
    }>;
    /** Host-owned continuity check for a retained managed actor. A signerless participant cannot
     * validate the actor token or sentinel from public material alone, and must never receive the
     * provider's issuer/callout private records. Hosted compositions keep those records host-side
     * and return only the non-secret current authority shape. */
    validateRetainedAgent: (args: {
      owner: string;
      actor: string;
      lifecycleUid: string;
      actorToken: string;
      sentinelCreds: string;
    }) => Promise<import("@cotal-ai/core").RetainedAgentAuthority>;
    /** Host-owned boot enumeration. It returns parsed, owner-scoped manager goal-index entries and
     * never hands the participant records-stream consumer authority. */
    scanGoalIndex: () => Promise<import("@cotal-ai/core").GoalIndexEntry[]>;
    /** Fresh host-owned serve-time admin decision for a broker-authenticated caller tuple. */
    authorizeAdmin: (caller: { owner: string; actor: string; lifecycleUid: string }) => Promise<boolean>;
    /** Fresh host-owned participation decision for one exact personal caller lifecycle. The host
     * verifies the current foreground grant and `run` scope. The manager still proves live exact
     * presence before it issues its finite local lease. */
    authorizeParticipation?: (caller: { owner: string; actor: string; lifecycleUid: string }) => Promise<boolean>;
    /** Pinned public auth-service base used by retained managed children for fresh bearers. The
     * signerless Manager must select `agent-bearer --exchange-url`, never the local `--dir` arm. */
    agentBearerExchangeUrl: string;
    /** The closed host run callbacks. Workflow runs are hosted only when ALL are supplied; a
     * partial set refuses at construction, and absent means run-start/resume stay unavailable. */
    runHosting?: Pick<import("./run-hosting.js").RunHostingContext, "admitRun" | "submitRun" | "issueAttempt" | "issueOperator" | "renewRun" | "revokeRun" | "cancelRun">;
    /** Host-owned execution of one admitted delegated user intent (SPEC 13.16). Absent: a delegated
     * spawn and a delegated retirement are refused before any request. */
    executeDelegatedUserIntent?: (
      execute: import("@cotal-ai/core").RemoteDelegatedUserIntentExecutionRequest["execute"] & { intentId: string },
    ) => Promise<import("@cotal-ai/core").RemoteDelegatedUserIntentExecutionResult>;
  };
}

export interface ManagerStopOptions {
  /** Stop and deprovision managed agents. The default releases detachable local custody and stops
   *  only the in-process seats that cannot outlive the manager. A released seat keeps running and
   *  is recorded, so the next manager on this workspace adopts it, or retires it once its runtime
   *  proves it gone. A detachable seat that already exited is retired by this stop. */
  withAgents?: boolean;
}

/** Public identity selected by this manager before constructing its endpoint. Not a grant. */
export interface ManagerServiceIdentity {
  endpoint: string;
  instanceId: string;
  principal: EpCaller;
}

/** Manager-owned local data for a workstation adapter, never a caller or serve grant. */
export interface ManagerServiceObservation {
  registration: ManagerServiceIdentity & { epoch: number };
  stopImpact: ManagerStopImpact;
}

export type ManagerMaintenanceState = "active" | "preserving" | "preserved";

/** A manager-initiated stop: WHICH door stopped the seat, and — where a door had one — the
 *  authenticated wire principal that asked for it (`callerOf(ctx)` or the `caller` the door already
 *  resolved, never a name taken from the request payload). The stop family carries its principal
 *  inside the cause so the reap line can say who asked, not just that a stop happened: on a shared
 *  host several principals hold stop authority, and `u_alice.actor`'s despawn must not read
 *  identically to `u_bob.actor`'s. */
type FreeSlotStopCause =
  | { kind: "stopped-requested"; requester: string }
  | { kind: "stopped-self" }
  | { kind: "stopped-reap"; parent: string }
  | { kind: "stopped-shutdown" }
  | { kind: "stopped-once"; reason: string };

/** Which path gave up a seat's slot. Required at every `freeSlot` call, with no default: a default
 *  is how the one caller that matters ends up unlabelled, and the whole point of recording a cause
 *  is that an unexplained death cannot masquerade as a routine one. A new free path must name
 *  itself here or it will not compile. */
export type FreeSlotCause =
  | FreeSlotStopCause
  | "process-exit"
  | "pi-crash-loop"
  | "pi-recovery-failed"
  | "supervise-crash-loop"
  | "supervise-recovery-failed"
  | "session-bind-failed"
  | "resume-session-rebind-failed"
  | "carried-fork-refused"
  | "resume-custody-unrecorded"
  | "supervise-record-failed"
  | "inline-snapshot-changed";

export type ManagerResumeIdentity =
  // lifecycleUid is the agent's ORIGINAL incarnation uid (its durables are keyed by it): the resume
  // must recover it, not mint a fresh one, or a later teardown would orphan the real durables. It is
  // recorded here (from the live ManagedAgent) so recovery is uniform across all three modes.
  | { mode: "open"; id: string; lifecycleUid: string }
  | { mode: "static"; id: string; lifecycleUid: string; credential: { kind: "file"; path: string; sha256: string }; issued?: IssuedBinding }
  | {
      mode: "user";
      owner: string;
      actor: string;
      lifecycleUid: string;
      actorToken: { kind: "file"; path: string; sha256: string };
      sentinelCredential: { kind: "file"; path: string; sha256: string };
      health: { kind: "file"; path: string };
    };

/** A resumed seat's fork provenance: the session it forked, that session's title when it has one,
 *  and the SHA-256 the connector took over the source transcript it read. */
export interface ForkProvenance {
  source: string;
  title?: string;
  transcriptSha256: string;
  /** A carried resume (#1499): the host the transcript came from, and when its bytes were staged. */
  host?: string;
  transferredAt?: string;
}

export interface ManagerResumeAgent {
  space: string;
  name: string;
  /** The display name `set-name` last gave the seat; a relaunch restores it. Absent: `name`. */
  displayName?: string;
  role?: string;
  identity: ManagerResumeIdentity;
  launch: {
    connector: string;
    runtime: string;
    cwd: string;
    source:
      | { kind: "persona"; ref: string; configPath: string; configSha256: string }
      // An inline persona's seat: `ref` is the requested name and `configPath` its lifecycle's snapshot.
      | { kind: "inline"; ref: string; configPath: string; configSha256: string }
      | { kind: "manifest"; runId?: string; requested: string; hash: string; configPath: string; configSha256: string; manifestSha256?: string };
    model?: string;
    variant?: string;
    modes?: LaunchModes;
    /** Kickoff prompt from the persona/manifest launch form; a stale-restart re-submits it. */
    prompt?: string;
    subscribe?: string[];
    allowSubscribe: string[];
    allowPublish?: string[];
    capabilities?: string[];
    endpoints?: PersonaEndpoint[];
    events: boolean;
    eventPayloads?: boolean;
    askPermissions?: true;
    reasoningEvents?: true;
    shareTools?: readonly string[];
    /** Original connector fork source, not a captured id for the currently running host session. */
    forkSource?: string;
    /** Where the fork came from, as the seat recorded it once it forked (#1500). */
    resumed?: ForkProvenance;
    /** Exact current host session reported by a continuation-capable connector. */
    sessionId?: string;
    /** The connector's session pointer file on THIS host, when it declares one. Non-secret like
     *  every other reference this document carries: a path, never the session bytes. A preservation
     *  cut captures it so the destination can reopen the same session; without it the checkpoint
     *  carries no pointer and the continuity class is capped below what the connector declares. */
    sessionStatePath?: string;
    /** Values are deliberately not persisted: connector launch options are opaque and may be secrets. */
    unresolvedLaunchOptionKeys?: string[];
  };
  /** Host-local files that must survive the maintenance cut, including `.cotal/run` artifacts. */
  dependencies: string[];
  spawner: string;
  /** User-auth ledger delegation parent; distinct from manager process-ownership spawner. */
  authorityParent?: string;
  startedAt: string;
  /** The CHAT stream frontier at the preservation cut (issue #545): the resumed launch carries it
   *  as the seat's backfill floor so its boot backfill reads only what came after this incarnation
   *  had already consumed, instead of replaying the whole retained window. Absent when the manager
   *  held no local space authority to read the frontier at the cut (a remote-authority manager). */
  backfillFloor?: number;
}

/** A crash restart of a supervised seat (#4094): its policy, the deaths counted against it including
 *  this one, and the roster timestamp a new heartbeat must pass to count as its readiness. */
export interface SupervisedRestart {
  policy: { restarts: number; windowMs: number };
  crashes: number[];
  joinedAfter: number;
}

export interface ManagerResumeInventory {
  version: "cotal-manager-resume/v2";
  space: string;
  createdAt: string;
  agents: ManagerResumeAgent[];
}

export interface ManagerPreserveFailure {
  name: string;
  id: string;
  error: string;
}

export interface ManagerPreserveResult {
  ok: boolean;
  attemptId: string;
  state: Exclude<ManagerMaintenanceState, "active">;
  inventory: ManagerResumeInventory;
  failures: ManagerPreserveFailure[];
}

export interface ManagerPreservationPlan {
  ok: boolean;
  attemptId: string;
  state: "prepared" | "preserved";
  inventory: ManagerResumeInventory;
  failures: ManagerPreserveFailure[];
}

export interface ManagerPreserveOptions {
  attemptId: string;
  /** Must verify the coordinator's locked attempt and durably fsync the inventory before resolving. */
  persistInventory(inventory: ManagerResumeInventory): Promise<void>;
}

export interface ManagerResumeResult {
  ok: boolean;
  agents: Array<{ name: string; reply: ControlReply }>;
  error?: string;
}


const TURN_PARTICIPATION_TTL_MS = 5 * 60_000;

/** One native personal lifecycle that may receive workflow turns through this manager. */
interface PersonalTurnParticipant {
  name: string;
  owner: string;
  actor: string;
  uid: string;
  generation?: string;
  expiresAt: number;
}

/** The refusal a control instance with `execution: none` gives every launch, hosting, model and write door. */
const EXECUTION_NONE_REFUSAL = "execution: none forbids seat launch, workflow hosting, model inspection and caller-driven writes on this control instance; select the participant Manager with an instance-pinned manager-caller view";

/** The sha256 hex digest of a file's bytes. */
function fileDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The wire PRINCIPAL dot-form a managed agent's presence/control identity carries: user-mode
 *  entries already store it in `id`; static mints store the raw nkey there (the durable/teardown
 *  key), so the wire form derives under DEV_OWNER. Every comparison against an AUTHENTICATED wire
 *  id (presence card.id, control from.id) must go through this, never raw `a.id`. */
function managedPrincipal(a: { id: string; userOwner?: string }): string {
  return a.userOwner ? a.id : principalKey(DEV_OWNER, a.id).key;
}

/** How a once seat's startup watch ended, waited for until {@link STARTUP_OUTCOME_MS} after its
 *  launch or the readiness window, whichever is longer. A watch that has not ended by then, or a
 *  seat being stopped, answers what the handle reports at that moment. */
async function awaitStartupOutcome(a: ManagedAgent, launchedAt: number, readinessTimeoutMs: number, stopping: () => boolean): Promise<StartupOutcome> {
  const until = launchedAt + Math.max(readinessTimeoutMs, STARTUP_OUTCOME_MS);
  for (;;) {
    const outcome = a.handle.startupOutcome?.() ?? "pending";
    if (outcome !== "pending" || a.terminalizing || stopping() || Date.now() >= until) return outcome;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** A ManagerConfig the constructor may fill in. Only the Manager's constructor holds one. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** The config members known before the Manager's constructor body runs. */
type ManagerConfigSeed = Pick<ManagerConfig, "managerLifecycleUid" | "startedAtMs" | "shutdownReadiness" | "readinessTimeoutMs" | "staticReconcileRetryDelaysMs" | "goalAcceptanceRetentionMs">;

/** The seed, typed as the whole config. The parts are built from field initializers that run before
 *  the constructor body, so they receive the object while it holds only the seed; the constructor
 *  assigns every other member before it returns, and no part reads one during construction. */
function seededConfig(seed: ManagerConfigSeed): ManagerConfig {
  return seed as ManagerConfig;
}

/**
 * The agent supervisor: a long-lived mesh node that owns agent process lifecycle.
 * It serves control requests on the "manager" service and spawns/kills agents
 * through a pluggable {@link Runtime} (pty by default). It does NOT proxy agent
 * mesh traffic — terminal I/O streams over its own attach endpoint instead.
 */
export class Manager {
  /** The parts, filled at the end of the constructor once every part exists. Parts read a peer from it at use. */
  private readonly parts = {} as ManagerParts;
  /** The Manager's identity, operator settings and timing (see {@link ManagerConfig}). Declared ahead of
   *  the parts so each part built below receives this object; the constructor fills the rest in. */
  protected readonly config = seededConfig({
    managerLifecycleUid: mintLifecycleUid(),
    startedAtMs: Date.now(),
    shutdownReadiness: new AbortController(),
    readinessTimeoutMs: READINESS_TIMEOUT_MS,
    staticReconcileRetryDelaysMs: STATIC_RECONCILE_RETRY_DELAYS_MS,
    goalAcceptanceRetentionMs: TURN_ANSWER_RETENTION_MS,
  });

  /** See {@link ManagerOptions.installedExtensions}. */
  protected readonly installedExtensions: boolean;
  // Declared only: no own Runtime slot exists in the none arm.
  declare private readonly runtime: Runtime;
  /** One backend per kind a seat has asked for, beside {@link runtime}. The manager's own runtime
   *  stays the default and is never replaced by a later seat's choice. */
  private readonly runtimes = new Map<string, Runtime>();
  /** Internal test seam. Production leaves this undefined and uses the scoped delivery-admin evictor. */
  protected staticLifecycleEvict?: (principal: string) => Promise<import("@cotal-ai/core").EvictionResult>;
  protected readonly agents = new Map<string, ManagedAgent>();
  /** Lifecycle UIDs already handed to `Runtime.spawnDelegated`: a lifecycle is handed off at most
   *  once, so a lost create acknowledgement can never become a second create. */
  protected readonly delegatedLaunched = new Set<string>();
  /** The persisted serve nkey identity: reusing the SAME principal across restart keeps
   *  {@link provisionEndpointGateOpen} idempotent (no core barrier change) and gives verified
   *  eviction a stable target (the predecessor's connections under this principal). Set in start(). */
  protected managerServeIdentity!: Identity;
  /** The local instance identity {@link admitExecutionState} already resolved. The ordinary start
   *  adopts it instead of reading the same record again. */
  protected admittedLocalIdentity?: ManagerInstanceIdentity;
  /** #1577: dedicated connections (serve, goal-writer, session-ledger) whose transport is down while
   *  the client reconnects them, tracked by {@link BrokerTransport.trackTransport}. Such a connection is open
   *  (`isClosed()` is false under unbounded reconnects) yet the broker holds none of its rails, so
   *  the liveness responder must not grade the serve connection `bound`, and a stop closes rather
   *  than drains it ({@link retireConnection}). Keyed by the connection, so a re-dial that swaps in a
   *  fresh one starts from its own state. */
  protected readonly transportDown = new WeakSet<NatsConnection>();
  /** The workflow-run host (SPEC 14.3): the drives this incarnation holds, each on its own
   *  per-run credential and connection. Absent under a remote authority, which mints no driver
   *  credentials, so the `run-*` family refuses there rather than connecting on a weaker identity. */
  protected runHosting?: RunHosting;
  /** The live spawn goal ref for each managed agent name, so a despawn MID-GOAL
   *  drives the cancel path (transition -> cancel terminal). Cleared when the goal terminalizes. */
  protected agentGoals = new Map<string, GoalRef>();
  private turnRelayInstance?: TurnRelay;
  protected get turnRelay(): TurnRelay {
    return this.turnRelayInstance ??= new TurnRelay({
      goalWriter: () => this.goalWriterComponent.goalWriter,
      serviceServe: () => this.servePlane.serviceServe,
      space: this.config.space,
      managerInstanceId: () => this.managerInstanceId,
      execution: this.execution,
      executionRefusal: this.executionRefusal(),
      goalReconcileDone: () => this.goalWriterComponent.goalReconcileDone,
      readinessTimeoutMs: () => this.config.readinessTimeoutMs,
      adoptsSeats: () => this.auth !== undefined && !this.userMode,
      onceSeatReconciling: (uid) => this.staticLifecycle.pendingLifecycle(uid),
      assertGoalWriterEpochCurrent: (epoch) => this.assertGoalWriterEpochCurrent(epoch),
      emitGoalProgress: (ref, epoch, event) => this.emitGoalProgress(ref, epoch, event),
      noticeSeatTurns: (seat) => this.noticeSeatTurns(seat),
      turnExecutorEpoch: (name, owner, actor, uid) => this.turnExecutorEpoch(name, owner, actor, uid),
      endOnceSeat: (pending, reason) => this.endOnceSeat(pending, reason),
      findManagedByTarget: (target) => this.findManagedByTarget(target),
      stopOnceSeat: (agent, reason) => this.stopOnceSeat(agent, reason),
      watchOnceExit: (agent) => this.watchOnceExit(agent),
      retireOnceSeat: (seat) => this.retireOnceSeat(seat),
      forgetOnceWatch: (key) => { this.onceWatched.delete(key); },
    });
  }
  protected readonly participants = new Map<string, PersonalTurnParticipant>();
  /** Once tasks whose seat's exit is watched: that exit, not the spawn's outcome, settles the debt. */
  protected readonly onceWatched = new Set<string>();
  /** The complete boot task. stop() joins it after fencing static reconciliation, so a registration
   * already past an earlier shutdown check cannot finish after stop() returns. */
  private startTask?: Promise<void>;
  /** This instance's side of a carried resume transcript (#1499); absent where it has no transfer reader. */
  protected transcripts?: TranscriptReceiver;
  /** The one stop this manager runs, with the agent policy it was asked for. A stop takes seats out
   *  of `agents` before they have exited, so a second teardown would find none and report success
   *  while the first still waits on a live seat. */
  private stopTask?: { withAgents: boolean; done: Promise<void> };
  /** Retirements holding one of the {@link RETIREMENT_CONCURRENCY} slots. */
  private retirementsRunning = 0;
  /** Retirements waiting for a slot, oldest first. */
  private readonly retirementQueue: Array<() => void> = [];
  protected readonly attach: AttachEndpoint;
  protected ep!: CotalEndpoint;
  /** Written by ManagerBoot.start; declared ahead of the parts so each one built below receives it. */
  private readonly startState: ManagerStartState = { userMode: false };
  /** {@link ManagerStartState.auth}. */
  protected get auth(): SpaceAuth | undefined { return this.startState.auth; }
  protected set auth(value: SpaceAuth | undefined) { this.startState.auth = value; }
  /** {@link ManagerStartState.userMode}. */
  protected get userMode(): boolean { return this.startState.userMode; }
  protected set userMode(value: boolean) { this.startState.userMode = value; }
  /** The persisted LOGICAL instance id (SPEC 13.6 item 7): STABLE across restart, so a
   *  restart re-registers the SAME id with an ADVANCED epoch through the §13.1 gate (the successor
   *  fences the predecessor's epoch — the (i) fence bites on a real restart). It is the registration
   *  instanceId, the served-status id, the goal spec's executor.instanceId, the epe route, and the
   *  resolveExecutorEpoch key — DISTINCT from {@link ManagerConfig.managerLifecycleUid} (per-process: the presence
   *  node uid + the managerInstance audit coordinate every static activation records). Set in start(); undefined before. */
  protected get managerInstanceId(): string { return this.startState.managerInstanceId!; }
  protected set managerInstanceId(value: string) { this.startState.managerInstanceId = value; }
  protected readonly namesCapacity = new NamesCapacity(this.config, namesCapacityDeps(this), this.startState, this.parts);
  private readonly servePlane = new ServePlane(this.config, servePlaneDeps(this), this.parts, this.startState);

  protected resolveServeTarget(t: { owner: string; actor: string }): { lifecycleUid: string; mappingRevision: number } | undefined {
          if (this.config.remoteAuthority) {
            const key = principalKey(t.owner, t.actor).key;
            for (const a of this.agents.values()) if (a.id === key) return { lifecycleUid: a.lifecycleUid, mappingRevision: 0 };
            const participant = [...this.participants.values()].find((p) =>
              p.owner === t.owner && p.actor === t.actor && this.currentParticipant(p.owner, p.actor, p.uid) === p);
            return participant ? { lifecycleUid: participant.uid, mappingRevision: 0 } : undefined;
          }
          if (t.owner === DEV_OWNER) {
            for (const a of this.agents.values()) if (!a.userOwner && a.id === t.actor) return { lifecycleUid: a.lifecycleUid, mappingRevision: 0 };
            return undefined;
          }
          const key = principalKey(t.owner, t.actor).key;
          for (const a of this.agents.values()) if (a.userOwner && a.id === key) return { lifecycleUid: a.lifecycleUid, mappingRevision: 0 };
          return undefined;

  }
  protected readonly retirement = new Retirement(this.config, retirementDeps(this), this.startState);
  private readonly lease = new LeaseKeeper(this.config, leaseKeeperDeps(this), this.startState);
  /** Set at the top of `stop()`. `renewLease` returns at once once this is set, and its `gone` arm
   *  does not re-acquire: a manager that is stopping never puts its own key back. It also closes the
   *  lifecycle fence ({@link beginLifecycle}), so no spawn can launch a seat the stop never sees. */
  protected leaseStopping = false;
  /** The class-2 renewal owner's half-TTL schedule; armed only on auth meshes. */
  protected credRenewTimer?: ReturnType<typeof setInterval>;
  protected resumeCredRenewal?: () => void;
  protected daemonRenewalLeaseTimer?: ReturnType<typeof setInterval>;
  protected maintenanceState: ManagerMaintenanceState = "active";
  protected lifecycleInFlight = 0;
  private readonly idleExit: IdleExit | undefined;
  private lifecycleDrainWaiters: Array<() => void> = [];
  protected preservationGeneration = 0;
  protected preservationAttemptId?: string;
  protected unverifiedStops: Array<{ name: string; id: string; handle: AgentHandle; authoritative?: boolean; error?: string }> = [];
  protected preservationInventory?: ManagerResumeInventory;
  protected resumeRequired = false;
  protected resumeDurableCommitToken?: string;

  /** {@link BrokerTransport.dial}. */
  protected dial(...args: Parameters<BrokerTransport["dial"]>): ReturnType<BrokerTransport["dial"]> { return this.brokerTransportComponent.dial(...args); }

  /** {@link BrokerTransport.dialRemoteStanding}. */
  protected dialRemoteStanding(...args: Parameters<BrokerTransport["dialRemoteStanding"]>): ReturnType<BrokerTransport["dialRemoteStanding"]> { return this.brokerTransportComponent.dialRemoteStanding(...args); }

  protected readonly seatCustody = new SeatCustody(this.config, seatCustodyDeps(this), this.startState);

  protected readonly sessionRecovery = new SessionRecovery(this.config, sessionRecoveryDeps(this), this.startState, this.parts);

  get staticReconcileLastSweepResources(): {
    slots: {
      examined: number;
      retired: number;
      preservedForeign: number;
      preservedAdopted: number;
      deferred: number;
      terminalized: number;
      failed: number;
    };
    deprovision?: DeprovisionResourceAccounting;
  } | undefined { return this.staticLifecycle.resources(); }
  set staticReconcileLastSweepResources(value: {
    slots: {
      examined: number;
      retired: number;
      preservedForeign: number;
      preservedAdopted: number;
      deferred: number;
      terminalized: number;
      failed: number;
    };
    deprovision?: DeprovisionResourceAccounting;
  } | undefined) { this.staticLifecycle.setResources(value); }

  protected readonly staticLifecycle = new ManagedStaticLifecycle(this.config, managedStaticLifecycleDeps(this), this.startState, this.parts);

  /** User-mode provisioning owns no manager state: each dependency reads through at its use. */
  protected readonly userProvision = new UserProvision(this.config, userProvisionDeps(this), this.startState);

  /** Seat stop, exit, recursive reap and named despawn. Every dependency reads through at its use. */
  private readonly seatStopComponent = new SeatStop(this.config, seatStopDeps(this), this.parts, this.startState);

  /** The typed command table and its admission. Every dependency reads through at its use. */
  private readonly commandDispatch = new CommandDispatch(this.config, commandDispatchDeps(this), this.parts, this.startState);

  /** The spawn and launch goal path. Every dependency reads through at its use. */
  private readonly spawnGoalComponent = new SpawnGoal(this.config, spawnGoalDeps(this), this.parts, this.startState);

  /** The persona catalog doors. Every dependency reads through at its use. */
  private readonly personaCatalogComponent = new PersonaCatalog(this.config, personaCatalogDeps(this), this.startState, this.parts);

  /** Seat terminal input and attach sessions. Every dependency reads through at its use. */
  private readonly terminalInputComponent = new TerminalInput(this.config, terminalInputDeps(this), this.parts, this.startState);

  /** Status, seat list and model catalog reads. Every dependency reads through at its use. */
  private readonly statusAndModelsComponent = new StatusAndModels(this.config, statusAndModelsDeps(this), this.parts, this.startState);

  /** The launch readiness race and exit watch. Every dependency reads through at its use. */
  private readonly readinessWaitComponent = new ReadinessWait(this.config, readinessWaitDeps(this));

  /** Broker dials and scoped executor connections. Every dependency reads through at its use. */
  private readonly brokerTransportComponent = new BrokerTransport(this.config, brokerTransportDeps(this), this.parts, this.startState);

  /** The start and launch control doors. Every dependency reads through at its use. */
  private readonly startDoorsComponent = new StartDoors(this.config, startDoorsDeps(this), this.startState);

  /** Connector and harness resolution for a launch. Every dependency reads through at its use. */
  private readonly harnessResolutionComponent = new HarnessResolution(this.config, harnessResolutionDeps(this), this.parts);

  /** The connector inventory. It owns the connector rows and the boot notes. */
  private readonly connectorInventory: ConnectorInventory;


  /** Manager preservation and released-seat adoption. Every dependency reads through at its use. */
  private readonly preservationComponent = new Preservation(this.config, preservationDeps(this), this.startState, this.parts);

  /** Preserved-manager resume and its control doors. Every dependency reads through at its use. */
  private readonly preservedResumeComponent = new PreservedResume(this.config, preservedResumeDeps(this), this.parts, this.startState);

  /** The goal-writer connection and the goal index it reconciles. Every dependency reads through at its use. */
  private readonly goalWriterComponent = new GoalWriter(this.config, goalWriterDeps(this), this.parts, this.startState);

  /** Renewal of the manager's standing credentials. Every dependency reads through at its use. */
  private readonly credentialRenewal = new CredentialRenewal(this.config, credentialRenewalDeps(this), this.parts, this.startState);

  /** The launch pipeline's leaf steps. Every dependency reads through at its use. */
  private readonly seatLaunch = new SeatLaunch(this.config, seatLaunchDeps(this), this.parts, this.startState);

  /** Manager boot: execution admission, connect, registration and lease. Every dependency reads through at its use. */
  private readonly bootComponent = new ManagerBoot(this.config, bootDeps(this), this.parts, this.startState);

  constructor(opts: ManagerOptions) {
    const config: Mutable<ManagerConfig> = this.config;
    if (opts.expectedConnectorGeneration !== undefined && opts.expectedConnectorGeneration !== MANAGER_VERSION)
      throw new Error(`expected connector generation ${opts.expectedConnectorGeneration} differs from this Manager's loaded generation ${MANAGER_VERSION}; restart from the installed CLI`);
    if (opts.onServiceIdentity !== undefined && typeof opts.onServiceIdentity !== "function") throw new Error("manager onServiceIdentity must be a trusted embedding callback");
    if (opts.execution !== undefined && opts.execution !== "runtime" && opts.execution !== "none")
      throw new Error(`unknown manager execution capability ${JSON.stringify(opts.execution)}`);
    if (opts.execution === "none" && ((opts.pooled !== undefined && typeof opts.pooled !== "boolean") ||
        (opts.remoteAuthority !== undefined && (!opts.remoteAuthority || typeof opts.remoteAuthority !== "object" || Array.isArray(opts.remoteAuthority)))))
      throw new Error("execution: none requires boolean pooled and a non-null remote authority object when supplied");
    if (opts.execution === "none" && (opts.runtime !== undefined || (!!opts.pooled !== !!opts.remoteAuthority)))
      throw new Error("execution: none requires pooled signerless remote authority for remote composition, or genuine local authority, and no runtime option");
    if (opts.execution === "none" && opts.remoteAuthority && ["renewExecutor", "renewStandingBundle", "mintSessionServing", "mintRetirementRequester", "prepareAgentRetirement", "validateRetainedAgent", "scanGoalIndex", "authorizeAdmin", "authorizeParticipation"].some((key) =>
      typeof opts.remoteAuthority?.[key as keyof NonNullable<ManagerOptions["remoteAuthority"]>] !== "function"))
      throw new Error("execution: none requires complete closed remote authority callbacks before construction");
    if (opts.pooled && (!opts.remoteAuthority || (opts.execution !== "none" && (opts.runtime === undefined || opts.runtime === "auto" || opts.runtime === "pty"))))
      throw new Error("pooled control requires signerless remote authority and an explicit non-PTY runtime; local custodial execution is forbidden");
    if (opts.pooled && !opts.remoteAuthority?.renewStandingBundle)
      throw new Error("pooled control requires a closed host-issued all-duty renewal callback before construction");
    config.space = opts.space;
    config.servers = opts.servers;
    config.name = opts.name ?? "manager";
    config.workspaceRoot = opts.workspaceRoot ?? findCotalRoot();
    config.onServiceIdentity = opts.onServiceIdentity;
    config.eventsRequired = opts.eventsRequired === true;
    config.eventPayloadsWithheld = opts.eventPayloadsWithheld === true;
    config.maxSessions = opts.maxSessions;
    config.seatCap = opts.seatCap ?? DEFAULT_SEAT_CAP;
    this.idleExit = opts.idleExit && new IdleExit(opts.idleExit, () => this.agents.size === 0 && Object.values(this.pendingWork()).every((n) => n === 0) &&
      this.maintenanceState === "active" && !this.resumeRequired && !this.leaseStopping && (this.runHosting?.liveCount ?? 0) === 0, () => this.stop());
    config.remoteAuthority = opts.remoteAuthority;
    this.credentialRenewal.remoteExecutorCreds = opts.remoteAuthority?.executorCreds;
    this.credentialRenewal.remoteSupervisorCreds = opts.remoteAuthority?.supervisorCreds;
    if (opts.pooled && (!opts.remoteAuthority?.accountPublicKey ||
        accountFromCreds(opts.remoteAuthority.supervisorCreds) !== opts.remoteAuthority.accountPublicKey))
      throw new Error("pooled control requires a proved assigned account for its initial supervisor credential");
    if (opts.remoteAuthority) config.managerLifecycleUid = opts.remoteAuthority.lifecycleUid;
    config.secrets = opts.secretStore ?? workspaceSecretStore(this.config.workspaceRoot);
    if (opts.secretStore) this.credentialRenewal.secretStoreIdentity = injectedSecretStoreIdentity(opts.secretStore);
    this.installedExtensions = opts.installedExtensions ?? false;
    config.expectedConnectorGeneration = MANAGER_VERSION;
    config.machineSetupCommand = opts.machineSetupCommand;
    config.pooled = opts.pooled === true;
    config.execution = opts.execution === "none" ? "none" : "runtime";
    if (!this.config.remoteAuthority) {
      // A fresh root has no execution record, so construction does not read the identity. Records
      // survive identity retirement; only the currently stored identity's record can be claimed.
      const prefix = `manager-execution.${spaceKey(this.config.space)}.`;
      const dir = join(this.config.workspaceRoot, ".cotal");
      const hasRecord = existsSync(dir) && readdirSync(dir).some((name) => name.startsWith(prefix) && name.endsWith(".json"));
      if (hasRecord) {
        const local = loadManagerInstanceIdentity(this.config.workspaceRoot, this.config.space);
        if (local && existsSync(this.executionRecordPath(local.instanceId))) {
          this.bootComponent.claimExecutionRecord(local.instanceId);
          this.admittedLocalIdentity = local;
        }
      }
    }
    if (this.config.execution === "runtime") this.runtime = createRuntime(opts.runtime ?? "auto", `cotal-${this.config.space}`);
    if (opts.pooled && this.config.execution === "runtime" && isCustodialRuntime(this.requiredRuntime))
      throw new Error(`pooled control refuses custodial runtime "${this.requiredRuntime.kind}" before starting agents`);
    config.preserveStopTimeoutMs = opts.preserveStopTimeoutMs ?? PRESERVE_STOP_TIMEOUT_MS;
    config.endpointServeExecutorExpiresInSeconds = opts.endpointServeExecutorExpiresInSeconds;
    if (opts.resumeAttemptId && !/^[A-Za-z0-9_-]{1,128}$/.test(opts.resumeAttemptId))
      throw new Error("resumeAttemptId must be a safe token (letters, digits, _, -; max 128)");
    if (opts.resumeDurableCommitToken && !/^[a-f0-9]{64}$/.test(opts.resumeDurableCommitToken))
      throw new Error("resumeDurableCommitToken must be a lowercase 32-byte token");
    if (opts.resumeDurableCommitToken && !opts.resumeAttemptId)
      throw new Error("resumeDurableCommitToken requires resumeAttemptId");
    config.resumeAttemptId = opts.resumeAttemptId;
    this.resumeRequired = opts.resumeAttemptId !== undefined;
    this.resumeDurableCommitToken = opts.resumeDurableCommitToken;
    config.wsPort = opts.wsPort;
    this.attach = new AttachEndpoint(
      () => this.list(),
      // Initial /feed replay for a connecting console: the current peer roster.
      () => [{ event: "roster", data: this.ep?.getRoster() ?? [] }],
      opts.consolePort ?? 0,
      // The console's mesh §13.6 session establisher — injected ONLY when a broker ws
      // listener exists (cotal up allocated a wsPort). Never a second plane; it drives THE plane.
      opts.wsPort !== undefined ? (name) => this.establishConsoleSession(name) : undefined,
      // Loopback unless the OPERATOR said otherwise. A broker *dial* address is not a manager *bind*
      // address: deriving one from the other breaks every topology where they differ (a manager
      // supervising a broker on another host cannot bind that host's address at all, and a failover
      // list's first entry need not be the server actually selected). Exposure is therefore an
      // explicit decision; every other caller — an embedded Manager, a bare `cotal supervise` —
      // keeps the loopback-only console it always had.
      opts.attachHost ?? "127.0.0.1",
    );
    this.connectorInventory = new ConnectorInventory(
      { execution: this.execution, installedExtensions: this.installedExtensions, machineSetupCommand: this.config.machineSetupCommand, expectedConnectorGeneration: this.config.expectedConnectorGeneration },
      this.parts,
      (resumeOperation) => this.beginLifecycle(resumeOperation),
    );
    Object.assign(this.parts, {
      brokerTransport: this.brokerTransportComponent,
      connectorInventory: this.connectorInventory,
      credentialRenewal: this.credentialRenewal,
      goalWriter: this.goalWriterComponent,
      harnessResolution: this.harnessResolutionComponent,
      lease: this.lease,
      namesCapacity: this.namesCapacity,
      personaCatalog: this.personaCatalogComponent,
      preservation: this.preservationComponent,
      seatLaunch: this.seatLaunch,
      seatStop: this.seatStopComponent,
      servePlane: this.servePlane,
      spawnGoal: this.spawnGoalComponent,
    } satisfies ManagerParts);
  }

  get runtimeKind(): string {
    return this.config.execution === "none" ? "none" : this.requiredRuntime.kind;
  }

  /** Whether this manager's runtime opens a terminal stream on the seats it spawns, so a caller
   *  knows before it asks whether `attach` can open one here. A control instance with no execution
   *  spawns no seat, so it streams no terminal either. */
  get streamsTerminal(): boolean {
    return this.config.execution !== "none" && this.requiredRuntime.streamsTerminal;
  }

  get execution(): "runtime" | "none" {
    return this.config.execution;
  }

  protected executionRefusal(): string {
    return EXECUTION_NONE_REFUSAL;
  }

  /** A defensive last barrier, not a substitute Runtime. Entry admission runs before effects. */
  protected get requiredRuntime(): Runtime {
    if (this.config.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    return this.runtime;
  }

  /** Import the installed extension that provides a seat's runtime before {@link runtimeFor}
   *  resolves it, as {@link resolveConnector} does for a connector. On the published binary the
   *  manager process imports only its own runtime, so a seat that names another installed runtime
   *  found nothing in the registry and was refused as unknown. The manifest is consulted first, so a
   *  live `cotal ext remove` refuses the next launch even while an earlier import keeps the provider
   *  registered; seats already on that runtime keep their cached backend. A library composition
   *  resolves only what its root imported. The refusal names an official runtime's package. */
  protected async loadSeatRuntime(kind: string | undefined): Promise<void> {
    const asked = kind?.trim();
    if (!this.installedExtensions || this.config.execution === "none" || !asked || asked === "auto" || asked === "pty" || asked === this.runtime.kind) return;
    if (!manifestExtensionNames("runtime").includes(asked)) throw new Error(runtimeInstallHint(asked));
    await materializeFromManifest<RuntimeProvider>({ kind: "runtime", name: asked }, { hint: (ref) => runtimeInstallHint(ref.name), expectedGeneration: this.config.expectedConnectorGeneration });
  }

  /** The backend one seat launches, restarts, and is reaped through. An omitted or blank choice is
   *  this manager's own runtime. A named one is created once, cached by its resolved kind, and reused
   *  for every later seat of that kind. The manager's own runtime is never replaced. An unknown or
   *  unreachable runtime throws, and pooled control refuses a custodial one by the same rule the
   *  constructor applied to the manager's own. */
  protected runtimeFor(kind: string | undefined): Runtime {
    if (this.config.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    const asked = kind?.trim();
    if (!asked) return this.runtime;
    if (asked === "auto")
      throw new Error(`runtime "auto" chooses the manager's runtime, not one seat; omit runtime to use ${this.runtime.kind}`);
    if (asked === this.runtime.kind) return this.runtime;
    const cached = this.runtimes.get(asked);
    if (cached) return cached;
    const runtime = createRuntime(asked, `cotal-${this.config.space}`);
    if (this.config.pooled && isCustodialRuntime(runtime))
      throw new Error(`pooled control refuses custodial runtime "${runtime.kind}" before starting agents`);
    this.runtimes.set(runtime.kind, runtime);
    return runtime;
  }

  /** What a default process stop does with this manager's seats. `release` drops manager-local
   *  custody and leaves every seat running. `stop` means this runtime keeps its PTYs inside the
   *  manager process, so those seats close with it: the stop stops and deprovisions them, and still
   *  releases every seat that can outlive it. */
  get spareSeats(): "release" | "stop" {
    if (this.execution === "none") return "release";
    return this.requiredRuntime.kind !== "pty" || this.requiredRuntime.supportsRelease === true ? "release" : "stop";
  }

  /** Reattach this manager's runtime to a durable handle. Refuses by name when adopt is absent. */
  adoptRuntimeHandle(reference: RuntimeReference): AgentHandle {
    if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    return requireRuntimeAdopt(this.requiredRuntime, reference);
  }

  /** Snapshot this embedding's own registration and stop policy. It is not a fresh serving
   *  response, registration-leader read or authorization for another process to act. Wire callers
   *  still use status through its fresh owner/admin visibility gate. No credential or URL leaves. */
  localServiceObservation(): ManagerServiceObservation | undefined {
    const state = this.servePlane.serviceServe;
    if (!state) return undefined;
    const identity = this.serviceIdentityObservation();
    if (state.grant.endpoint !== identity.endpoint || state.grant.instanceId !== identity.instanceId || state.grant.owner !== identity.principal.owner) throw new Error("the manager's local service observation does not match its owned serve incarnation");
    const stopImpact = this.managerStatusData(undefined).stopImpact;
    if (!stopImpact) throw new Error("the manager did not expose its own native stop policy");
    // The local receipt keeps its revision-32 shape: an older controller's closed reader refuses an
    // extra key. The preserved-exit check reads the binding through `localPreservation` instead.
    const { preservation: _preservation, ...ordinary } = stopImpact;
    return { registration: { ...identity, epoch: state.grant.epoch }, stopImpact: ordinary };
  }

  /** The attempt and inventory digest this embedding holds while maintenance is not `active`, for
   *  its own native child only. Absent when active or before an inventory exists. */
  localPreservation(): { attemptId: string; inventorySha256: string } | undefined {
    return this.managerStatusData(undefined).stopImpact?.preservation;
  }

  protected serviceIdentityObservation(): ManagerServiceIdentity {
    if (!this.managerInstanceId || !this.managerServeIdentity) throw new Error("manager native service identity has not been selected");
    const principal: EpCaller = this.config.remoteAuthority
      ? { owner: this.config.remoteAuthority.owner, actor: this.config.remoteAuthority.actors.serve, uid: this.config.managerLifecycleUid }
      : { owner: DEV_OWNER, actor: this.managerServeIdentity.id, uid: this.config.managerLifecycleUid };
    return Object.freeze({ endpoint: MANAGER_ENDPOINT, instanceId: this.managerInstanceId, principal: Object.freeze(principal) });
  }

  /** The console page URL (manager-hosted, loopback). */
  get consoleUrl(): string {
    return this.attach.consoleUrl();
  }

  /**
   * The out-of-band route for the mesh the refusal is running on, as ONE paste-ready command.
   *
   * **A REMEDY A REFUSAL PRINTS IS AUTHORITY THE REFUSAL LENDS, AND BOTH HALVES OF THIS ONE WERE
   * WIDER THAN THE SENTENCE AROUND THEM.** The static half named `--profile observer`, and `mint`
   * reads `--allow-subscribe` only for the agent profile while the observer arm of `permissionsFor`
   * hardcodes `chat.>`: an operator narrowing a reader to one event plane was handed a reader of every
   * channel in the space. The user half named a bare `cotal actor grant`, and an omitted flag there is
   * not "leave it alone" but the WIDE default (`>` read, `>` post, `spawn,run,role:default` scope), so the same
   * sentence handed out a full-mesh reader-writer with spawn and workflow scope. The static half was found by RUNNING
   * the printed command and decoding what it produced; the user half was found by READING it against
   * `runActor`'s defaults. Neither is the only way in, and a remedy string is not proved by either
   * one alone.
   *
   * So the command is spelled out in full and only ONE is printed: the one for the mesh this manager
   * is actually running, because a sentence carrying both routes is a sentence an operator picks the
   * wrong half of. `smoke:events-grant` section 9 runs the static half and grades the credential;
   * `smoke:user-spawn:live` section E runs the user half and grades the row.
   *
   * It takes NO mode argument, on purpose. It used to, and the resume door passed the resumed
   * DOCUMENT's (`entry.identity.mode === "user"`) rather than the manager's: those agree on an honest
   * inventory and disagree on the shape section 8 exercises, a user-mode record under a static
   * manager, where it handed a static operator `cotal actor grant` for a mesh with no actor ledger to
   * write it to. The operator reading the refusal is on the manager's mesh, never on the record's. A
   * boolean parameter is how that happened, so the mode is read from `this` and a third door cannot
   * pass the wrong one.
   *
   * The selector below reads the three-valued mesh mode (`open | static | user`), not a boolean
   * derived from it (#567). `this.userMode` is `false` for BOTH static and open, so a boolean
   * selector collapses those two and an open mesh was handed the static route (`cotal mint
   * --provision`), which `mint` refuses outright on an open mesh. A boolean also has no third
   * state to invert, so a mutation grid over `return this.userMode ? … : …` proves the one arm it
   * has is load-bearing but is structurally blind to a missing arm: there is no mutant that turns
   * "two arms" into "three arms". Switching on `meshMode` gives a fourth mesh mode nowhere to fall
   * silently, since `switch` has no default arm to catch it.
   */
  protected get meshMode(): "open" | "static" | "user" {
    if (this.userMode) return "user";
    if (this.auth !== undefined) return "static";
    return "open";
  }


  protected readerRemedy(owner: string, channel: string): string {
    switch (this.meshMode) {
      case "user":
        return (
          `\`cotal actor grant <reader> --owner ${owner} --scope '' --allow-subscribe '${channel}' ` +
          `--allow-publish ''\`, with every field spelled out: \`actor grant\` is an upsert of the ` +
          `WHOLE row, and an omitted flag is refused, or with \`--full\` is the WIDE default (\`>\` read, \`>\` post, \`spawn,run,role:default\` ` +
          `scope).`
        );
      case "static":
        return (
          `\`cotal auth mint <reader> --profile agent --allow-subscribe ${channel} --provision\`, where there ` +
          `is no actor ledger for \`actor grant\` to write to. The AGENT profile, not the observer ` +
          `one: \`auth mint\` reads --allow-subscribe only for that profile, so an observer mint is ` +
          `refused outright and writes no creds file.`
        );
      case "open":
        return (
          `there is nothing to grant on an open mesh: it has no credentials and no ACLs, so any peer ` +
          `may read \`${channel}\` by connecting bare and listing that channel (\`cotal join\` or an ` +
          `endpoint whose channels include it); this refusal stands because the own-channel rule ` +
          `applies to every mesh, and a spawn is not the place to hand out a read on another agent's ` +
          `tool inputs and outputs.`
        );
    }
  }

  start(): Promise<void> {
    if (this.startTask) return this.startTask;
    const task = this.bootComponent.runStart().then(() => this.idleExit?.arm());
    let wrapped!: Promise<void>;
    wrapped = task.finally(() => {
      if (this.startTask === wrapped) this.startTask = undefined;
    });
    this.startTask = wrapped;
    return wrapped;
  }

  protected executionRecordPath(instanceId: string): string {
    return join(this.config.workspaceRoot, ".cotal", `manager-execution.${spaceKey(this.config.space)}.${instanceId}.json`);
  }


  /** The delivery shard whose lease names the process that reloads the standing credentials.
   *  Delivery is single-shard today and the endpoint's own responder reads row 0; naming it here
   *  keeps the manager's binding check and that reply arguing about the same row. */
  static readonly DELIVERY_SHARD = 0;
  /** {@link CredentialRenewal.absentByLeaseRow}. */
  absentByLeaseRow(...args: Parameters<CredentialRenewal["absentByLeaseRow"]>): ReturnType<CredentialRenewal["absentByLeaseRow"]> { return this.credentialRenewal.absentByLeaseRow(...args); }
  /** {@link CredentialRenewal.claimDaemonRenewalOwnership}. */
  protected claimDaemonRenewalOwnership(...args: Parameters<CredentialRenewal["claimDaemonRenewalOwnership"]>): ReturnType<CredentialRenewal["claimDaemonRenewalOwnership"]> { return this.credentialRenewal.claimDaemonRenewalOwnership(...args); }

  /** {@link CredentialRenewal.boundedReconnect}. */
  protected boundedReconnect(...args: Parameters<CredentialRenewal["boundedReconnect"]>): ReturnType<CredentialRenewal["boundedReconnect"]> { return this.credentialRenewal.boundedReconnect(...args); }
  /** {@link CredentialRenewal.renewDaemonCreds}. */
  protected renewDaemonCreds(...args: Parameters<CredentialRenewal["renewDaemonCreds"]>): ReturnType<CredentialRenewal["renewDaemonCreds"]> { return this.credentialRenewal.renewDaemonCreds(...args); }
  /** {@link CredentialRenewal.renewRemoteExecutor}. */
  protected renewRemoteExecutor(...args: Parameters<CredentialRenewal["renewRemoteExecutor"]>): ReturnType<CredentialRenewal["renewRemoteExecutor"]> { return this.credentialRenewal.renewRemoteExecutor(...args); }
  /** {@link CredentialRenewal.renewRemoteStandingBundle}. */
  protected renewRemoteStandingBundle(...args: Parameters<CredentialRenewal["renewRemoteStandingBundle"]>): ReturnType<CredentialRenewal["renewRemoteStandingBundle"]> { return this.credentialRenewal.renewRemoteStandingBundle(...args); }
  /** {@link CredentialRenewal.renewRemoteBeforeRedial}. */
  protected renewRemoteBeforeRedial(...args: Parameters<CredentialRenewal["renewRemoteBeforeRedial"]>): ReturnType<CredentialRenewal["renewRemoteBeforeRedial"]> { return this.credentialRenewal.renewRemoteBeforeRedial(...args); }

  /** Admit one lifecycle/control operation while active. The synchronous increment is the fence:
   * preserveState and stop close it before their first await, so work is either counted or rejected. */
  protected beginLifecycle(resumeOperation = false): (() => void) | undefined {
    if (this.leaseStopping || this.maintenanceState !== "active" || (this.resumeRequired && !resumeOperation)) return undefined;
    this.lifecycleInFlight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseLifecycle();
    };
  }

  protected releaseLifecycle(): void {
    this.lifecycleInFlight--;
    if (this.lifecycleInFlight !== 0) return;
    const waiters = this.lifecycleDrainWaiters;
    this.lifecycleDrainWaiters = [];
    for (const wake of waiters) wake();
  }
  protected trackDeprovision(a: TeardownTarget, context = ""): void { this.retirement.trackDeprovision(a, context); }

  /** The work a stop would cut short, as `status` reports it in `stopImpact`. `cotal manager stop`
   *  refuses while any is pending, and the idle clock does not run. */
  protected pendingWork() {
    return { lifecycleInFlight: this.lifecycleInFlight, reservedLaunches: this.namesCapacity.reservedCount, retirementsPending: this.retirement.pendingCount, deprovisioningInFlight: this.retirement.inFlightCount, staticReconciliationInFlight: this.staticLifecycle.sweepsInFlight };
  }

  protected async awaitLifecycleDrain(): Promise<void> {
    if (this.lifecycleInFlight === 0) return;
    await new Promise<void>((resolve) => this.lifecycleDrainWaiters.push(resolve));
  }

  protected maintenanceError(): string {
    if (this.leaseStopping) return "manager is stopping; new lifecycle/control work is fenced";
    if (this.resumeRequired) return `manager is waiting for resume attempt ${this.config.resumeAttemptId}; ordinary lifecycle/control work is fenced`;
    return `manager is in ${this.maintenanceState} mode; new lifecycle/control work is fenced`;
  }

  /** {@link Preservation.preparePreservation}. */
  preparePreservation(...args: Parameters<Preservation["preparePreservation"]>): ReturnType<Preservation["preparePreservation"]> { return this.preservationComponent.preparePreservation(...args); }


  /** {@link Preservation.runPreparation}. */
  runPreparation(...args: Parameters<Preservation["runPreparation"]>): ReturnType<Preservation["runPreparation"]> { return this.preservationComponent.runPreparation(...args); }

  /** {@link Preservation.commitPreservation}. */
  commitPreservation(...args: Parameters<Preservation["commitPreservation"]>): ReturnType<Preservation["commitPreservation"]> { return this.preservationComponent.commitPreservation(...args); }

  /** {@link Preservation.abortPreservation}. */
  abortPreservation(...args: Parameters<Preservation["abortPreservation"]>): ReturnType<Preservation["abortPreservation"]> { return this.preservationComponent.abortPreservation(...args); }

  /** {@link Preservation.preserveState}. */
  preserveState(...args: Parameters<Preservation["preserveState"]>): ReturnType<Preservation["preserveState"]> { return this.preservationComponent.preserveState(...args); }


  /** {@link Preservation.awaitHandleExit}. */
  protected awaitHandleExit(...args: Parameters<Preservation["awaitHandleExit"]>): ReturnType<Preservation["awaitHandleExit"]> { return this.preservationComponent.awaitHandleExit(...args); }

  /** {@link Preservation.inventoryReferenceError}. */
  protected inventoryReferenceError(...args: Parameters<Preservation["inventoryReferenceError"]>): ReturnType<Preservation["inventoryReferenceError"]> { return this.preservationComponent.inventoryReferenceError(...args); }

  protected fileDigest(path: string): string { return fileDigest(path); }


  /** {@link PreservedResume.resumeEntry}. */
  protected resumeEntry(...args: Parameters<PreservedResume["resumeEntry"]>): ReturnType<PreservedResume["resumeEntry"]> { return this.preservedResumeComponent.resumeEntry(...args); }

  /** {@link PreservedResume.resumeEntryOf}. */
  protected resumeEntryOf(...args: Parameters<PreservedResume["resumeEntryOf"]>): ReturnType<PreservedResume["resumeEntryOf"]> { return this.preservedResumeComponent.resumeEntryOf(...args); }

  /** {@link Preservation.teardownManagedAgents}. */
  private teardownManagedAgents(...args: Parameters<Preservation["teardownManagedAgents"]>): ReturnType<Preservation["teardownManagedAgents"]> { return this.preservationComponent.teardownManagedAgents(...args); }

  /** {@link Preservation.isProcessBoundSeat}. */
  protected isProcessBoundSeat(...args: Parameters<Preservation["isProcessBoundSeat"]>): ReturnType<Preservation["isProcessBoundSeat"]> { return this.preservationComponent.isProcessBoundSeat(...args); }



  private async stopRetainedAgentsOnExit(): Promise<void> {
    const managed = [...this.agents.values()];
    for (const a of managed) a.suppressCleanup = true;
    const failures: string[] = [];
    await Promise.all(managed.map(async (a) => {
      try {
        // No cut holds a delegated seat (runPreparation refuses one), so stopping it is its retirement.
        if (a.handedOff) await this.deprovision(this.seatStopComponent.teardownTarget(a));
        else a.handle.stop({ graceful: false });
      } catch (e) {
        failures.push(`${a.name}: stop failed: ${rejectionText(e)}`);
        // A refused hard stop never reached the child, so waiting for its exit could only time out
        // and restate this failure; the cut path reports it the same way. A delegated seat's
        // deprovision can fail after its retirement already closed the seat, so that wait stays.
        if (!a.handedOff) return;
      }
      try {
        await this.awaitHandleExit(a.handle);
        if (this.agents.get(a.name) === a) this.agents.delete(a.name);
      } catch (e) {
        failures.push(`${a.name}: ${rejectionText(e)}`);
      }
    }));
    if (failures.length)
      throw new Error(`manager preservation shutdown incomplete: ${failures.join("; ")}`);
  }

  /** Every call joins the first stop and settles with it. A call that asks for a different
   *  `withAgents` is refused, since the running stop has already applied its own policy. */
  stop(options: ManagerStopOptions = {}): Promise<void> {
    const withAgents = options.withAgents === true;
    this.stopTask ??= { withAgents, done: this.stopOnce(withAgents) };
    if (this.stopTask.withAgents === withAgents) return this.stopTask.done;
    return Promise.reject(new Error(`manager is already stopping ${this.stopTask.withAgents ? "with" : "without"} its agents`));
  }

  private async stopOnce(withAgents: boolean): Promise<void> {
    this.leaseStopping = true;
    this.idleExit?.disarm();
    this.config.shutdownReadiness.abort();
    this.credentialRenewal.stopRetries();
    this.transcripts?.stop();
    this.staticLifecycle.stop();
    const starting = this.startTask;
    await this.staticLifecycle.awaitStaticReconcileDrain();
    await starting?.catch(() => {});
    if (this.lease.leaseTimer) clearInterval(this.lease.leaseTimer);
    if (this.credRenewTimer) clearInterval(this.credRenewTimer);
    if (this.credentialRenewal.endpointServeRenewalTimer) clearTimeout(this.credentialRenewal.endpointServeRenewalTimer);
    if (this.daemonRenewalLeaseTimer) clearInterval(this.daemonRenewalLeaseTimer);
    if (this.servePlane.sessionKeyRenewTimer) clearInterval(this.servePlane.sessionKeyRenewTimer);
    // A renew already in flight when the timer was cleared above must be awaited, not raced: it can
    // still move the key's revision after we clear the timer, and releasing against a cached
    // revision it has since moved is a CAS the broker correctly refuses, silently, forever.
    await this.lease.leaseRenewTask?.catch(() => {});
    // Join the bounded Manager renewal. Its stop/deadline fence refuses late adoption, but the
    // host still owns any submitted issuance and its outcome can remain unknown after timeout.
    await this.credentialRenewal.remoteBundleRenewal?.catch(() => {});
    // A spawn admitted before the fence closed may still be launching. Its seat must be in the
    // snapshot below, or it would outlive a stop that reported success.
    await this.awaitLifecycleDrain();
    let releaseFailures: string[] = [];
    let seatFailure: string | undefined;
    try {
      if (this.maintenanceState === "active" && !this.resumeRequired) {
        if (withAgents) await this.teardownManagedAgents();
        else {
          // An in-process seat cannot be detached from the process that is exiting, and a released
          // seat that already exited cannot come back, so the default stop stops and deprovisions
          // both as `withAgents` does instead of orphaning their footprints.
          const detached = this.preservationComponent.releaseManagedAgents();
          releaseFailures = detached.failures;
          await this.teardownManagedAgents(detached.stop);
        }
      } else {
        // A signal after a partial preservation must never fall back into destructive teardown.
        await this.stopRetainedAgentsOnExit();
      }
    } catch (e) {
      seatFailure = rejectionText(e);
    }
    // Every step below runs even when an earlier one fails, so a failed stop still closes this
    // process's connections and listener (#2290). Failures are collected and thrown at the end.
    const failures: string[] = [];
    const step = async (name: string, run: () => Promise<unknown> | undefined): Promise<void> => {
      try {
        await run();
      } catch (e) {
        failures.push(`${name}: ${rejectionText(e)}`);
      }
    };
    // The expiry that would end a chat session stops with this process, and nothing can adopt one,
    // so an active stop retires every session this process admitted, under either agent policy, as
    // it does an in-process seat. A preserving stop leaves them to the next start's sweep.
    if (this.maintenanceState === "active" && !this.resumeRequired) await step("retire chat sessions", () => this.staticLifecycle.retireChatSessionsOnStop());
    else this.staticLifecycle.reportChatSessionsLeftAtStop(this.resumeRequired ? "this manager is waiting for a resume" : "this manager is preserving its state");
    // A seat that may still be alive keeps this instance's leases and registration (see
    // teardownManagedAgents): they lapse on their TTL instead of being handed to a successor.
    if (seatFailure === undefined) {
      await step("release manager lease", () => this.lease.releaseOwnManagerLease());
      // #1634: hand the renewal lease back on a clean stop so a sibling picks it up on its next pass
      // rather than waiting out the bucket TTL. A non-owner holds no revision and this is a no-op.
      await step("release renewal lease", () => this.ep.releaseDaemonRenewalLease());
    }
    // Capture BEFORE the serve loop is torn down: `stopServiceServe` clears the state, and what is
    // being asked here is "which registration did this process write", which only the state
    // before teardown can answer. Deregistration runs AFTER the serve loop has drained, so no
    // in-flight command can write a status back onto the record it just removed.
    const registrationRevision = this.servePlane.serviceServe?.grant.registrationRevision;
    await step("stop service serve", () => this.stopServiceServe());
    // The drives AFTER the serve loop (no new `run-start` can land) and BEFORE deregistration: a
    // released run's status write is the last thing this incarnation says about it.
    await step("stop run hosting", () => this.runHosting?.stop());
    this.runHosting = undefined;
    if (registrationRevision !== undefined && seatFailure === undefined)
      await step("deregister service", () => this.deregisterServiceOnStop(registrationRevision));
    await step("stop goal writer", () => this.goalWriterComponent.stopGoalWriter());
    await step("stop session plane", () => this.servePlane.stopSessionPlane());
    await step("stop endpoint", () => this.ep.stop());
    await step("stop attach endpoint", () => this.attach.stop());
    const also = failures.length ? `; teardown also failed: ${failures.join("; ")}` : "";
    if (seatFailure !== undefined) throw new Error(`${seatFailure}${also}`);
    if (releaseFailures.length)
      throw new Error(`manager shutdown could not release every detachable seat: ${releaseFailures.join("; ")}${also}`);
    if (failures.length) throw new Error(`manager shutdown incomplete: ${failures.join("; ")}`);
  }

  /**
   * REMOVE THIS INSTANCE'S SERVICE REGISTRATION on a clean stop (§13.5 deregistration).
   *
   * The registry records registration, not liveness, and nothing expires a row. Without this, every
   * manager that has ever run in a space leaves a record claiming a live instance forever: each one
   * is frozen into every later class scatter, none of them answers, and each costs the full gather
   * deadline — on every `cotal ps`, `stop` and `attach` in that space, for good. A manager that is
   * shutting down is the one participant that KNOWS it is going away, so it says so.
   *
   * The delete is pinned to the `registrationRevision` this process registered at, so a successor
   * that persists the SAME instanceId and has already re-registered loses nothing to a slow stop here.
   *
   * Best-effort and LOUD, matching every other teardown step: a broker that is already gone must not
   * turn a stop into a failure, but a registration that survives a stop is the exact defect this
   * exists to prevent, so a failure to remove it is printed with the operator's own repair verb
   * rather than swallowed. It is not fatal because a crash leaves the same state and the operator
   * verb handles both.
   */
  private async deregisterServiceOnStop(registrationRevision: number): Promise<void> {
    const iid = this.managerInstanceId;
    const dereg = ({ recordsKv, authKv }: { recordsKv: KV; authKv: KV }): Promise<ServiceDeregistration> =>
      deregisterServiceInstance(recordsKv, {
        endpoint: MANAGER_ENDPOINT,
        instanceId: iid,
        registrationRevision,
        observeGeneration: () => readEndpointGateGeneration(authKv, { endpoint: MANAGER_ENDPOINT, instanceId: iid }),
      });
    try {
      const outcome = await ((this.auth || this.config.remoteAuthority)
        ? this.withEndpointServeExecutor(dereg)
        : this.withOpenServeConnection(dereg));
      if (outcome.removed)
        console.error(`✓ deregistered manager instance ${iid} from the ${MANAGER_ENDPOINT} service registry (spec revision ${outcome.specRevision})`);
      else if (outcome.reason === "superseded")
        console.error(`! manager instance ${iid} was not deregistered: another incarnation has registered it since this process did - leaving it alone`);
      else if (outcome.reason === "registration-in-flight")
        console.error(`! manager instance ${iid} was not deregistered: a registration is still in flight (governance slot held at the live gate generation) - leaving it alone`);
      // `absent` is silent: there was nothing registered to remove, which is not news at shutdown.
    } catch (e) {
      console.error(
        `! could not deregister manager instance ${iid}: ${rejectionText(e)}\n` +
          `  Its registration now outlives this process and will be frozen into every class scatter in space "${this.config.space}", each paying the full deadline.\n` +
          `  NEXT: once this process is gone, start this manager again and stop it cleanly; on a static space \`cotal endpoint deregister manager ${iid} --yes\` from the space's own root also removes it.`,
      );
    }
  }

  /** Stop the v0.4 service-endpoint serve loop (drain subscriptions, await in-flight handlers)
   *  and drop its dedicated connection, or only close the connection while its transport is down.
   *  Best-effort so a graceful stop completes its remaining teardown even when the broker is gone. */
  private async stopServiceServe(): Promise<void> {
    const s = this.servePlane.serviceServe;
    if (!s) return;
    this.servePlane.serviceServe = undefined;
    await this.retireConnection(s.nc, () => s.handle.stop());
  }

  /** {@link BrokerTransport.retireConnection}. */
  protected retireConnection(...args: Parameters<BrokerTransport["retireConnection"]>): ReturnType<BrokerTransport["retireConnection"]> { return this.brokerTransportComponent.retireConnection(...args); }



  /** {@link PreservedResume.opFinalizeResume}. */
  protected opFinalizeResume(...args: Parameters<PreservedResume["opFinalizeResume"]>): ReturnType<PreservedResume["opFinalizeResume"]> { return this.preservedResumeComponent.opFinalizeResume(...args); }

  /** {@link PreservedResume.opCommitResume}. */
  protected opCommitResume(...args: Parameters<PreservedResume["opCommitResume"]>): ReturnType<PreservedResume["opCommitResume"]> { return this.preservedResumeComponent.opCommitResume(...args); }

  /** {@link PreservedResume.opResumePreserved}. */
  protected opResumePreserved(...args: Parameters<PreservedResume["opResumePreserved"]>): ReturnType<PreservedResume["opResumePreserved"]> { return this.preservedResumeComponent.opResumePreserved(...args); }

  /** {@link PreservedResume.opPreservationCtl}. */
  protected opPreservationCtl(...args: Parameters<PreservedResume["opPreservationCtl"]>): ReturnType<PreservedResume["opPreservationCtl"]> { return this.preservedResumeComponent.opPreservationCtl(...args); }

  /** {@link CommandDispatch.admitControl}. */
  private admitControl(...args: Parameters<CommandDispatch["admitControl"]>): ReturnType<CommandDispatch["admitControl"]> { return this.commandDispatch.admitControl(...args); }

  /** Run one v0.4 service-command handler through the SHARED admission chokepoint
   *  ({@link admitControl}) on the broker-authenticated caller principal, mapping the two fences
   *  onto the §13.3 catalog: maintenance/resume → `unavailable`, membership →
   *  `permission-denied`. The serve boundary publishes the structured error reply. */
  protected async serveGated<T>(ctx: EpServeContext, fn: () => T | Promise<T>): Promise<T> {
    const caller = principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key;
    const admission = this.admitControl(caller);
    // Both fences refuse before the handler runs, so nothing ran (SPEC 13.3).
    if (admission.refusal !== undefined)
      throw new EpEnvelopeError(admission.fence === "membership" ? "permission-denied" : "unavailable", admission.refusal, undefined, "not-executed");
    try {
      return await fn();
    } finally {
      admission.release();
    }
  }

  /** `status` only: {@link serveGated}, except that a fully preserved manager, and an active one
   *  launched for a resume that has not committed it yet, still answer it. A preserved-exit stop's
   *  caller-attributed preview needs the preserved manager's stop impact, and a resumed service's
   *  readiness reads the same status; the maintenance fence refuses every other command in both
   *  states. The read is counted in `lifecycleInFlight` like any admitted operation and released in
   *  `finally`, so a drain waits at most for one status snapshot; the membership gate still
   *  applies. `preserving` and a stopping manager stay fenced. */
  protected async serveObservation<T>(ctx: EpServeContext, fn: () => T | Promise<T>): Promise<T> {
    const preserved = this.maintenanceState === "preserved" && !this.resumeRequired;
    const resumePending = this.maintenanceState === "active" && this.resumeRequired;
    if (this.leaseStopping || !preserved && !resumePending) return this.serveGated(ctx, fn);
    const membership = this.lifecycleMembershipRefusal(principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key);
    if (membership) throw new EpEnvelopeError("permission-denied", membership, undefined, "not-executed");
    this.lifecycleInFlight++;
    try {
      return await fn();
    } finally {
      this.releaseLifecycle();
    }
  }

  /** {@link CommandDispatch.epAdminReach}. */
  protected epAdminReach(...args: Parameters<CommandDispatch["epAdminReach"]>): ReturnType<CommandDispatch["epAdminReach"]> { return this.commandDispatch.epAdminReach(...args); }


  /** The run host, or one of three refusals. A remote-authority manager holds no space signer, so
   *  it cannot mint the per-run driver credential SPEC 14.6 requires without all four closed
   *  host callbacks. A local user-auth mesh is `unimplemented`: a hosted run's seats
   *  are spawned, turned and despawned by a caller derived from the run id under the static
   *  owner, which the user-mode spawn door refuses (no `u_` owner), so a program would fail at
   *  its first seat; no path to `--local` is offered there since a user bearer holds no run rows
   *  either. An ordinary manager whose host is not standing yet is still booting (the serve
   *  surface comes up before the host): `unavailable`, retry. The three are told apart, since
   *  the first sentence steers a caller to `--local` and the others must not. */
  protected runHost(): RunHosting {
    if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    if (this.runHosting) return this.runHosting;
    if (this.config.remoteAuthority && !this.config.remoteAuthority.runHosting)
      throw new EpEnvelopeError("unimplemented", "this manager does not host workflow runs: its issuing host supplied no closed run callbacks, and a remote-authority manager mints no run-driver credentials (SPEC 14.6); drive the run from a terminal with `cotal run start --local --file <program>`");
    if (this.userMode && !this.config.remoteAuthority?.runHosting)
      throw new EpEnvelopeError("unimplemented", `user-auth space "${this.config.space}" hosts no workflow runs yet: a hosted run's seats would be spawned under the static owner, which a user mesh refuses; run programs on a static-auth mesh`);
    throw new EpEnvelopeError("unavailable", "the manager is still booting its workflow-run host; retry shortly (SPEC 14.3)");
  }

  /** The answerer a `run-answer` records (SPEC 14.5): the caller as this manager knows them. A
   *  managed seat is named by its persona name; any other authenticated caller (an operator
   *  instrument, a logged-in user) by its principal. Never the request body's word. */
  protected runAnswerer(ctx: EpServeContext): string {
    const caller = principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key;
    for (const a of this.agents.values()) if (this.managedPrincipal(a) === caller) return a.name;
    return caller;
  }

  /** A baseline seat may answer only the pause whose relay is pending on that exact incarnation.
   *  Explicit `run` holders and unmanaged operator instruments keep the run capability's existing
   *  answer reach. The relay payload is manager-held state written by the runtime, never request
   *  input, and its token is checked against the open checkpoint before any answer is filed. */
  protected authorizeRunAnswer(ctx: EpServeContext, args: { runId: string; stepKey: string }, open: { token: string }): void {
    const caller = principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key;
    const agent = [...this.agents.values()].find((a) =>
      this.managedPrincipal(a) === caller && a.lifecycleUid === ctx.subject.caller.uid);
    if (agent === undefined || agent.launch.capabilities?.includes("run")) return;
    const pending = this.turnRelay.pendingForSeat(ctx.subject.caller);
    if (pending === undefined)
      throw new EpEnvelopeError("permission-denied", `run-answer is allowed to this baseline seat only for a pending ask or escalation addressed to its own incarnation; none is pending for ${agent.name}`);
    let payload: unknown;
    try { payload = JSON.parse(pending.payload); } catch {
      throw new EpEnvelopeError("permission-denied", `turn "${pending.goalId}" carries no readable ask or escalation authorization; run-answer is refused`);
    }
    const p = payload as { run?: unknown; step?: unknown; ask?: { token?: unknown }; checkpoint?: { token?: unknown; escalatedTo?: unknown } };
    const addressedToken = typeof p.ask?.token === "string" ? p.ask.token
      : p.checkpoint?.escalatedTo === agent.name && typeof p.checkpoint?.token === "string" ? p.checkpoint.token
      : undefined;
    if (p.run !== args.runId || p.step !== args.stepKey || addressedToken !== open.token)
      throw new EpEnvelopeError("permission-denied", `run-answer is allowed to ${agent.name} only for the open pause named by its pending ask or escalation relay; ${args.runId} ${args.stepKey} is not that pause`);
  }

  /** Find one exact live presence row. Presence is not authority, but a participation lease with no
   * live addressee would authorize a durable turn nobody can receive. Duplicate exact rows are
   * refused rather than selected by order. */
  private liveParticipantPresence(caller: EpCaller): Presence {
    const principal = principalKey(caller.owner, caller.actor).key;
    const rows = this.ep.getRoster().filter((p) =>
      p.card.id === principal && p.lifecycleUid === caller.uid && p.status !== "offline");
    if (rows.length !== 1)
      throw new EpEnvelopeError("expired", rows.length === 0
        ? `personal participant ${principal} (lifecycle ${caller.uid}) has no exact live presence`
        : `personal participant ${principal} (lifecycle ${caller.uid}) has multiple exact live presence rows; no row was selected`, undefined, "not-executed");
    return rows[0]!;
  }

  /** Authorize and renew one personal native participant. Local user-auth authority reads the exact
   * managed foreground row fresh; a signerless manager asks its registered host. The lease is held
   * only in memory and is therefore renewed after reconnect or manager restart. */
  protected async serveTurnParticipation(caller: EpCaller): Promise<{
    owner: string; actor: string; lifecycleUid: string; name: string; managerInstanceId: string; expiresAt: number;
  }> {
    if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal(), undefined, "not-executed");
    if (!/^pa_[a-z2-7]{26}$/.test(caller.actor))
      throw new EpEnvelopeError("permission-denied", "workflow turn participation is reserved for approved personal conversation actors", undefined, "not-executed");
    if (!this.config.remoteAuthority)
      throw new EpEnvelopeError("unimplemented", "personal workflow participation requires a registered issuing host with fresh lifecycle authority", undefined, "not-executed");
    if (!this.config.remoteAuthority.authorizeParticipation)
      throw new EpEnvelopeError("unimplemented", "the issuing host supplies no closed personal participation authorization", undefined, "not-executed");
    const authorized = await this.config.remoteAuthority.authorizeParticipation({ owner: caller.owner, actor: caller.actor, lifecycleUid: caller.uid });
    if (!authorized)
      throw new EpEnvelopeError("permission-denied", "the exact personal lifecycle is not currently foreground-authorized with run scope", undefined, "not-executed");
    const presence = this.liveParticipantPresence(caller);
    const expiresAt = Date.now() + TURN_PARTICIPATION_TTL_MS;
    const generation = (caller as EpCaller & { generation?: string }).generation;
    const participant: PersonalTurnParticipant = {
      name: presence.card.name, owner: caller.owner, actor: caller.actor, uid: caller.uid,
      ...(generation !== undefined ? { generation } : {}),
      expiresAt,
    };
    this.participants.set(participantKey(caller.owner, caller.actor, caller.uid), participant);
    return { owner: caller.owner, actor: caller.actor, lifecycleUid: caller.uid, name: participant.name,
      managerInstanceId: this.managerInstanceId, expiresAt };
  }

  private currentParticipant(owner: string, actor: string, uid: string): PersonalTurnParticipant | undefined {
    const key = participantKey(owner, actor, uid);
    const p = this.participants.get(key);
    if (!p) return undefined;
    if (p.expiresAt <= Date.now()) { this.participants.delete(key); return undefined; }
    try { this.liveParticipantPresence({ owner, actor, uid }); }
    catch { this.participants.delete(key); return undefined; }
    return p;
  }

  /** A managed seat or a finite authorized personal participant. Only the first carries custody. */
  protected turnTarget(ctx: EpServeContext): { kind: "managed"; agent: ManagedAgent; name: string } | { kind: "personal"; participant: PersonalTurnParticipant; name: string } {
    if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    const t = ctx.request.target!;
    const managed = this.findManagedByTarget(t);
    if (managed) return { kind: "managed", agent: managed, name: managed.name };
    const participant = this.currentParticipant(t.owner, t.actor, t.lifecycleUid);
    if (participant) return { kind: "personal", participant, name: participant.name };
    throw new EpEnvelopeError("expired", `target ${t.owner}.${t.actor} (lifecycle ${t.lifecycleUid}) is neither a live managed agent nor a current personal participant of this manager`, undefined, "not-executed");
  }

  /** Resolve whether an exact turn executor lifecycle is current. */
  private turnExecutorEpoch(name: string, owner: string, actor: string, uid: string): number | null {
    const managed = this.agents.get(name);
    if (managed && this.managedPrincipal(managed) === principalKey(owner, actor).key && managed.lifecycleUid === uid) return 0;
    return this.currentParticipant(owner, actor, uid)?.name === name ? 0 : null;
  }

  /** A baseline seat may amend only an answer recorded under its own name: it changes its own
   *  position, never another answerer's. Explicit `run` holders and unmanaged operator instruments
   *  keep the reach they have to answer, as {@link authorizeRunAnswer} does. */
  protected authorizeRunAmend(ctx: EpServeContext, accepted: { by: string }): void {
    const caller = principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key;
    const agent = [...this.agents.values()].find((a) =>
      this.managedPrincipal(a) === caller && a.lifecycleUid === ctx.subject.caller.uid);
    if (agent === undefined || agent.launch.capabilities?.includes("run")) return;
    if (accepted.by !== agent.name)
      throw new EpEnvelopeError("permission-denied", `run-answer amend is allowed to ${agent.name} only for an answer recorded under its own name; this step's accepted answer is ${JSON.stringify(accepted.by)}'s`);
  }

  /** {@link CommandDispatch.managerServiceDefs}. */
  protected managerServiceDefs(...args: Parameters<CommandDispatch["managerServiceDefs"]>): ReturnType<CommandDispatch["managerServiceDefs"]> { return this.commandDispatch.managerServiceDefs(...args); }


  /** Collapsed despawn/attach authorization (P4b). The caller already reached the command's ep
   *  row (cred-gated: owner-mode rows via the spawn capability, any-mode rows only in admin
   *  instruments). With admin=true (any-mode) any named target is allowed (operator). Otherwise
   *  a named target is allowed if it's the caller's OWN child (`spawner == caller`) — and, on a
   *  user mesh, if it runs under the CALLER'S OWNER (owner-domain) or the caller's ledger row
   *  holds `admin`, read fresh. Local managers run the pure {@link authorizeNamedControl} policy
   *  against their provider-backed ledger. Remote managers preserve own-child and owner-domain
   *  decisions locally, then send only the residual cross-owner admin question through the registered
   *  host callback with the full endpoint caller tuple. Error string when denied, `undefined` when
   *  allowed; remote host-state faults throw rather than being collapsed into a denial. */
  protected async authorizeNamed(target: ManagedAgent, caller: string, admin: boolean, epCaller?: EpCaller): Promise<string | undefined> {
    if (this.config.remoteAuthority && epCaller && !admin) {
      if (target.spawner === caller) return undefined;
      const principal = parsePrincipalKey(caller);
      if (principal && target.userOwner === principal.owner) return undefined;
      // Unlike the local pure-policy adapter below, host authority faults are not collapsed into an
      // ordinary denial. The registered remote manager must fail the operation closed and surface
      // unavailable/corrupt authoritative state rather than implying a healthy `authorized:false`.
      if (await this.epAdminReach(epCaller)) return undefined;
      return (
        `not authorized: ${target.name} runs under another owner - your grant covers agents under your own owner; ` +
        `cross-owner stop/attach/input needs scope "admin" on your actor. Re-grant with "admin" ADDED to your current ` +
        `scope (the upsert replaces the list; see \`cotal actor list\`)`
      );
    }
    return authorizeNamedControl({
      target: { name: target.name, spawner: target.spawner, userOwner: target.userOwner },
      caller,
      admin,
      userMode: this.userMode,
      scopeOf: (owner, actor) =>
        resolveAuthProvider().actorScope({ dir: userAuthStateDir(this.config.workspaceRoot, this.config.space), owner, actor }),
    });
  }

  /** The wire principal of a managed agent: {@link managedPrincipal}. */
  protected managedPrincipal(a: { id: string; userOwner?: string }): string { return managedPrincipal(a); }


  /** {@link CommandDispatch.opStopSelf}. */
  opStopSelf(...args: Parameters<CommandDispatch["opStopSelf"]>): ReturnType<CommandDispatch["opStopSelf"]> { return this.commandDispatch.opStopSelf(...args); }

  // Plane-3 durable join/leave/list ops moved OFF the manager onto the server-side delivery daemon's
  // `ctl.delivery` control service (endpoint.startPlane3 → handleDeliveryControl). The manager is
  // lifecycle-only; it records each agent's read ACL at spawn (commitAcl) so the daemon can validate
  // those ops against the durable ACL registry — the single source of truth, no in-memory ledger.

  /** {@link SeatStop.stopHandle}. */
  protected stopHandle(...args: Parameters<SeatStop["stopHandle"]>): ReturnType<SeatStop["stopHandle"]> { return this.seatStopComponent.stopHandle(...args); }

  /** {@link SeatStop.stopWindowsSeat}. */
  protected stopWindowsSeat(...args: Parameters<SeatStop["stopWindowsSeat"]>): ReturnType<SeatStop["stopWindowsSeat"]> { return this.seatStopComponent.stopWindowsSeat(...args); }


  protected provisionUserAgent(name: string, opts: ProvisionUserAgentOpts): Promise<ProvisionedUserAgent | UserAgentRefusal> { return this.userProvision.provisionUserAgent(name, opts); }

  /** Shred a user agent's secret family from the store and from disk. Every removal is attempted,
   *  and each failure joins `unshredded`, so one fault cannot leave the rest of the family behind. */
  protected async shredUserSecrets(unshredded: CleanupFailure[], family: { actorToken?: string; sentinelCreds?: string; health?: string }): Promise<void> {
    for (const path of [family.actorToken, family.sentinelCreds])
      if (path) await attemptCleanup(unshredded, `secret ${path}`, () => this.config.secrets.delete(agentSecretKeyForFile(path, this.config.space)));
    for (const path of [family.actorToken, family.sentinelCreds, family.health])
      if (path) await attemptCleanup(unshredded, `file ${path}`, () => rmSync(path, { force: true }));
  }

  /** {@link SeatStop.logSeatReaped}. */
  protected logSeatReaped(...args: Parameters<SeatStop["logSeatReaped"]>): ReturnType<SeatStop["logSeatReaped"]> { return this.seatStopComponent.logSeatReaped(...args); }

  /** {@link SeatStop.logSeatMeshTransitions}. */
  protected logSeatMeshTransitions(...args: Parameters<SeatStop["logSeatMeshTransitions"]>): ReturnType<SeatStop["logSeatMeshTransitions"]> { return this.seatStopComponent.logSeatMeshTransitions(...args); }

  protected freeSlot(a: ManagedAgent, floor: boolean, cause: FreeSlotCause, acceptedBeforeFence = false): void { this.namesCapacity.freeSlot(a, floor, cause, acceptedBeforeFence); }

  /** {@link SeatStop.dropInlineSnapshot}. */
  protected dropInlineSnapshot(...args: Parameters<SeatStop["dropInlineSnapshot"]>): ReturnType<SeatStop["dropInlineSnapshot"]> { return this.seatStopComponent.dropInlineSnapshot(...args); }

  protected deprovision(a: TeardownTarget): Promise<void> { return this.retirement.deprovision(a); }

  /** Run one retirement in a {@link RETIREMENT_CONCURRENCY} slot, oldest first: a seat's deprovision, a
   *  chat session's terminal and a static reconcile's terminal all take one. No retirement awaits
   *  another, so the bounded pool cannot deadlock. */
  protected async withRetirementSlot<T>(run: () => Promise<T>): Promise<T> {
    if (this.retirementsRunning < RETIREMENT_CONCURRENCY) this.retirementsRunning++;
    else await new Promise<void>((resolve) => this.retirementQueue.push(resolve));
    try {
      return await run();
    } finally {
      // Hand the slot to the oldest waiter, or give it back.
      const next = this.retirementQueue.shift();
      if (next) next();
      else this.retirementsRunning--;
    }
  }
  protected confirmRetirement(a: { id: string; name: string; lifecycleUid: string }): void { this.retirement.confirmRetirement(a); }
  protected deprovisionBroker(a: { id: string; name: string; lifecycleUid: string; launch?: { allowSubscribe: readonly string[] } }): Promise<DeprovisionResourceAccounting> { return this.retirement.deprovisionBroker(a); }

  /** {@link SeatStop.fenceRetiringAcl}. */
  protected fenceRetiringAcl(...args: Parameters<SeatStop["fenceRetiringAcl"]>): ReturnType<SeatStop["fenceRetiringAcl"]> { return this.seatStopComponent.fenceRetiringAcl(...args); }

  /** {@link SeatStop.lifecycleMembershipInventory}. */
  protected lifecycleMembershipInventory(...args: Parameters<SeatStop["lifecycleMembershipInventory"]>): ReturnType<SeatStop["lifecycleMembershipInventory"]> { return this.seatStopComponent.lifecycleMembershipInventory(...args); }

  /** {@link SeatStop.reapChildrenOf}. */
  protected reapChildrenOf(...args: Parameters<SeatStop["reapChildrenOf"]>): ReturnType<SeatStop["reapChildrenOf"]> { return this.seatStopComponent.reapChildrenOf(...args); }

  protected readManagedSessionState(a: ManagedAgent): | { sessionId: string; status: "running" | "quit" }
    | { connector: string; status: "prompt"; prompt: string; cwd: string } {
    return this.sessionRecovery.readManagedSessionState(a);
  }

  protected retainedSessionId(entry: ManagerResumeAgent, connector: Connector): string | undefined {
    return this.sessionRecovery.retainedSessionId(entry, connector);
  }

  protected forkProvenance(a: ManagedAgent): ForkProvenance | undefined {
    return this.sessionRecovery.forkProvenance(a);
  }

  protected readManagedSession(a: ManagedAgent): string {
    return this.sessionRecovery.readManagedSession(a);
  }

  protected recordContinuity(a: ManagedAgent, sessionId: string): void {
    return this.sessionRecovery.recordContinuity(a, sessionId);
  }

  protected recordContinuityAtStop(a: ManagedAgent, boundary: string): void {
    return this.sessionRecovery.recordContinuityAtStop(a, boundary);
  }

  protected armSessionRecovery(a: ManagedAgent): Promise<void> {
    return this.sessionRecovery.armSessionRecovery(a);
  }

  /** Why an inline seat's snapshot no longer matches its launch, or `undefined` when it does or the
   *  seat is not inline. The recorded path and the relaunch's path must both be this lifecycle's
   *  snapshot path, as the resume cut requires, and the file there must still be a private regular
   *  file with the recorded digest. */
  protected inlineSnapshotChange(a: ManagedAgent): string | undefined {
    const source = a.launch.source;
    if (source.kind !== "inline") return undefined;
    const path = resolve(inlineSnapshotPath(this.config.workspaceRoot, a.lifecycleUid));
    if (resolve(source.configPath) !== path)
      return `its recorded inline persona snapshot ${source.configPath} is not this lifecycle's snapshot path`;
    if (a.restart !== undefined && resolve(a.restart.opts.configPath ?? "") !== path)
      return `its relaunch persona ${a.restart.opts.configPath} is not this lifecycle's snapshot path`;
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.isSymbolicLink()) return `its inline persona snapshot ${path} is not a regular file`;
      if (process.platform !== "win32" && (st.mode & 0o077) !== 0) return `its inline persona snapshot ${path} is readable by others`;
      if (this.fileDigest(path) !== source.configSha256) return `its inline persona snapshot ${path} changed after launch`;
    } catch (e) {
      return `its inline persona snapshot is unavailable: ${rejectionText(e)}`;
    }
    return undefined;
  }

  protected recoverManagedSession(a: ManagedAgent): void {
    return this.sessionRecovery.recoverManagedSession(a);
  }

  /** {@link SeatStop.onAgentExit}. */
  protected onAgentExit(...args: Parameters<SeatStop["onAgentExit"]>): ReturnType<SeatStop["onAgentExit"]> { return this.seatStopComponent.onAgentExit(...args); }
  protected nameError(name: string): string | undefined { return this.namesCapacity.nameError(name); }

  /** Spawn a teammate by persona ref (`name` loads `.cotal/agents/<name>.md`; the peer presents
   *  under that file's own `name:`), as if a peer asked via the control plane. Used to pre-spawn the
   *  demo's experts at startup so the manager owns them. */
  async startByName(name: string): Promise<ControlReply> {
    return this.seatLaunch.startByName(name);
  }

  /** Resolve once `name` shows up on the mesh roster (presence registered), or after `timeoutMs`.
   *  Lets the pre-spawn loop stagger heavy agent cold-starts so they don't all boot at once.
   *  Best-effort, keyed on the manager-owned (auto-numbered, unique) spawn name — NOT identity
   *  resolution: a same-named *unmanaged* peer already present could satisfy this early. That's
   *  acceptable for cold-start staggering; it never routes anything. */
  async waitForPresence(name: string, timeoutMs = 30_000): Promise<boolean> {
    return this.seatLaunch.waitForPresence(name, timeoutMs);
  }

  /** {@link StartDoors.opStart}. */
  protected opStart(...args: Parameters<StartDoors["opStart"]>): ReturnType<StartDoors["opStart"]> { return this.startDoorsComponent.opStart(...args); }

  /** {@link HarnessResolution.resolveConnector}. */
  protected resolveConnector(...args: Parameters<HarnessResolution["resolveConnector"]>): ReturnType<HarnessResolution["resolveConnector"]> { return this.harnessResolutionComponent.resolveConnector(...args); }

  /** {@link SeatLaunch.classSpawnEnabled}. */
  protected classSpawnEnabled(): boolean { return this.seatLaunch.classSpawnEnabled(); }
  protected omitClassCommands(): readonly string[] | undefined { return this.seatLaunch.omitClassCommands(); }


  /** {@link HarnessResolution.hostLaunchFields}. */
  protected hostLaunchFields(...args: Parameters<HarnessResolution["hostLaunchFields"]>): ReturnType<HarnessResolution["hostLaunchFields"]> { return this.harnessResolutionComponent.hostLaunchFields(...args); }

  /** {@link HarnessResolution.capabilityRefusal}. */
  protected capabilityRefusal(...args: Parameters<HarnessResolution["capabilityRefusal"]>): ReturnType<HarnessResolution["capabilityRefusal"]> { return this.harnessResolutionComponent.capabilityRefusal(...args); }
  /** {@link SeatLaunch.onceRefusal}. */
  onceRefusal(connector: Connector, runtime: Runtime, launch: Pick<StartAgentOpts, "once" | "supervise" | "launchOptions" | "prompt" | "autoName">, spawner: string | undefined, hooks: SpawnHooks | undefined): string | undefined { return this.seatLaunch.onceRefusal(connector, runtime, launch, spawner, hooks); }

  /** {@link HarnessResolution.eventsRefusal}. */
  protected eventsRefusal(...args: Parameters<HarnessResolution["eventsRefusal"]>): ReturnType<HarnessResolution["eventsRefusal"]> { return this.harnessResolutionComponent.eventsRefusal(...args); }

  /** {@link StatusAndModels.opModels}. */
  protected opModels(...args: Parameters<StatusAndModels["opModels"]>): ReturnType<StatusAndModels["opModels"]> { return this.statusAndModelsComponent.opModels(...args); }

  /** {@link StatusAndModels.psOwnerFilter}. */
  protected psOwnerFilter(...args: Parameters<StatusAndModels["psOwnerFilter"]>): ReturnType<StatusAndModels["psOwnerFilter"]> { return this.statusAndModelsComponent.psOwnerFilter(...args); }

  /** {@link StartDoors.opLaunch}. */
  protected opLaunch(...args: Parameters<StartDoors["opLaunch"]>): ReturnType<StartDoors["opLaunch"]> { return this.startDoorsComponent.opLaunch(...args); }

  /** Spawn and supervise one agent. The single spawn path: both the control-plane
   *  `start` op and declarative roster boot call this. Mints scoped creds in auth mode,
   *  resolves the agent file, launches via the connector + runtime, and records the handle.
   *  `spawner` is the authenticated id of the peer that requested the spawn (`req.from.id`),
   *  defaulting to the manager's own id for roster/pre-spawn — recorded for the spawner
   *  ledger (own-children despawn + reap-on-parent-exit). */
  async startAgent(opts: StartAgentOpts, spawner?: string, hooks?: SpawnHooks, authenticatedCaller?: EpCaller): Promise<ControlReply> {
    if (this.execution === "none") return { ok: false, error: this.executionRefusal() };
    const release = this.beginLifecycle();
    if (!release) return { ok: false, error: this.maintenanceError() };
    try {
      return await this.seatLaunch.startActive(opts, spawner, hooks, authenticatedCaller);
    } finally {
      release();
    }
  }
  /** {@link SeatLaunch.spawnPersona}. */
  protected spawnPersona(...args: Parameters<SeatLaunch["spawnPersona"]>): ReturnType<SeatLaunch["spawnPersona"]> { return this.seatLaunch.spawnPersona(...args); }
  /** {@link SeatLaunch.spawnRun}. */
  protected spawnRun(caller: EpCaller | undefined, runId: string | undefined): Promise<SpawnRun | undefined> { return this.seatLaunch.spawnRun(caller, runId); }
  /** {@link SeatLaunch.staticSpawnBound}. */
  protected staticSpawnBound(caller: EpCaller | undefined, run: Extract<SpawnRun, { admission: RunAdmission }> | undefined): Promise<StaticSpawnBound> { return this.seatLaunch.staticSpawnBound(caller, run); }

  /** {@link PreservedResume.resumePreserved}. */
  resumePreserved(...args: Parameters<PreservedResume["resumePreserved"]>): ReturnType<PreservedResume["resumePreserved"]> { return this.preservedResumeComponent.resumePreserved(...args); }

  /** {@link PreservedResume.validateRetainedAuthority}. */
  protected validateRetainedAuthority(...args: Parameters<PreservedResume["validateRetainedAuthority"]>): ReturnType<PreservedResume["validateRetainedAuthority"]> { return this.preservedResumeComponent.validateRetainedAuthority(...args); }



  /** {@link PreservedResume.resumePreservedAgent}. */
  protected resumePreservedAgent(...args: Parameters<PreservedResume["resumePreservedAgent"]>): ReturnType<PreservedResume["resumePreservedAgent"]> { return this.preservedResumeComponent.resumePreservedAgent(...args); }





  protected probeStaticCredential(creds: string) {
    return probeConnect(this.config.servers ?? DEFAULT_SERVER, { creds, timeoutMs: 5_000 });
  }


  /** {@link ReadinessWait.awaitReadiness}. */
  protected awaitReadiness(...args: Parameters<ReadinessWait["awaitReadiness"]>): ReturnType<ReadinessWait["awaitReadiness"]> { return this.readinessWaitComponent.awaitReadiness(...args); }

  /** {@link ReadinessWait.tail}. */
  protected tail(...args: Parameters<ReadinessWait["tail"]>): ReturnType<ReadinessWait["tail"]> { return this.readinessWaitComponent.tail(...args); }

  /** {@link ReadinessWait.watchExit}. */
  protected watchExit(...args: Parameters<ReadinessWait["watchExit"]>): ReturnType<ReadinessWait["watchExit"]> { return this.readinessWaitComponent.watchExit(...args); }
  protected occupancy(): Occupancy { return this.namesCapacity.occupancy(); }

  /** The owner a launch belongs to: {@link NamesCapacity.launchOwner}. */
  protected launchOwner(opts: Pick<StartAgentOpts, "owner">, spawner?: string): string { return this.namesCapacity.launchOwner(opts, spawner); }

  /** {@link SeatStop.opStop}. */
  // @ts-expect-error TS6133: retained fixtures call this private adapter through structural views.
  private opStop(...args: Parameters<SeatStop["opStop"]>): ReturnType<SeatStop["opStop"]> { return this.seatStopComponent.opStop(...args); }

  /** {@link SeatStop.despawnAuthorized}. */
  protected despawnAuthorized(...args: Parameters<SeatStop["despawnAuthorized"]>): ReturnType<SeatStop["despawnAuthorized"]> { return this.seatStopComponent.despawnAuthorized(...args); }

  /** {@link SeatStop.retireDelegatedAgent}. */
  retireDelegatedAgent(name: string, intentId: string): Promise<ControlReply> { return this.seatStopComponent.retireDelegatedAgent(name, intentId); }

  /** {@link SeatStop.findManagedByTarget}. */
  protected findManagedByTarget(...args: Parameters<SeatStop["findManagedByTarget"]>): ReturnType<SeatStop["findManagedByTarget"]> { return this.seatStopComponent.findManagedByTarget(...args); }

  /** {@link BrokerTransport.withLifecycleExecutor}. */
  protected withLifecycleExecutor<T>(pin: { owner: string; actor: string; lifecycleUid: string; alias: string }, fn: (t: LifecycleStateTransport) => Promise<T>): Promise<T> { return this.brokerTransportComponent.withLifecycleExecutor(pin, fn); }

  /** {@link BrokerTransport.withIssuer}. */
  protected withIssuer<T>(fn: (i: { store: IssuedStore; accepted: KV }) => Promise<T>): Promise<T> { return this.brokerTransportComponent.withIssuer(fn); }


  /** {@link BrokerTransport.withEndpointServeExecutor}. */
  protected withEndpointServeExecutor<T>(fn: (kvs: { recordsKv: KV; authKv: KV; nc: NatsConnection }) => Promise<T>): Promise<T> { return this.brokerTransportComponent.withEndpointServeExecutor(fn); }

  /** {@link BrokerTransport.withOpenServeConnection}. */
  protected withOpenServeConnection<T>(fn: (kvs: { recordsKv: KV; authKv: KV; nc: NatsConnection }) => Promise<T>): Promise<T> { return this.brokerTransportComponent.withOpenServeConnection(fn); }

  /** {@link ManagerBoot.serveBound}. */
  serveBound(): boolean { return this.bootComponent.serveBound(); }

  /** {@link StatusAndModels.hostedSeatCount}. */
  hostedSeatCount(...args: Parameters<StatusAndModels["hostedSeatCount"]>): ReturnType<StatusAndModels["hostedSeatCount"]> { return this.statusAndModelsComponent.hostedSeatCount(...args); }

  /** {@link StatusAndModels.hostedAgents}. */
  hostedAgents(...args: Parameters<StatusAndModels["hostedAgents"]>): ReturnType<StatusAndModels["hostedAgents"]> { return this.statusAndModelsComponent.hostedAgents(...args); }

  /** {@link StatusAndModels.managerStatusData}. */
  protected managerStatusData(...args: Parameters<StatusAndModels["managerStatusData"]>): ReturnType<StatusAndModels["managerStatusData"]> { return this.statusAndModelsComponent.managerStatusData(...args); }

  protected staticReconciliationStatus(): ManagerStaticReconciliationStatus {
    return this.staticLifecycle.staticReconciliationStatus();
  }

  /** {@link ManagerBoot.healFrozenRegistrationGate}. */
  protected healFrozenRegistrationGate(...args: Parameters<ManagerBoot["healFrozenRegistrationGate"]>): ReturnType<ManagerBoot["healFrozenRegistrationGate"]> { return this.bootComponent.healFrozenRegistrationGate(...args); }
  protected dialServeConnection(
    state: { nc: NatsConnection; identity: Identity; grant: EpServeGrant; creds?: string },
    readCreds: () => string = () => state.creds!,
    deadline?: number,
  ): Promise<{ nc: NatsConnection; handle: EpServeHandle }> { return this.servePlane.dialServeConnection(state, readCreds, deadline); }
  protected registerManagerService(): Promise<void> { return this.servePlane.registerManagerService(); }

  /** {@link GoalWriter.mintAndStageGoalWriter}. */
  protected mintAndStageGoalWriter(...args: Parameters<GoalWriter["mintAndStageGoalWriter"]>): ReturnType<GoalWriter["mintAndStageGoalWriter"]> { return this.goalWriterComponent.mintAndStageGoalWriter(...args); }


  protected mintAndStageSessionLedger(authKv: KV): Promise<string> { return this.servePlane.mintAndStageSessionLedger(authKv); }

  /** {@link GoalWriter.reconcileGoalIndex}. */
  protected reconcileGoalIndex(...args: Parameters<GoalWriter["reconcileGoalIndex"]>): ReturnType<GoalWriter["reconcileGoalIndex"]> { return this.goalWriterComponent.reconcileGoalIndex(...args); }

  /** {@link GoalWriter.emitGoalProgress}. */
  protected emitGoalProgress(...args: Parameters<GoalWriter["emitGoalProgress"]>): ReturnType<GoalWriter["emitGoalProgress"]> { return this.goalWriterComponent.emitGoalProgress(...args); }

  /** {@link GoalWriter.assertGoalWriterEpochCurrent}. */
  protected assertGoalWriterEpochCurrent(...args: Parameters<GoalWriter["assertGoalWriterEpochCurrent"]>): ReturnType<GoalWriter["assertGoalWriterEpochCurrent"]> { return this.goalWriterComponent.assertGoalWriterEpochCurrent(...args); }

  /** {@link SpawnGoal.loggedSpawnRefusal}. */
  protected loggedSpawnRefusal<T>(ctx: EpServeContext, serve: () => Promise<T>): Promise<T> { return this.spawnGoalComponent.loggedSpawnRefusal(ctx, serve); }

  /** {@link SpawnGoal.serveSpawnGoal}. */
  protected serveSpawnGoal(...args: Parameters<SpawnGoal["serveSpawnGoal"]>): ReturnType<SpawnGoal["serveSpawnGoal"]> { return this.spawnGoalComponent.serveSpawnGoal(...args); }




  // ---- the turn relay (§8 durable actions) ------------------------------------------------------
  //
  // A seat is NOT an endpoint: a run's `turn(agent, payload)` rides the manager, which accepts it
  // as a goal (the spawn-as-action pattern minus the launch closure), parks the payload durably on
  // the goal-index entry's note, and lets the seat PULL it (`turn-pending`) and answer it
  // (`turn-yield`) under its own `manager.self` reach. The deadline is a goal-bound HOLD minted at
  // accept: the delivery daemon's timer writer pumps its schedule, the fire settles it `expired`,
  // and THIS manager commits the deny (`hold-expired` is the predicate core verifies). Three
  // endings, one each: yield -> succeeded (the TurnResult rides the terminal's data), deadline ->
  // failed `turn-deadline`, and a seat death before that is stamped by the reap hook so the same
  // terminal carries `agentDownAt` (the run reads it as L4002). The adoption sweep stamps nothing.

  /** Accept one `turn` goal against a live managed seat. Mirrors {@link serveSpawnGoal}'s accept
   *  path (idempotent retry map, index-CAS-before-bind, create-only bindGoal) but runs it INLINE:
   *  there is no launch to hand off, so the accept either completes durably or unwinds its own
   *  bound goal with a `failed` terminal before refusing. */
  protected serveTurnGoal(
    ctx: EpServeContext,
    target: { kind: "managed"; agent: ManagedAgent; name: string } | { kind: "personal"; participant: PersonalTurnParticipant; name: string },
  ): Promise<TurnAcceptance> { return this.turnRelay.serveTurnGoal(ctx, target); }

  /** The seat's pull: every pending turn addressed to the CALLER's incarnation, oldest first.
   *  The uid is part of the address — a successor seat never receives a predecessor's turn. */
  protected turnPendingFor(c: { owner: string; actor: string; uid: string }): { turns: { goalId: string; payload: string; acceptedAt: number; deadlineAt?: number; once?: true }[]; notices: true; stop?: true } { return this.turnRelay.turnPendingFor(c); }

  /** Tell a seat that its `turn-pending` answer changed (SPEC 14.3 turn notice), over the serve
   *  connection that holds this instance's reply rows. The notice carries no turn and the seat
   *  pulls on it, so a lost notice delays that seat until its next pull, and nothing else. */
  protected noticeSeatTurns(seat: { name: string; owner: string; actor: string; uid: string }): void {
    const serve = this.servePlane.serviceServe;
    if (!serve) return;
    // An issued seat credential reads only the versioned rail, under the generation it was issued.
    const a = this.agents.get(seat.name);
    const participant = this.currentParticipant(seat.owner, seat.actor, seat.uid);
    const generation = a?.lifecycleUid === seat.uid ? a.issued?.generation : participant?.generation;
    const caller = { owner: seat.owner, actor: seat.actor, uid: seat.uid, ...(generation !== undefined ? { generation } : {}) };
    try {
      serve.nc.publish(turnNoticeSubject(this.config.space, this.managerInstanceId, serve.grant.epoch, caller), new TextEncoder().encode(JSON.stringify({ v: 1 })));
    } catch (e) {
      console.error(`! turn notice for ${seat.actor} failed: ${rejectionText(e)}`);
    }
  }

  /** The seat's yield: claim the hold (one-use; expiry fails closed), then commit the goal
   *  `succeeded` carrying the TurnResult. A yield AFTER the deadline drives the deadline terminal
   *  instead and refuses — the expiry outcome stands, never a late success over it. */
  protected serveTurnYield(c: { owner: string; actor: string; uid: string }, raw: Record<string, unknown>): Promise<{ goalId: string; state: string }> { return this.turnRelay.serveTurnYield(c, raw); }

  /** A once seat's report that its task's handoff to its harness was not confirmed. The seat sealed
   *  the task before it reported, so nothing hands it over again; the task fails
   *  `delivery-unconfirmed` and the seat is stopped. The commit proves the seat's live currency, as
   *  a yield's does: a seat already gone commits nothing here, and its exit cancels the task. Only
   *  the addressed seat may report, only for its once task; a repeat after the terminal is answered
   *  with it. */
  protected serveTurnUnconfirmed(c: { owner: string; actor: string; uid: string }, raw: Record<string, unknown>): Promise<{ goalId: string; state: string }> { return this.turnRelay.serveTurnUnconfirmed(c, raw); }

  /** The caller withdraws a turn it submitted (the reserved `cancel`, SPEC 13.6 item 4), so the
   *  seat is not shown it again and a late yield is answered from the cancelled terminal. Only a
   *  relay this incarnation holds is moved to `cancelling`, because only its holder can commit the
   *  terminal; an ended goal is refused with its cached outcome, which keeps a repeated cancel
   *  idempotent. The pending entry is the latch the yield and the deadline sweep race on, taken
   *  before the first await so a concurrent cancel finds nothing to take. A failed cancel puts it
   *  back so the relay still ends at its deadline, unless something ended the relay while it was
   *  held: a yield that read the entry first, or this commit with only its reply lost. An entry
   *  whose outcome cannot be read back stays out and converges through the goal index at the
   *  next boot, as a failed deadline commit does. */
  protected serveTurnCancel(ctx: EpServeContext): Promise<{ goalId: string; state: string }> { return this.turnRelay.serveTurnCancel(ctx); }

  /** The reap hook: a pending turn addressed to the reaped INCARNATION is MARKED dead, never
   *  settled early — no honest terminal exists for it (a completion must prove the executor's
   *  live currency, and the hold is only expirable once due), so the entry rides to its deadline
   *  and the deny then records both facts. The addressee's own client observes the death from
   *  presence long before that, which is the run's L4002. */
  protected failSeatTurns(name: string, uid: string): void { return this.turnRelay.failSeatTurns(name, uid); }

  /** Adopt one inherited TURN goal at boot (the reconcile sweep's turn branch): a non-terminal
   *  entry carrying a parseable note rebuilds its pending relay — never an `uncertain` settle,
   *  because the deadline hold IS this goal's bounded ending and it survived the restart. No
   *  liveness verdict is made here (the agents map is empty during reconcile, so absence means
   *  "not yet re-registered", never "dead"); a garbled note or a floor that does not name the
   *  seat's owner is logged and left, the dead-pointer honesty rule. */
  protected adoptTurnGoal(entry: { ref: GoalRef; iid: string; allocated?: GoalIndexEntry["allocated"]; note?: string }): Promise<void> { return this.turnRelay.adoptTurnGoal(entry); }

  // ---- once (a spawn whose prompt is its one relayed task) ----------------------------------------
  //
  // A once spawn's prompt is not a kickoff: the manager accepts it as one turn addressed to the
  // allocated incarnation, under the spawner's own caller triple and a goal id derived from the
  // spawn's, so the spawner reads the task's outcome with `goal-result`. The seat is served it from
  // the spawn's readiness verdict on. The task's terminal (yield, deadline) stops the seat, and the
  // seat's proved exit cancels a task that has none. Until that exit, the task's index entry is the
  // seat's debt: a successor finds it there.

  /** Accept a once spawn's task, inline in the spawn's accept seam: nothing has launched yet, so a
   *  refusal here fails the spawn and leaves no seat. Mirrors {@link serveTurnGoal}'s accept, with
   *  the goal ref and the seat given rather than read off a request. A task with no deadline mints
   *  no hold; its goal still records the spawn's readiness budget, which a successor needs to settle
   *  it. */
  protected acceptOnceTurn(o: {
    spawnRef: GoalRef; fingerprint: string; command: string; executor: { lifecycleUid: string; epoch: number }; acceptedAt: number;
    seat: { name: string; owner: string; actor: string; uid: string }; prompt: string; spawner: string; deadlineMs: number | undefined; readinessDeadlineMs: number; retire?: string;
  }): Promise<{ ref: GoalRef; deadlineAt?: number }> { return this.turnRelay.acceptOnceTurn(o); }

  /** How a once seat's startup watch ended: {@link awaitStartupOutcome}. */
  protected awaitStartupOutcome(a: ManagedAgent, launchedAt: number, readinessTimeoutMs: number): Promise<StartupOutcome> {
    return awaitStartupOutcome(a, launchedAt, readinessTimeoutMs, () => this.leaseStopping);
  }

  /** Serve a once task from now on: its spawn's succeeded terminal is written. */
  protected openOnceDelivery(ref: GoalRef): void { return this.turnRelay.openOnceDelivery(ref); }

  /** Stop the seat of a once task that just ended, found by its incarnation and never by its name.
   *  After the readiness verdict the spawn goal's outcome belongs to that verdict, so the stop lets
   *  go of the spawn goal first and never cancels it. Before the verdict it is a deliberate stop,
   *  which cancels the spawn like a despawn does. */
  private endOnceSeat(p: PendingTurn, reason: string): void {
    const a = this.findManagedByTarget({ owner: p.seat.owner, actor: p.seat.actor, lifecycleUid: p.seat.uid });
    if (a?.once === undefined || a.terminalizing) return;
    if (p.once?.deliverable) this.agentGoals.delete(a.name);
    this.stopOnceSeat(a, reason);
  }

  /** A once seat's helpers end with its task. A natural exit reaps them in {@link onAgentExit}; a
   *  stop frees the slot first, so this stop reaps them itself. */
  private stopOnceSeat(a: ManagedAgent, reason: string): void {
    this.reapChildrenOf(this.managedPrincipal(a));
    const cause = { kind: "stopped-once", reason } as const;
    this.stopHandle(a, true, cause);
    this.seatStopComponent.trackStoppedHandle(a, false, cause);
    void this.seatStopComponent.cancelAgentGoal(a.name, "graceful");
  }

  /** Stop a seat this spawn just placed and track its exit: the stop first, so the terminalizing
   *  latch is set before anything awaits, then the exit tracking. Both are synchronous. */
  protected stopAndTrack(a: ManagedAgent, cause: FreeSlotCause): void {
    this.stopHandle(a, false, cause);
    this.seatStopComponent.trackStoppedHandle(a, true, cause);
  }

  /** End a once seat before its task is served: let go of the spawn goal, record why it stopped if
   *  `stopReason` is given and none is recorded yet, then stop the seat. Synchronous, in that order. */
  protected endOnceBeforeServe(a: ManagedAgent, reason: string, stopReason?: string): void {
    this.agentGoals.delete(a.name);
    if (stopReason !== undefined) a.once!.stopReason ??= stopReason;
    this.stopOnceSeat(a, reason);
  }

  /** Put a launched seat in the agent table, then mark its reserved name placed. */
  protected place(name: string, a: ManagedAgent): void {
    this.agents.set(name, a);
    this.namesCapacity.placed(name);
  }

  /** The once task's exit hook, on the handle the seat was launched with: whichever path ends the
   *  seat, its proved exit cancels a task that has no terminal yet and discharges the seat's debt. An
   *  exit that cannot be proved leaves both. */
  protected watchOnceExit(a: ManagedAgent): void {
    const once = a.once!;
    this.onceWatched.add(goalKey(once.ref));
    const retire = once.retire === undefined ? undefined : { connector: once.retire, name: a.name, uid: a.lifecycleUid };
    // A startup watch that failed stopped the seat itself, possibly before the launch read that outcome.
    void a.handle.waitForExit!().then(
      () => this.settleOnceTurn(once.ref, once.stopReason ?? (a.handle.startupOutcome?.() === "failed" ? "launch-failed" : "seat-exited"), retire),
      (e) => console.error(`! ${a.name}: its exit could not be proved (${rejectionText(e)}); its once task stays owed`),
    );
  }

  /** End a once task that can no longer run: once its connector, when it has a `retire` hook, proves
   *  the seat's launched processes gone, cancel the task with `reason` if it has no terminal yet,
   *  then drop its index entry. One flight per task; a failure keeps it in {@link onceSettles} and
   *  the turn sweep retries it. */
  protected settleOnceTurn(ref: GoalRef, reason: string, retire?: OnceRetire): Promise<void> { return this.turnRelay.settleOnceTurn(ref, reason, retire); }

  /** Cancel a once task with `reason` unless it already has a terminal. */
  protected commitOnceCancel(ref: GoalRef, reason: string): Promise<void> { return this.turnRelay.commitOnceCancel(ref, reason); }

  /** Ask the seat's connector to prove its launched processes gone, within {@link ONCE_RETIRE_MS}.
   *  Throws without that proof. */
  private async retireOnceSeat(r: OnceRetire): Promise<{ discard(): Promise<void> }> {
    const connector = await this.resolveConnector(r.connector);
    if (!connector.retireAfterExit) throw new Error(`the ${r.connector} connector cannot prove seat ${r.name}'s launched processes gone`);
    return withTimeout(
      connector.retireAfterExit({ space: this.config.space, name: r.name, lifecycleUid: r.uid, workspaceRoot: this.config.workspaceRoot }),
      ONCE_RETIRE_MS,
      `seat ${r.name}'s launched processes were not proved gone within ${ONCE_RETIRE_MS}ms`,
    );
  }

  /** Make an adopted seat a once seat again: its exit settles its task, and the task is served to
   *  it. A task that ended before the restart owes the stop the predecessor may not have made. */
  protected bindOnceSeat(a: ManagedAgent): Promise<void> { return this.turnRelay.bindOnceSeat(a); }

  protected recordSlotRuntime(a: ManagedAgent): Promise<void> {
    return this.seatCustody.recordSlotRuntime(a);
  }

  protected recordSlotCustody(a: { name: string; id: string; lifecycleUid: string }, runtime: RuntimeReference): Promise<void> {
    return this.seatCustody.recordSlotCustody(a, runtime);
  }

  protected reserveCustody(runtime: Runtime): RuntimeReference | undefined {
    return this.seatCustody.reserveCustody(runtime);
  }

  protected spawnCustodied(runtime: Runtime, name: string, spec: LaunchSpec, cwd: string, reserved: RuntimeReference | undefined): Promise<AgentHandle> {
    return this.seatCustody.spawnCustodied(runtime, name, spec, cwd, reserved);
  }

  /** Keep launch provenance independent of status and runtime wire contracts: {@link watchConnectorHolder}. */
  protected watchConnectorHolder(handle: AgentHandle, holder: ReturnType<typeof retainConnectorSeat>): void { watchConnectorHolder(handle, holder); }

  protected refreshSeatRecord(a: ManagedAgent): void {
    return this.seatCustody.refreshSeatRecord(a);
  }

  protected dropSeatRecord(a: { name: string; lifecycleUid: string }): void {
    return this.seatCustody.dropSeatRecord(a);
  }

  /** True when a default stop wrote a runtime reference for this exact lifecycle and it is still
   *  there. That file is what a later manager adopts, so a slot free must not remove it before the
   *  retirement that confirms the lifecycle is gone. */
  protected releasedSeatPending(a: { name: string; lifecycleUid: string }): boolean {
    try {
      return readReleasedSeatReference(this.config.workspaceRoot, this.config.space, a.name)?.lifecycleUid === a.lifecycleUid;
    } catch {
      return false;
    }
  }

  protected seatRecordFor(row: StaticManagedSlotRow): SeatRecord | undefined {
    return this.seatCustody.seatRecordFor(row);
  }

  protected adoptSeat(row: StaticManagedSlotRow, record: SeatRecord): Promise<string | undefined> {
    return this.seatCustody.adoptSeat(row, record);
  }

  protected restartSupervisedSeat(row: StaticManagedSlotRow, record: SeatRecord): Promise<string | undefined> {
    return this.seatCustody.restartSupervisedSeat(row, record);
  }

  protected reapOrphanSeat(a: { name: string; runtime?: RuntimeReference }): Promise<void> {
    return this.seatCustody.reapOrphanSeat(a);
  }

  protected driveStaticRetirement(a: TeardownTarget, surfaceFailure = false, onDeprovision?: (accounting: DeprovisionResourceAccounting) => void): Promise<void> {
    return this.staticLifecycle.driveStaticRetirement(a, surfaceFailure, onDeprovision);
  }

  protected openStaticChatSession(raw: unknown): Promise<{ alias: string; actor: string; lifecycleUid: string; expiresAt: number; sealer: string; sealed: string }> {
    return this.staticLifecycle.openStaticChatSession(raw);
  }

  protected retireStaticChatSession(raw: unknown): Promise<{ outcome: "retired" | "alreadyRetired" | "failed"; reason?: string }> {
    return this.staticLifecycle.retireStaticChatSession(raw);
  }

  protected renewManagedStaticCred(a: ManagedAgent): Promise<void> {
    return this.staticLifecycle.renewManagedStaticCred(a);
  }

  protected readStaticReconcileSlot(alias: string): Promise<StaticManagedSlotRow | undefined> {
    return this.staticLifecycle.readStaticReconcileSlot(alias);
  }

  protected reconcileStaticLifecycles(postAdoption = false): Promise<void> {
    return this.staticLifecycle.reconcileStaticLifecycles(postAdoption);
  }

  /** {@link SeatStop.lifecycleMembershipRefusal}. */
  protected lifecycleMembershipRefusal(...args: Parameters<SeatStop["lifecycleMembershipRefusal"]>): ReturnType<SeatStop["lifecycleMembershipRefusal"]> { return this.seatStopComponent.lifecycleMembershipRefusal(...args); }

  /** {@link BrokerTransport.withProvisioner}. */
  protected withProvisioner<T>(fn: (prov: CotalEndpoint) => Promise<T>): Promise<T> { return this.brokerTransportComponent.withProvisioner(fn); }


  /** {@link SeatStop.opPurge}. */
  protected opPurge(...args: Parameters<SeatStop["opPurge"]>): ReturnType<SeatStop["opPurge"]> { return this.seatStopComponent.opPurge(...args); }

  /** {@link PersonaCatalog.opDefinePersona}. */
  protected opDefinePersona(...args: Parameters<PersonaCatalog["opDefinePersona"]>): ReturnType<PersonaCatalog["opDefinePersona"]> { return this.personaCatalogComponent.opDefinePersona(...args); }


  /** {@link PersonaCatalog.opRemovePersona}. */
  protected opRemovePersona(...args: Parameters<PersonaCatalog["opRemovePersona"]>): ReturnType<PersonaCatalog["opRemovePersona"]> { return this.personaCatalogComponent.opRemovePersona(...args); }


  /** {@link PersonaCatalog.canReadPersona}. */
  protected canReadPersona(...args: Parameters<PersonaCatalog["canReadPersona"]>): ReturnType<PersonaCatalog["canReadPersona"]> { return this.personaCatalogComponent.canReadPersona(...args); }



  /** {@link TerminalInput.inputAuthorized}. */
  protected inputAuthorized(...args: Parameters<TerminalInput["inputAuthorized"]>): ReturnType<TerminalInput["inputAuthorized"]> { return this.terminalInputComponent.inputAuthorized(...args); }

  /** {@link TerminalInput.attachAuthorized}. */
  protected attachAuthorized(...args: Parameters<TerminalInput["attachAuthorized"]>): ReturnType<TerminalInput["attachAuthorized"]> { return this.terminalInputComponent.attachAuthorized(...args); }

  /** {@link TerminalInput.establishConsoleSession}. */
  private establishConsoleSession(...args: Parameters<TerminalInput["establishConsoleSession"]>): ReturnType<TerminalInput["establishConsoleSession"]> { return this.terminalInputComponent.establishConsoleSession(...args); }

  /** {@link StatusAndModels.list}. */
  protected list(...args: Parameters<StatusAndModels["list"]>): ReturnType<StatusAndModels["list"]> { return this.statusAndModelsComponent.list(...args); }
}
