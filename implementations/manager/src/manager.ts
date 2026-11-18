import { UserProvision, type ManagedEnrollment, type ProvisionUserAgentOpts, type ProvisionedUserAgent, type UserAgentRefusal } from "./user-provision.js";
import { TurnRelay, goalKey, caughtEnvelope, TURN_ANSWER_RETENTION_MS, onceTurnNote, turnHoldToken, type PendingTurn, type OnceRetire, type TurnAcceptance } from "./turn-relay.js";
import { createHash, randomBytes } from "node:crypto";
import { checkEventStartup, EventStateConflictError, isPermissionDenied, chatStream, drainAndClose, requestSafeReconnect } from "@cotal-ai/core";
import { hostname, homedir } from "node:os";
import { listDirectory } from "./list-dir.js";
import { credsAuthenticator, RequestError } from "@nats-io/transport-node";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import Headless from "@xterm/headless";
import {
  CotalEndpoint,
  canonicalJson,
  copyPersonaEndpoints,
  lowerPersonaEndpoints,
  parsePersonaEndpoints,
  accountFromCreds,
  credsClaims,
  DEFAULT_SERVER,
  DEV_OWNER,
  MANAGER_LEASE_RENEW_MS,
  STANDING_RENEWABLE_TTL_SEC,
  assertLifecycleToken,
  discardLaunchArtifacts,
  divergentSecretStoreNotice,
  injectedSecretStoreIdentity,
  parseDaemonStoreAnswer,
  parseSecretStoreIdentity,
  sameSecretStoreIdentity,
  agentFilePath,
  assertValidChannel,
  clearSpaceHistory,
  dialerFor,
  connectorServers,
  spawnEnvAllow,
  fenceLifecycleAcl,
  type DeprovisionResourceAccounting,
  isConcreteChannel,
  isChannelFamily,
  deprovisionTargetPrincipal,
  idFromCreds,
  identityFromCreds,
  inspectCredHealth,
  credsRenewalDelayMs,
  composeWirePersona,
  loadAgentFile,
  listPersonaCatalog,
  personaCatalogDescription,
  personaCatalogReadable,
  loadCotalConfig,
  type CotalConfig,
  modelPolicyRefusal,
  mintCreds,
  mintGeneration,
  mintAcceptedToken,
  type IssuedBinding,
  bindIssuedStores,
  type IssuanceSeam,
  type IssuedStore,
  mintLifecycleUid,
  managedRetirementOpId,
  newIdentity,
  oneLine,
  actionContext,
  parsePrincipalKey,
  principalKey,
  probeConnect,
  provisionAgent,
  registry,
  resolveAuthProvider,
  resolveReadAcl,
  runDriverCaller,
  saveAgentFile,
  eventChannel,
  eventChannelPrincipal,
  digestIdToken,
  capabilityWithin,
  grantOverreach,
  grantParts,
  isIssuedCaller,
  issuedSpawnerStanding,
  withIssuerSession,
  renderOnceTask,
  shownSpawner,
} from "@cotal-ai/core";
import { loadLaunchPersonaFile, PersonaSourceError, retainConnectorSeat } from "@cotal-ai/workspace";
import { logicalExecutionEntry, OFFICIAL_CONNECTORS } from "@cotal-ai/workspace";
import { agentAuthState, agentCredsDir, agentLifecycleSecretFilePaths, agentSecretFilePaths, agentSecretKeyForFile, authDir, claimIdentityRecord, connectorInstallHint, DEFAULT_SEAT_CAP, DELIVERY_CREDS_KIND, extensionConnectors, findCotalRoot, getSpaceAuth, hasUserAuthState, loadExtensionsManifest, loadManagerInstanceIdentity, loadMeshes, localTrustOfSpace, manifestExtensionNames, materializeFromManifest, materializeSecretToFile, MEMBERSHIP_RW_CREDS_KIND, mergeLaunchOptions, remintDaemonCreds, resolveAgentType, resolveOnPath, runtimeInstallHint, createManagerInstanceIdentity, SEAT_CAP_UNLIMITED, spaceKey, spaceMaterialKey, SYSTEM_CREDS_FILES, userAuthStateDir, workspaceSecretStore, writeRenewalRecord, type ManagerInstanceIdentity, type MeshEntry, type RenewalRecord, type SeatCap, type UserAuthInfo } from "@cotal-ai/workspace";
import type { ActionContext, AgentDef, EpCapability, PersonaEndpoint, RunAdmission, RunRevocation, AttachSession, Connector, ConnectorModelCatalog, ConnectorSetupProvider, ControlEndpoint, ControlReply, CredHealth, DaemonStoreAnswer, DelegatedGrant, DeliveryLeaseInfo, EpCaller, EpErrorCode, GrantOverreach, InlinePersona, IssuedSubjectPermissions, LaunchOpts, LaunchSpec, ManagedLifecycleHandoff, ManagerLeaseInfo, MeshLaunchAgent, Presence, RuntimeProvider, RuntimeReference, SecretStore, SecretStoreIdentity, SpaceAuth, StartupOutcome, UserAuthLaunch } from "@cotal-ai/core";
import {
  createRuntime,
  exitProof,
  isCustodialRuntime,
  pollProvedExit,
  requireRuntimeAdopt,
  requireRuntimeReap,
  watchProvedExit,
  type AgentHandle,
  type CustodialRuntime,
  type Runtime,
  type RuntimeMode,
} from "./runtime/index.js";
import { Retirement, type TeardownTarget } from "./retirement.js";
import { ServePlane } from "./serve-plane.js";
import { NamesCapacity, type Occupancy } from "./names-capacity.js";
import { AttachEndpoint, type SessionEstablishment } from "./attach-endpoint.js";
import { DELIVERY_ADMIN_BOOT_WAIT_MS, isUnansweredDeliveryAdmin, makeManagerEndpointHolderEvictor, untilDeliveryAdminAnswers, withScopedEndpoint } from "./endpoint-evict.js";
import { makeManagerHolderLivenessProbe } from "./holder-liveness.js";
import { ManagedStaticLifecycle, STATIC_RECONCILE_RETRY_DELAYS_MS } from "./managed-static-lifecycle.js";
export { STATIC_RECONCILE_RETRY_DELAYS_MS } from "./managed-static-lifecycle.js";
import { LeaseKeeper } from "./lease-keeper.js";
export { ManagerInstanceLeaseHeld } from "./lease-keeper.js";
import { SessionRecovery } from "./session-recovery.js";
import { SeatCustody } from "./seat-custody.js";
import { withTimeout } from "./manager-timeout.js";
import { GateReconcileRefused, reconcileEndpointGate } from "./reconcile-gate.js";
import { inlinePersonaDir, inlineSnapshotPath, launchSpecForRun, materializePersona, launchAgentToStartOpts, removeInlineSnapshot, writeInlineSnapshot, parseLaunchSpec, persistLaunchSpec, readContinuityAssignment, type ContinuityAssignment } from "./launch.js";
import { authorizeLaunch, authorizeNamedControl } from "./authorize.js";
import { controlShutdown } from "./control-shutdown.js";
import { RunHosting, servedRequestSubject } from "./run-hosting.js";
import { enrolledAcl } from "./remote-authority.js";
import { rejectionText, attemptCleanup, describeCleanupFailures, type CleanupFailure } from "@cotal-ai/core";
import { MAX_AGENTS, parseResumeCommitArgs, parseResumeControlArgs, parseResumeFinalizeArgs, readReleasedSeatReference, readSeatRecord, supervisePolicy, writeReleasedSeatReference, writeSeatRecord, type SeatRecord } from "./resume.js";
import { TranscriptReceiver, type TranscriptClaim, type TranscriptReceiveInput } from "./transcript-receive.js";
// The static §13.1 lifecycle executor: the shared grammar/stores from core plus the
// manager-side adapter (transport + slot orchestration + the terminal) — see static-lifecycle.ts.
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { recordsBucket, epAuthBucket, ensureAuthorityStores, standaloneConnectOpts, credentialIdOf, STANDING_RENEWABLE_TTL_SEC as MANAGED_STATIC_TTL_SEC, STATIC_GENERATION_HORIZON_SEC, REMOTE_MANAGER_IDENTITY_NAMES, type LifecycleStateTransport, type StaticManagedSlotRow } from "@cotal-ai/core";
// The manager's ONE §13.6 session plane — offer mint + one-use redeem + PTY-bridge
// standup for `attach`, over a dedicated standing session-LEDGER connection (the byte rails ride
// per-session credentials on their own short-lived connections).
import { ManagerSessionPlane } from "./session/index.js";
// The manager as an ordinary v0.4 `service` endpoint — the §13.1
// endpoint-serve credential subsystem (gate provisioning, registration barrier, mint fence) plus
// the register/authorize/serve seams, all driven over a scoped one-shot executor connection.
import { serveIssuanceGateKv, commitSiblingIssuance, epgateKey, parseEndpointGate, readEndpointGateGeneration, deregisterServiceInstance, type ServiceDeregistration, type EpIssuanceGate, bindGoal, createGoal, transitionGoal, commitGoalResult, goalAlreadyTerminal, settleGoalUncertain, readGoalResult, readGoalStatus, readGoalSpec, recordGoalIndex, readGoalIndex, clearGoalIndex, listGoalIndex, MAX_SCHEDULE_MS, type GoalIndexEntry, GOAL_TERMINAL_STATES, goalRefOf, goalProgressTopic, turnNoticeSubject, epeSubject, submissionFingerprint, EpEnvelopeError, lifecycleBlocked, seatCapRefused, lifecycleBlockedFrom, renderLifecycleBlocked, controlReplyFromThrown, type EpCommandDef, type EpServeContext, type EpServeGrant, type EpServeHandle, type GoalRef, type Identity } from "@cotal-ai/core";
import { MANAGER_ENDPOINT, managerCommandDefs, type ManagerConnectorStatus, type ManagerStaticReconciliationStatus, type ManagerStatus, type ManagerStopImpact } from "./manager-service-contract.js";
import { measureManagerVitals } from "./vitals.js";
import type { NatsConnection } from "@nats-io/transport-node";
import type { KV } from "@nats-io/kv";
import {
  staticLifecycleTransport,
  activateStaticLifecycle,
  readStaticSlot,
  casStaticSlot,
  recordSlotCredential,
  appendStaticCredentialRow,
  ownedBySibling,
  observeStaticSlot,
  listStaticSlotObservations,
  renderStaticSlotObservation,
  StaticSlotReadError,
  STATIC_SLOT_READ_FAILED_DETAIL,
} from "./static-lifecycle.js";
import {
  CHAT_ALIAS_PREFIX, } from "./chat-session.js";

// Capture the loaded package version before an installation can replace its files.
const MANAGER_VERSION = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
/** A `once` spawn's task deadline when the caller names none: one hour from the spawn's accept. */
const ONCE_DEFAULT_DEADLINE_MS = 60 * 60_000;
/** The bound on one {@link Connector.retireAfterExit} call. An expired bound is not proof: the debt
 *  stays and the turn sweep asks again. */
const ONCE_RETIRE_MS = 60_000;
/** The goal index's bound on a relay note (core `GOAL_INDEX_NOTE_MAX`). A once task's note must
 *  fit it, and is refused at admission when it cannot. */
const TURN_NOTE_MAX = 65536;
/** Backstop for the detached-launch readiness race (#159 B1). `startAgent` waits on two REAL outcomes —
 *  the assigned id joining the mesh (presence) = started, the child process exiting = failed — NOT a
 *  liveness-inferring timer. This is only the last-resort bound for "neither happened in time": the launch
 *  is then reported UNCERTAIN (a non-success reply that does NOT deprovision — it may still be booting, or
 *  stuck before connector startup). Generous, since a real cold agent join can take several seconds. Held
 *  as an instance field ({@link Manager.readinessTimeoutMs}) so a test can shorten it. Exported so the
 *  launch-parity smoke can assert every launch client's request timeout OUTLIVES this window — the tier
 *  rule forbids the clients importing it directly. */
export const READINESS_TIMEOUT_MS = 30_000;
/** How long a once seat whose connector needs a confirmed startup waits for its startup watch to end,
 *  from its launch: the watch's 15s for the confirm prompt and 15s for its notice, plus 5s for the
 *  last read. The readiness window applies when it is longer. */
const STARTUP_OUTCOME_MS = 35_000;
/** How often the readiness race asks a runtime that streams no exit whether its child has exited, and
 *  how long it waits past the window for the proof of its last read. An operator waits on this reply,
 *  so it asks more often than the exit watch that outlives readiness. */
const READINESS_EXIT_POLL_MS = 1_000;
/** How often a resumed seat whose readiness was uncertain is checked for a join its predecessor's
 *  presence row hides (see {@link Manager.watchResumeAdoption}). The wait has no end of its own, so
 *  it asks less often than the readiness fence's 50 ms poll. */
const LATE_JOIN_POLL_MS = 1_000;
/** How long the process of a launch that waits for the operator ({@link Connector.waitsForOperator})
 *  must run without exiting before it is ready: long enough that a harness refusing its arguments
 *  exits first and is reported as failed. */
const OPERATOR_READINESS_MS = 3_000;
/** Upper bound on a detached agent-exit deprovision (#159 B2). A wedged broker must not leave the
 *  fire-and-forget teardown pending forever with no log — past this it rejects into freeSlot's fail-loud
 *  `.catch`. Generous over the helper's 5s connect timeout to allow the two consumer-deletes + ACL purge
 *  + drain on a healthy-but-slow broker. */
const DEPROVISION_TIMEOUT_MS = 15_000;
/** At most this many retirements run at once (#4965). A retirement dials up to four fresh broker
 *  connections in turn and queues an eviction and an inventory on the delivery daemon's admin rail,
 *  each against a fixed deadline. A stop that started all 50 seats' retirements together lost most of
 *  them: on a shared 12-core host at load 41-58, 9 to 46 of 50 dials hit the broker's 2 s auth
 *  timeout, and up to 26 inventories waited past 5 s behind the other seats' evictions. Measured there
 *  at load about 51, 50 dials from one process: 35 failed when all ran at once, none at 16 (median
 *  1.9 s, near the 2 s limit), none at 8 with the shortest total (3.7 s, against 4.8 s at 4). At 8,
 *  one manager queues at most 8 evictions on the daemon, about 3 s of its work at that load. */
const RETIREMENT_CONCURRENCY = 8;
/** The delivery-admin `reloadCreds` request bound — STRICTLY GREATER than the daemon's internal
 * per-component preflight bound (4s each, run in parallel) so a slow or refused proof returns the
 * daemon's STRUCTURED per-component failure, never a client-side timeout that the catch below would
 * misrecord as "no delivery-admin responder" (a false negative while the daemon is mid-proof). */
const DELIVERY_ADMIN_RELOAD_TIMEOUT_MS = 15_000;
/** A hard preservation stop should settle quickly. The manager still waits and reports a partial
 * cut rather than pretending a child is gone. Held in ManagerOptions so fake runtimes can shorten it. */
const PRESERVE_STOP_TIMEOUT_MS = 10_000;
/** How long a resume waits for a reaped orphan's principal to leave presence. Presence rows age
 * out after their 6s TTL, so three TTLs covers a killed seat that never published its leave. */
const ORPHAN_PRESENCE_CLEAR_MS = 20_000;
/** How much of an `input` text is written to a seat's pty at a time. Comfortably under the 4096-byte
 * kernel input buffer, so a slice is never re-split at a boundary the manager did not choose: the
 * tail of an oversized write stays queued and swallows the submit key that follows it (issue #1649).
 * Sized in CHARS against a byte buffer on purpose — a multi-byte character can only make a slice
 * shorter in characters than in bytes, never longer, so the margin cannot be eaten from below. */
const INPUT_SLICE_CHARS = 2048;
/** Bracketed-paste delimiters (DECSET 2004). `input` wraps a seat's text in these so the return it
 * writes afterwards is a KEYSTROKE rather than the newline trailing a pasted block: a TUI that
 * classifies a fast burst as a paste consumes that trailing newline and the text sits unsubmitted
 * in the composer until the next call's return (issue #1649). Framing, never content - these bytes
 * are not counted into the receipt, so `bytes` still reports what the caller asked to deliver. */
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";
/** `details[].kind` on an `attach` refusal raised because the seat's runtime opens no terminal
 * stream. The message carries that runtime's own guidance, which is operator copy and changes; this
 * marker is the contract a caller keys on so it can act without reading the wording. */
export const RUNTIME_NO_TERMINAL_DETAIL = "ai.cotal.manager.runtime-no-terminal";
/** Pick a `setInterval` period for {@link Manager.renewDaemonCreds} that guarantees at least one
 * tick lands inside every renewal owner's `[renewAt, exp)` window.
 *
 * `inspectCredHealth` marks a credential `near-expiry` at 75% of its iat-to-exp lifetime and
 * `expired` at 100%, so the window width is TTL/4. Ticks TTL/4 apart therefore land at least once
 * inside every window; ticks TTL/2 apart (the old schedule) can miss it entirely for any TTL. That
 * is the cause of Cotal #457, reproduced at both TTL=86400 and TTL=20 (the compressed-ratio probe).
 *
 * Deriving from the caller's TTL keeps the schedule correct for any credential class: the 24h
 * `STANDING_RENEWABLE_TTL_SEC` and the 30-day `ROTATION_RENEWED_TTL_SEC` both get a tick inside
 * their own renewal window without a hardcoded number. Post-boot responsiveness is already
 * covered by the caller invoking `renewDaemonCreds` once synchronously before starting the timer,
 * so no separate floor is needed. The pass is idempotent, since `renewDaemonCreds` no-ops each
 * credential when its state is `healthy`, so a tick that lands before the window costs one health
 * check per owner. A managed seat's credential is judged as of the next tick instead, because the
 * seat re-reads its file only once a minute and nothing pushes the renewal to it: a tick that
 * lands in the window's last minute can come too late for the seat to adopt it. */
export function credRenewIntervalMs(ttlSeconds: number): number {
  return Math.max(1, Math.floor((ttlSeconds / 4) * 1000));
}
/** Startup reconciliation overlaps control-service registration. A spawn or attach for one of
 * these aliases must wait until THAT alias's exact-op terminal attempt returns rather than racing
 * a reuse. */
const STARTUP_RECONCILING = "startup static lifecycle reconciliation";
const REMOTE_STANDING_BUDGET_MS = 10_000;

/** The owner a retained seat resumes under: its inventory identity's, which is the same value the
 *  adopted seat records as `userOwner`, so a resumed seat is counted against the owner that held
 *  it before the restart ({@link Manager.ownerSeats}) and not against the mesh's default one. */
function resumeOwner(entry: ManagerResumeAgent): string {
  return entry.identity.mode === "user" ? entry.identity.owner : DEV_OWNER;
}

/** Sentinel owner-filter value that matches NO agent's `userOwner` (owner tokens never contain a
 *  dash) — what {@link Manager.psOwnerFilter} returns for an unparseable caller so a malformed
 *  principal fail-closes to an empty `ps` instead of an unbounded one. */
const NO_OWNER_MATCHES = "-no-owner-";

/** Why a frozen manager gate stays frozen on an open mesh. Reconciliation must prove the holder
 *  gone, and an open mesh runs no delivery daemon to prove it, so neither boot self-heal nor
 *  `cotal manager reconcile` can reopen the gate there. */
const OPEN_MESH_GATE_LIMIT = "reconciliation needs liveness evidence an open mesh cannot currently provide, so `cotal manager reconcile` refuses this gate. Keep this store intact; upgrading alone does not recover it";

/** The open mesh's registration evictor. An open mesh has no eviction oracle, so the superseded
 *  family's holders stay unverified as they do with no evictor, and the barrier keeps the gate
 *  frozen. Throwing instead of answering `false` only puts the reason in the refusal. */
function openMeshUnverifiedEviction(holders: readonly string[]): never {
  throw new Error(`principal(s) ${holders.map((h) => `"${h}"`).join(", ")} not verified evicted: ${OPEN_MESH_GATE_LIMIT}`);
}

/** An open-mesh registration refused by a gate another registration froze, restated without the
 *  `cotal reconcile-gate` remedy that cannot run there. Code, gate state, blocked op and op id are
 *  kept. Any other failure is returned as it is. */
function openMeshFrozenGateRefusal(e: unknown, instanceId: string): unknown {
  const envelope = caughtEnvelope(e);
  const blocked = lifecycleBlockedFrom(envelope);
  if (envelope === undefined || blocked?.gateState !== "frozen" || blocked.blockedOp !== "registration") return e;
  return lifecycleBlocked(envelope.code, `the issuance gate for "${instanceId}" is frozen under another registration, and this manager cannot register while it is; ${OPEN_MESH_GATE_LIMIT} (SPEC 13.8)`,
    { blockedOp: blocked.blockedOp, gateState: blocked.gateState, ...(blocked.opId !== undefined ? { opId: blocked.opId } : {}) }, envelope.outcome);
}

/** The failed terminal a post-accept fallback commits for `error` and `source`'s optional details.
 *  `commitGoalResult` refuses a payload that is not interchangeable JSON, and this terminal must commit
 *  whatever failed, so a lone surrogate in the text becomes U+FFFD and details it cannot read or carry
 *  (a Proxy's throwing getter, an accessor, a cycle) are dropped. A Proxy can answer the check and the
 *  serializer differently, so the detached copy is checked again before it commits. */
function failedTerminal(error: string, source: { details?: unknown } | undefined): { error: string; details?: EpEnvelopeError["details"] } {
  const text = error.replace(/\p{Cs}/gu, "\uFFFD");
  try {
    const details = source?.details;
    if (details) {
      const copy = JSON.parse(canonicalJson(details));
      canonicalJson(copy);
      return { error: text, details: copy };
    }
  } catch { /* unreadable or not interchangeable */ }
  return { error: text };
}


/** One absolute budget across authority, preflight and adoption waits, or one closed-serve attempt. */
function remoteStandingTimeLeft(deadline: number): number {
  const left = deadline - performance.now();
  if (left <= 0) throw new Error("remote manager standing operation exceeded its 10000ms aggregate budget");
  return Math.ceil(left);
}

function sameStrings(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());
}

/** The start of every agent's bearer command: node, its loader flags and this manager's entry,
 *  resolved through every symlink. The agent runs that command for each renewal for as long as it
 *  lives, and an install can replace the bin link meanwhile: get.cotal.ai writes a shell launcher
 *  over `~/.local/bin/cotal`, which `npm i -g` had made a link to `dist/cotal.js`. */
function bearerEntryArgv(): string[] {
  return [process.execPath, ...process.execArgv, realpathSync(process.argv[1]!)];
}

/** The caller keeps the arrays it passed, so a launch form is admitted with its own copies: a later
 *  write to the caller's array cannot change what the manager grants, shares or preserves. */
function ownLists<T extends { subscribe?: readonly string[]; allowSubscribe?: readonly string[]; allowPublish?: readonly string[]; capabilities?: readonly string[]; shareTools?: readonly string[] }>(form: T): T {
  return {
    ...form,
    ...(form.subscribe && { subscribe: [...form.subscribe] }),
    ...(form.allowSubscribe && { allowSubscribe: [...form.allowSubscribe] }),
    ...(form.allowPublish && { allowPublish: [...form.allowPublish] }),
    ...(form.capabilities && { capabilities: [...form.capabilities] }),
    ...(form.shareTools && { shareTools: [...form.shareTools] }),
  };
}

/** The inline record is admitted the same way, one level deeper: the record itself, its lists, and
 *  each `endpoints` entry with its commands. It is still untrusted here, so a shape the validator
 *  will refuse is copied as far as it goes and refused where it is read. */
function ownPersona(record: InlinePersona): InlinePersona {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return record;
  const owned = ownLists({ ...record });
  const endpoints: unknown = owned.endpoints;
  if (Array.isArray(endpoints))
    owned.endpoints = endpoints.map((e: unknown) => {
      if (e === null || typeof e !== "object" || Array.isArray(e)) return e;
      const entry = { ...(e as Record<string, unknown>) };
      if (Array.isArray(entry.commands)) entry.commands = [...entry.commands];
      return entry;
    }) as InlinePersona["endpoints"];
  return owned;
}

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

/** Operator-facing phrasing per cause. Kept beside the union so adding a member without a sentence
 *  is a type error rather than a blank in the log. The stop family's sentences carry the principal
 *  from the cause, so they render through {@link STOP_CAUSE_TEXT} under the same exhaustive-Record
 *  discipline: a new stop kind without a renderer is a type error too. */
const FREE_SLOT_CAUSE_TEXT: Record<Exclude<FreeSlotCause, FreeSlotStopCause>, string> = {
  "process-exit": "its own process exited and this manager did not stop it",
  "pi-crash-loop": "this manager retired it after a Pi crash loop",
  "pi-recovery-failed": "this manager retired it after Pi session recovery failed",
  "supervise-crash-loop": "this manager retired it after its supervise restart budget was spent",
  "supervise-recovery-failed": "this manager retired it after a supervised restart failed",
  "session-bind-failed": "this manager stopped it: its host session could not be bound at launch",
  "resume-session-rebind-failed": "this manager stopped it: its host session could not be rebound on resume",
  "carried-fork-refused": "this manager stopped it: it recorded no fork of the carried transcript",
  "resume-custody-unrecorded": "this manager stopped it: its custody reference could not be recorded on resume",
  "supervise-record-failed": "this manager stopped it: its supervise policy could not be recorded for a manager restart",
  "inline-snapshot-changed": "this manager retired it instead of restarting it: its inline persona snapshot changed after launch",
};

/** The stop family's sentences — the same job {@link FREE_SLOT_CAUSE_TEXT} does for the string
 *  causes, beside it so both stay the single place a cause becomes a sentence. A requested stop's
 *  sentence embeds the authenticated principal and a recursive reap's embeds the parent that
 *  left, so they cannot sit in a static Record keyed by kind; this exhaustive switch is their
 *  single home, and the `satisfies never` default keeps the discipline: a new stop kind without a
 *  sentence is a type error rather than a blank in the log. */
function stopCauseText(cause: FreeSlotStopCause): string {
  switch (cause.kind) {
    case "stopped-requested": return `this manager stopped it at ${cause.requester}'s request`;
    case "stopped-self": return "it stopped itself (self-stop)";
    case "stopped-reap": return `this manager stopped it because its parent ${cause.parent} left (recursive reap)`;
    case "stopped-shutdown": return "this manager stopped it on manager shutdown";
    case "stopped-once": return `this manager stopped it: its once task ended (${cause.reason})`;
    default: return cause satisfies never;
  }
}

/** The reason a once task is cancelled with when a stop of this kind ends its seat first. */
function onceStopReason(cause: FreeSlotStopCause): string {
  switch (cause.kind) {
    case "stopped-requested": return "despawned";
    case "stopped-self": return "stopped-itself";
    case "stopped-reap": return "parent-left";
    case "stopped-shutdown": return "manager-shutdown";
    case "stopped-once": return cause.reason;
    default: return cause satisfies never;
  }
}

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
    /** Kickoff prompt from the persona/manifest launch form; a stale-restart re-submits it. */
    prompt?: string;
    subscribe?: string[];
    allowSubscribe: string[];
    allowPublish?: string[];
    capabilities?: string[];
    endpoints?: PersonaEndpoint[];
    events: boolean;
    eventPayloads?: boolean;
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

/** A spawn request, typed. The control-plane `start` op parses one of these out of an
 *  untyped request; roster boot constructs them directly. Both funnel into {@link Manager.startAgent}. */
export interface StartAgentOpts {
  /** The persona REF to spawn — a filename in `.cotal/agents` (the unique spawn key), discovered as
   *  `.cotal/agents/<name>.md`. NOT the mesh identity: the spawned peer presents under the file's
   *  own `name:` (auto-numbered on collision). The file must exist (no silent default-ACL fallback).
   *  With {@link persona}, the helper's own name instead, numbered on collision the same way. */
  name: string;
  /** An inline persona in place of a catalog file. It takes no `config` or `identity`. Validated
   *  where it is read, so a direct call meets the same refusals as the served door. */
  persona?: InlinePersona;
  /** The workflow run whose driver sends this spawn (SPEC 14.8). A manager that does not host the
   *  run reads the run's admission and bounds the helper by it, as the hosting manager does. */
  runId?: string;
  /** Connector / agent type — resolved from the registry. Outranks the persona pin and every default (see `resolveAgentType`). */
  agent?: string;
  /** Detached caller's default connector, kept separate from an explicit flag so the persona file
   *  can outrank it. Imperative control requests only; direct and manifest launches omit it. */
  defaultAgent?: string;
  role?: string;
  /** Explicit agent-file path that overrides the `name` ref for *which file to load* (identity still
   *  comes from that file's `name:`). The file must exist. */
  config?: string;
  /** Presence-identity OVERRIDE (the `--name` flag with a positional/`--config` naming the file):
   *  wins over the persona file's `name:`, exactly as in foreground `cotal spawn`. Imperative-only —
   *  a manifest launch (`resolved`) is the identity authority and rejects it. */
  identity?: string;
  /** Model override (the `--model` flag). Takes precedence over the agent file's `model:`. */
  model?: string;
  /** Model variant override (the `--variant` flag). Takes precedence over the agent file's `variant:`. */
  variant?: string;
  /** Opaque connector launch options (the `--opt k=v` flags). Merged per key over the agent file's
   *  `launchOptions:` (imperative wins); forwarded verbatim to the connector, which validates them. */
  launchOptions?: Record<string, unknown>;
  /** USER-MESH manifest launches only: the derived owner (`u_…`) from the launch spec (the
   *  logged-in operator who applied it). Imperative spawns resolve the owner from the ctl
   *  CALLER's principal instead — never from a payload field. */
  owner?: string;
  /** Opaque host-local session id to FORK into the mesh (the `--resume` flag), forwarded verbatim to
   *  the connector. Only ever set from imperative control args (`opStart`), NEVER from `resolved` —
   *  the manifest path stays resume-free by construction. Unsupported connectors throw at buildLaunch. */
  resume?: string;
  /** The one-time claim `transcript-receive` issued for carried bytes of {@link resume} (#1499), and
   *  the agent the CLI found them with. Imperative control args only, like `resume`. */
  resumeClaim?: string;
  resumeAgent?: string;
  /** Publish the session's AG-UI event plane to its own principal-keyed event channel. Defaults to
   *  on when the connector declares one; `false` (`--no-events`) is the explicit opt-out. */
  events?: boolean;
  eventPayloads?: boolean;
  /** #373: set by `opStart` when a non-owner, non-admin caller omitted `events` and the plane was served
   *  disarmed. Carried into the reply data so the caller sees the downgrade — never silent. */
  eventsNotice?: string;
  /** Initial prompt auto-submitted at session start (the `--prompt` flag), forwarded verbatim to
   *  the connector. Imperative launches only — a manifest launch carries its own `resolved.prompt`
   *  and rejects this flag alongside it (one source, no merge). */
  prompt?: string;
  /** Access-policy overrides (the `--subscribe` / `--allow-subscribe` / `--allow-publish` flags):
   *  win over the persona file exactly as in foreground `cotal spawn`, and are minted into the
   *  creds AND forwarded to the connector from ONE source. Imperative-only — a manifest launch
   *  (`resolved`) is the access authority and rejects these. */
  subscribe?: string[];
  allowSubscribe?: string[];
  allowPublish?: string[];
  /** Channels the seat joins on top of its resolved read set (the peer door's `join`). Each must
   *  fall within the read ACL that resolves below, or the spawn is refused; nothing is widened.
   *  Imperative-only, rejected with `resolved`. */
  join?: string[];
  /** The spawner's own read/post ACL. Consulted only when the persona file names no channel field
   *  at all (`subscribe`, `allowSubscribe`, `allowPublish` all absent): the seat is then scoped to
   *  its spawner, never wider. A persona that names any channel field is the authority and this is
   *  ignored. The spawner's event channel is never inherited (the seat mints its own below).
   *  Imperative-only, rejected with `resolved`. */
  callerAcl?: { allowSubscribe: string[]; allowPublish: string[] };
  /** The request subject the served `spawn` door answered. A hosted enrollment forwards it, and the
   *  issuing host makes the caller it saw publish that subject the helper's parent (SPEC 13.6).
   *  Set by the served door only. */
  served?: string;
  /** Names of the operator's configured MCP servers this agent gets (absent → all declared for the
   *  connector — the pre-merge manager behavior; `[]` → none). */
  shareTools?: readonly string[];
  /** Declarative in-place restart policy from a workflow `spawn`. When set, the manager restarts
   *  the process under the same name, lifecycle uid, persona, worktree and permits until
   *  `restarts` deaths fall inside `windowMs`. Absent: only a continuation-capable connector
   *  (pi) arms the existing session-recovery constants. */
  supervise?: { restarts: number; windowMs: number };
  /** A `once` spawn: the prompt is relayed as the seat's one turn instead of a kickoff, and the
   *  seat is stopped when that turn ends. `deadlineMs` is resolved: `undefined` means no deadline. */
  once?: { deadlineMs: number | undefined };
  /** A fully-resolved launch profile (from a mesh manifest via `supervise --launch`). When present,
   *  `startAgent` takes identity/role/ACLs/capabilities/model from here — NOT from a persona file —
   *  and `config` points at the materialized transient persona the connector reads. The persona file
   *  is never the access authority in this path. */
  resolved?: MeshLaunchAgent;
  /** Per-agent working directory to root this agent at, overriding the manager's shared
   *  workspaceRoot. Lets different agents run in different repos/folders. A relative path is
   *  resolved against the manager's workspace root. Omitted → the agent uses workspaceRoot. */
  cwd?: string;
  /** Internal resolved-manifest provenance used by the preservation inventory. */
  launchRef?: { runId: string; requested: string; hash: string };
  /** The §13.2 rail this spawn rode. Class-rail harness refusals name `--on`; instance-pinned
   *  refusals stay local. Direct `startAgent` (roster / `--spawn`) is not a class request. */
  route?: "one" | "all" | "inst";
  /** The terminal runtime this one seat launches on. Absent uses this manager's own runtime, the
   *  same choice `cotal up --runtime` made. A named runtime is resolved once and reused for every
   *  later seat that names it. An unknown or unreachable one refuses the launch and starts nothing. */
  runtime?: string;
  /** Launch under an admitted delegated user intent (SPEC 13.16): the agent is `owner`'s, and
   *  `parent` is its ledger parent and its recorded spawner. Set only by the composition root's
   *  in-process call; the ctl spawn handler never maps a payload field into it. */
  delegatedIntent?: { intentId: string; owner: string; parent: string };
}

interface ManagedLaunch {
  source: ManagerResumeAgent["launch"]["source"];
  /** The runtime kind this seat was launched on. Absent means the manager's own runtime. */
  runtime?: string;
  cwd: string;
  model?: string;
  variant?: string;
  prompt?: string;
  subscribe?: string[];
  allowSubscribe: string[];
  allowPublish?: string[];
  capabilities?: string[];
  /** The persona's endpoint commands, as minted. Renewal re-mints their rows. */
  endpoints?: PersonaEndpoint[];
  events: boolean;
  eventPayloads?: boolean;
  shareTools?: readonly string[];
  forkSource?: string;
  /** Read from {@link resumeRecordPath} once the seat has written it, then kept. */
  resumed?: ForkProvenance;
  /** A carried resume's claim (#1499): the digest the manager staged, which the seat's fork record
   *  must name before {@link resumed} is set, the host it came from, and when it was staged. */
  carried?: { transcriptSha256: string; host: string; transferredAt: string };
  /** The connector's {@link LaunchSpec.resumeRecordPath} for this seat's fork. */
  resumeRecordPath?: string;
  sessionId?: string;
  unresolvedLaunchOptionKeys?: string[];
}

interface PreparedResume {
  spec: LaunchSpec;
  /** The retained manifest declaration says `continuity: exact`. */
  exact?: boolean;
  /** Set once the spec is handed to runtime.spawn, which owns its launch artifacts from then on. A
   *  spec never handed over is the batch's to discard. */
  spawned?: boolean;
  launchOpts: LaunchOpts;
  id?: string;
  creds?: string;
  userAuth?: UserAuthLaunch;
}

/** What bounds the grant a spawn hands its helper on a static mesh (SPEC 13.15). Nothing for the
 *  manager's own composition root, an operator instrument or a spawner holding the admin set; no
 *  grant at all for a caller whose evidence does not resolve; no spawn at all for a run that was
 *  revoked or whose revocation marker cannot be read; a run's admitted ceiling for its spawns;
 *  otherwise the caller's evidence. */
type StaticSpawnBound =
  | { kind: "exempt" }
  | { kind: "none"; reason: string }
  | { kind: "refused"; reason: string }
  | { kind: "bounded"; caller: EpCaller; ceiling: IssuedSubjectPermissions; run?: string };

/** The workflow run a spawn acts for (SPEC 14.8): the run this manager drives under the spawn's
 *  caller, or, on a static mesh, a run hosted elsewhere whose spawn reached this manager, read from
 *  its admission. That run's revocation marker is read with the admission; a hosted run's is read at
 *  the bound. */
type SpawnRun = { admission: RunAdmission; hosted: boolean } | { refused: string };

/** Why a revoked run starts no helper, the same words wherever the marker is read. */
function revokedRunRefusal(runId: string, revoked: RunRevocation): string {
  return `run ${runId} was revoked by ${revoked.by} (${revoked.reason}); a revoked run starts no helper (SPEC 14.8)`;
}

const INLINE_PERSONA_KEYS = ["prompt", "role", "model", "variant", "description", "subscribe", "allowSubscribe", "allowPublish", "capabilities", "endpoints", "save"];

/** Read an inline persona into the definition a catalog file would load as, refusing what a file
 *  load refuses plus any shape the closed record does not take. The body is literal text: nothing in
 *  it becomes a field, so a body that starts with `---` stays body. */
function inlinePersonaDef(name: string, raw: unknown): { def: AgentDef; save: boolean } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("persona: expected an object");
  const rec = raw as Record<string, unknown>;
  const extra = Object.keys(rec).filter((k) => !INLINE_PERSONA_KEYS.includes(k));
  if (extra.length) throw new Error(`persona: unknown key ${extra[0]}; it takes ${INLINE_PERSONA_KEYS.join(", ")}`);
  const text = (k: string): string | undefined => {
    const v = rec[k];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || !v.trim()) throw new Error(`persona.${k}: expected a non-blank string`);
    return v;
  };
  const list = (k: string): string[] | undefined => {
    const v = rec[k];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`persona.${k}: expected an array of strings`);
    return [...v] as string[];
  };
  const prompt = text("prompt");
  if (prompt === undefined) throw new Error("persona.prompt: required; it is the persona body");
  if (rec.save !== undefined && typeof rec.save !== "boolean") throw new Error("persona.save: expected a boolean");
  const def: AgentDef = {
    name,
    persona: prompt.trim(),
    role: text("role"),
    model: text("model"),
    variant: text("variant"),
    description: text("description"),
    subscribe: list("subscribe"),
    allowSubscribe: list("allowSubscribe"),
    allowPublish: list("allowPublish"),
    capabilities: list("capabilities"),
    endpoints: parsePersonaEndpoints(rec.endpoints, "persona"),
  };
  // The checks a file load makes on these fields: channel names, and the read set within the read ACL.
  try {
    for (const ch of [...(def.subscribe ?? []), ...(def.allowSubscribe ?? []), ...(def.allowPublish ?? [])]) assertValidChannel(ch);
    resolveReadAcl(def.subscribe ?? [], def.allowSubscribe);
  } catch (e) {
    throw new Error(`persona: ${rejectionText(e)}`);
  }
  return { def, save: rec.save === true };
}

/** The refusal a user-auth mesh gives a persona that names `endpoints`. */
function userMeshEndpointsRefusal(door: "spawn" | "define-persona"): string {
  return `${door}: this mesh has per-user auth, where endpoint access comes from the service owner's grants and a persona cannot hand it on (SPEC 13.15). ` +
    "Drop `endpoints` from the persona, and ask the operator to grant the helper with `cotal service-endpoint grant` once it runs.";
}

export interface ManagedAgent {
  name: string;
  role?: string;
  agent: string;
  /** The seat-private Claude home a carried resume launched in (#1499), removed when the seat is freed. */
  seatHome?: string;
  /** Stable id the manager assigned this agent at spawn: the nkey public key (static auth), or
   *  the owner+actor principal dot-form (user mode). */
  id: string;
  /** This incarnation's lifecycle UID (SPEC §13.1), minted once per spawn: the uid its
   *  lifecycle-keyed broker footprint (`dm_…-<uid>`/`dlv_…-<uid>`/ACL row) carries and the ONLY
   *  incarnation its teardown credential may name — a replayed teardown cannot reach a same-name
   *  successor (its uid differs). */
  lifecycleUid: string;
  /** Private nkey seed, kept so a later step can mint matching creds for this id. Static auth
   *  only — a user-mode agent has no static identity (its credential is its bearer). */
  seed?: string;
  /** The SPEC 13.15 issuance of a static agent's credential: the generation its rails carry and
   *  the accepted-row token its endpoint discovers it by. A renewal keeps both (the ceiling is
   *  unchanged by construction); absent on a user-mode or open agent. */
  issued?: IssuedBinding;
  /** Set for a USER-MODE agent: its derived owner. Marks the slot for user-mode teardown (ledger
   *  revoke + token/sentinel/health file removal) and the auth-health read in {@link list}. */
  userOwner?: string;
  /** Launched under a delegated user intent (SPEC 13.16). Only {@link Manager.retireDelegatedAgent}
   *  retires it: this holder's own prepare and requester bind to the holder's owner. */
  delegated?: true;
  /** The FS materialization paths of THIS incarnation's secret family, recorded at spawn (the
   *  lifecycle-keyed derivation) or at adoption (the resume inventory's recorded paths — possibly a
   *  previous generation's name-keyed layout). Teardown, preservation, and health reads consume
   *  THESE, never a re-derivation by name alone, so a stale/replayed teardown can only ever address
   *  this incarnation's own files — the manager-local half of the SPEC 13.1 name-disjoint
   *  discipline (the broker half is the uid-pinned deprovisioner). Present per mode: static =
   *  `creds`; user = `actorToken`/`sentinelCreds`/`health`; open = absent. Absent (never `{}`)
   *  when nothing was recorded, so teardown's uid-keyed derivation fallback stays reachable. */
  secretPaths?: { creds?: string; actorToken?: string; sentinelCreds?: string; health?: string };
  /** Authenticated id of the peer that requested this spawn (the control-plane `req.from.id`),
   *  or the manager's own id for roster/pre-spawn. Non-forgeable — set by `handle()`. The spawner
   *  ledger (P4b) keys own-children despawn + reap-on-parent-exit off this. */
  spawner: string;
  authorityParent?: string;
  startedAt: number;
  handle: AgentHandle;
  /** This agent's local control endpoint (path + first-frame auth token), when its connector runs
   *  one. Kept in memory only (never persisted — token hygiene) so a graceful stop on a signal-less
   *  runtime (ConPTY/Windows) can send a cooperative `{op:"shutdown"}` over it instead of a hard
   *  kill that would deny the agent its clean mesh-leave. */
  control?: ControlEndpoint;
  /** Set when `Runtime.spawnDelegated` started this seat outside the manager's filesystem. Its
   *  handle's `stop()` is the fenced close by lifecycle key, which retirement runs only after the
   *  host revoked the grant, never from the stop door. */
  handedOff?: true;
  launch: ManagedLaunch;
  /** The bounded launch wait elapsed without a join. Process liveness is separate, and an
   * exact-incarnation late join clears this diagnostic without stopping the seat. */
  joinIssue?: string;
  /** Set on a manifest `continuity: exact` seat once its first session was proven: the coordinates
   *  its assignment is recorded under, kept current at every later proven rebind and at its stop. */
  continuity?: Omit<ContinuityAssignment, "version" | "sessionId">;
  /** In-memory process-recovery input. It is never persisted with secret values: preservation
   * reconstructs it from the validated inventory and current config. Continuation-capable
   * connectors (pi) receive it by default; any connector receives it when spawn carries
   * `supervise`. */
  restart?: {
    opts: LaunchOpts;
    sessionStatePath?: string;
    crashes: number[];
    recovering: boolean;
    armed: boolean;
    /** Present when spawn carried `supervise`; recoverManagedSession takes its budget from it.
     *  Absent on the pi path without a policy, which keeps SESSION_RESTART_LIMIT / WINDOW_MS. */
    policy?: { restarts: number; windowMs: number };
  };
  /** Set on a `once` seat: the goal of its one task, and why this manager stopped the seat, if it
   *  did. The task is cancelled with that reason when the seat's exit is proved before it ended. */
  once?: { ref: GoalRef; stopReason?: string; retire?: string };
  /** The connector's clause when this seat's startup ended `ready` on a connector whose idle wake
   *  needs a confirmed startup: mesh traffic does not wake the seat. On the spawn reply and the ps row. */
  startupNotice?: string;
  /** Preservation and a not-yet-confirmed resume retain broker/auth state if the process exits. */
  suppressCleanup?: boolean;
  /** The TERMINALIZING latch: flipped SYNCHRONOUSLY before the first await on every
   *  stop/despawn path (stopHandle + freeSlot are the chokepoints). Once set, this principal's
   *  control ops refuse and no later renewal is admitted. A renewal already admitted drains before
   *  the durable terminal begins, so its row and material are included in revocation and cleanup. */
  terminalizing?: boolean;
  /** Why this manager stopped the seat, set with {@link terminalizing} by the first stop. The exit
   *  watcher frees the slot with it, so an exit the stop caused is not logged or ended as the
   *  seat's own. */
  stopCause?: FreeSlotCause;
  /** Set while the manager has logged this seat off the mesh with its slot still held (#1208);
   *  cleared when the seat is logged back on. */
  offMesh?: boolean;
  /** The one renewal admitted before terminalization. Retirement drains it before revocation and
   *  cleanup; callers arriving after the latch never join it. */
  staticCredentialRenewal?: Promise<void>;
}

/** Runtime hooks the spawn-as-action serve path injects into {@link Manager.startAgent}.
 *  Roster boot and the blocking callers pass none (unchanged behavior). */
export interface SpawnHooks {
  /** Fires synchronously AFTER the incarnation identity (nkey + lifecycleUid) is minted but BEFORE
   *  any provision/side-effect — the accept seam: it binds the goal and replies the acceptance. A
   *  THROW here aborts the spawn before provisioning (the existing catch returns the failure and the
   *  finally releases the reserve, so no footprint leaks) — this is the bind-conflict refusal path.
   *  On the hosted enrollment arm it fires right after the host enrolls the agent, because the host
   *  picks the uid; a throw there rolls that enrollment back. */
  onAccepted?: (allocated: { name: string; identity: Identity; lifecycleUid: string; agentTriple: { owner: string; actor: string; uid: string } }) => Promise<void> | void;
  /** Fires once the child process has been launched (the "launched" progress edge). A THROW here
   *  aborts the spawn with the seat already running and the handle held only in a local, so the
   *  finally's orphan rollback reaps it by the reference the spawn reserved. */
  onLaunched?: () => void;
  /** Fires once the connector has supplied the exact bounded readiness window for this launch,
   * before the process starts. The action goal records that same value at acceptance. */
  onReadinessWindow?: (readinessTimeoutMs: number) => Promise<void> | void;
  /** Fires at the readiness verdict (presence join → succeeded / process exit → failed / window
   *  elapsed → uncertain), carrying the succeeded reply data — the async serve body commits the goal
   *  terminal + emits the final progress event here. Awaited, but the caller swallows its own errors
   *  so a terminal-commit failure never disrupts the (already-replied) spawn. Resolves true only
   *  when this call committed the terminal; a once task is served only after that. */
  onOutcome?: (outcome: { kind: "succeeded" | "failed" | "uncertain"; data?: unknown }) => Promise<boolean | void> | boolean | void;
  /** Fires when this spawn ends with its goal's terminal owned by ANOTHER path — today only a
   *  despawn/stop that lands inside the readiness window, whose own handler commits `cancel`.
   *  It commits nothing; it only claims the terminal so the post-accept fallback does not
   *  manufacture a `failed` from the non-ok reply and race the real `cancel`. Without it, a
   *  deliberate stop mid-launch reports the agent as having died on launch. */
  onTerminalDeferred?: () => void;
  /** Fires right before the first effect this spawn or launch takes: the name reserve, a re-driven
   *  teardown, or a launch file written to disk. A refusal before it changed nothing, so the
   *  action path answers it `not-executed` (SPEC 13.3); one after it keeps an unknown outcome. */
  onEffect?: () => void;
  /** Fires when a refusal after the first effect left nothing behind: the host refused the agent's
   *  enrollment with `code`, and the spawn removed every secret it had staged. The action path
   *  answers it `not-executed` with that code, as it answers a refusal before the first effect. */
  onUndone?: (code: EpErrorCode) => void;
  /** Fires right after `onAccepted` on a `once` spawn, before anything launches: accepts the seat's
   *  one task as a turn addressed to the allocated incarnation and returns its goal. A throw fails
   *  the spawn. */
  onOnce?: (task: { seat: { name: string; owner: string; actor: string; uid: string }; prompt: string; spawner: string; deadlineMs: number | undefined; readinessDeadlineMs: number; retire?: string }) => Promise<{ ref: GoalRef; deadlineAt?: number }>;
}

class LegacyEventCountPermissionError extends Error {}

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

function participantKey(owner: string, actor: string, uid: string): string {
  return `${owner}.${actor}.${uid}`;
}

/** The spawn-as-action acceptance floor: the ALLOCATED agent identity (name + the
 *  addressing triple) plus the goal coordinates (goalId = the request id) and
 *  the executor coordinate (the manager incarnation its terminal fences on). Carries NO secret
 *  material; it names what was actually allocated, never a requested-but-unallocated name. */
export interface SpawnAcceptance {
  name: string;
  owner: string;
  actor: string;
  uid: string;
  goalId: string;
  fingerprint: string;
  /** The connector-selected readiness budget persisted on this goal. A synchronous follower must
   *  outlive it; otherwise it can time out while the manager is still legitimately waiting. */
  readinessDeadlineMs: number;
  executor: { lifecycleUid: string; epoch: number };
}

/**
 * Event channels in `channels` that do NOT belong to `{owner, actor}`.
 *
 * ONE HELPER FOR EVERY SEAM THAT ARMS AN ACL, and that is the whole design. The rule first existed
 * only at the spawn accept seam, and a security review found the hole that shape guarantees: resume
 * re-arms a managed row straight from the inventory document, and `renewManagedStaticCred` re-mints
 * the JWT from that row, so an admin-supplied inventory could carry a foreign concrete event channel
 * past a fence that only ever looked at spawns. A rule with one call site is a rule that covers one
 * door.
 *
 * IT COMPARES PRINCIPALS, NOT STRINGS. `eventChannelPrincipal` decodes the channel back to the
 * `{owner, actor}` it names, so this is mode-independent: static keys the actor on the allocated
 * nkey and user mode keys it on the alias, and neither needs its own branch here.
 *
 * STATED LIMIT, unchanged and asserted by a cell: the decode refuses anything that is not exactly
 * two principal tokens, so a WILDCARD is not an event channel to it. `events.<owner>.>` and
 * `events.>` pass untouched and are governed by ordinary ACL authority. This closes the concrete
 * form, which is what a caller writes when it knows which agent it wants to read, and not the
 * wildcard form, which is what an operator writes deliberately for an observer.
 */
function foreignEventChannels(channels: readonly string[], owner: string, actor: string): string[] {
  return channels.filter((ch) => {
    const p = eventChannelPrincipal(ch);
    return p !== null && !(p.owner === owner && p.actor === actor);
  });
}

/** One connector's declared harness binaries resolved on PATH now. The refusal sentence is built only
 *  here, so the boot row and the check for a connector registered after boot can never word it apart. */
function resolveHarness(name: string, requires: readonly string[]): { binaries: Record<string, string>; reason?: string } {
  const binaries: Record<string, string> = {};
  const missing: string[] = [];
  for (const bin of requires) {
    const path = resolveOnPath(bin);
    if (path) binaries[bin] = path;
    else missing.push(bin);
  }
  return missing.length ? { binaries, reason: `${name} harness needs ${missing.join(", ")} on PATH - not found` } : { binaries };
}

/** True only when the delivery-admin rail has no bound responder. A timeout is a hung rail, not absence. */
function isAbsentDeliveryAdmin(error: unknown): boolean {
  return error instanceof RequestError && error.isNoResponders();
}

/** The store challenge went UNANSWERED while a delivery daemon exists: the rail timed out, or it had
 *  no responder while the lease row names a holder. Both are what a daemon that is starting or
 *  re-acquiring its lease looks like, so manager boot waits them out (#871); a renewal pass still
 *  refuses on the first one. A reply that does not decode was answered and is never this. */
class DeliveryAdminUnanswered extends Error {}

/** How long one store challenge waits for the delivery daemon's answer. */
const STORE_CHALLENGE_TIMEOUT_MS = 5_000;

/**
 * The agent supervisor: a long-lived mesh node that owns agent process lifecycle.
 * It serves control requests on the "manager" service and spawns/kills agents
 * through a pluggable {@link Runtime} (pty by default). It does NOT proxy agent
 * mesh traffic — terminal I/O streams over its own attach endpoint instead.
 */
export class Manager {
  private readonly space: string;
  private readonly servers: string | undefined;
  /** The broker ws listener port (loopback) `cotal up` allocated, for the console session
   *  client's wsUrl. Undefined ⇒ no console session client (POST /session 503s). */
  private readonly wsPort?: number;
  private readonly name: string;
  private readonly workspaceRoot: string;
  private readonly eventsRequired: boolean;
  private readonly eventPayloadsWithheld: boolean;
  /** The operator-set global live-session ceiling (see {@link ManagerOptions.maxSessions}). */
  private readonly maxSessions?: number;
  /** The operator-set per-owner seat ceiling (see {@link ManagerOptions.seatCap}). */
  private readonly seatCap: SeatCap;
  /** The ONE secret store for every kind this manager touches (daemon-cred remint + agent kinds).
   *  See {@link ManagerOptions.secretStore}. */
  private readonly secrets: SecretStore;
  /** Named identity of {@link secrets}: the same coordinate the delivery daemon must reload from.
   *  Set at construction for an injected store; the workspace store is named on first challenge. */
  private secretStoreIdentity?: SecretStoreIdentity;
  /** See {@link ManagerOptions.installedExtensions}. */
  private readonly installedExtensions: boolean;
  private readonly expectedConnectorGeneration: string;
  private readonly machineSetupCommand?: string;
  private readonly executionState: { kind: "none" } | { kind: "runtime" };
  // Declared only: no own Runtime slot exists in the none arm.
  declare private readonly runtime: Runtime;
  /** One backend per kind a seat has asked for, beside {@link runtime}. The manager's own runtime
   *  stays the default and is never replaced by a later seat's choice. */
  private readonly runtimes = new Map<string, Runtime>();
  /** Hosted pooled control, recorded so a later seat cannot add a custodial runtime the constructor
   *  already refused for the manager's own. */
  private readonly pooled: boolean;
  /** Internal test seam. Production leaves this undefined and uses the scoped delivery-admin evictor. */
  private staticLifecycleEvict?: (principal: string) => Promise<import("@cotal-ai/core").EvictionResult>;
  private readonly preserveStopTimeoutMs: number;
  private readonly endpointServeExecutorExpiresInSeconds?: number;
  private readonly agents = new Map<string, ManagedAgent>();
  /** Lifecycle UIDs already handed to `Runtime.spawnDelegated`: a lifecycle is handed off at most
   *  once, so a lost create acknowledgement can never become a second create. */
  private readonly delegatedLaunched = new Set<string>();
  /** This manager process's own incarnation uid (SPEC 13.1; minted once per supervisor process,
   *  never reused across restarts) — the endpoint's presence key AND the `managerInstance` audit
   *  coordinate every static activation records. */
  private readonly managerLifecycleUid = mintLifecycleUid();
  /** The persisted LOGICAL instance id (SPEC 13.6 item 7): STABLE across restart, so a
   *  restart re-registers the SAME id with an ADVANCED epoch through the §13.1 gate (the successor
   *  fences the predecessor's epoch — the (i) fence bites on a real restart). It is the registration
   *  instanceId, the served-status id, the goal spec's executor.instanceId, the epe route, and the
   *  resolveExecutorEpoch key — DISTINCT from {@link managerLifecycleUid} (per-process: the presence
   *  node uid + the managerInstance audit coordinate every static activation records). Set in start(). */
  private managerInstanceId!: string;
  /** The persisted serve nkey identity: reusing the SAME principal across restart keeps
   *  {@link provisionEndpointGateOpen} idempotent (no core barrier change) and gives verified
   *  eviction a stable target (the predecessor's connections under this principal). Set in start(). */
  private managerServeIdentity!: Identity;
  /** The local instance identity {@link admitExecutionState} already resolved. The ordinary start
   *  adopts it instead of reading the same record again. */
  private admittedLocalIdentity?: ManagerInstanceIdentity;
  private readonly onServiceIdentity?: ManagerOptions["onServiceIdentity"];
  /** The manager's v0.4 service-endpoint serve state — the serve handle +
   *  its dedicated connection, the STABLE serve identity (renewals re-mint the same nkey), the
   *  branded serve grant, and the CURRENT credential (the connection's authenticator reads it on
   *  every (re)connect, so a renewal is adopted without re-registration). Absent on open meshes,
   *  in user mode, and before registration completes. */
  private serviceServe?: { handle: EpServeHandle; nc: NatsConnection; identity: Identity; grant: EpServeGrant; creds?: string };
  /** #1577: dedicated connections (serve, goal-writer, session-ledger) whose transport is down while
   *  the client reconnects them, tracked by {@link trackTransport}. Such a connection is open
   *  (`isClosed()` is false under unbounded reconnects) yet the broker holds none of its rails, so
   *  the liveness responder must not grade the serve connection `bound`, and a stop closes rather
   *  than drains it ({@link retireConnection}). Keyed by the connection, so a re-dial that swaps in a
   *  fresh one starts from its own state. */
  private readonly transportDown = new WeakSet<NatsConnection>();
  /** The spawn-as-action SELF-MEDIATED goal-writer connection + ActionContext — a
   *  standing connection DISJOINT from the serve credential, scoped to exactly this endpoint's
   *  goal bind/terminal facts + goal-record writes ({@link goalWriterGrants}). Auth mode mints the
   *  `goal-writer` cred; an open mesh uses a bare connection (no credential system to mint from).
   *  `gate` (auth mode) is the own-issuance-gate READER for the own-gate currency belt — the
   *  manager reads its OWN `epgate.<e>.<iid>` epoch over this connection before a terminal commit
   *  and skips a superseded commit (the fast-fail belt paired with the (b) barrier-revoke fence). */
  private goalWriter?: { nc: NatsConnection; ctx: ActionContext; creds?: string; identity: Identity; gate?: EpIssuanceGate };
  /** The workflow-run host (SPEC 14.3): the drives this incarnation holds, each on its own
   *  per-run credential and connection. Absent under a remote authority, which mints no driver
   *  credentials, so the `run-*` family refuses there rather than connecting on a weaker identity. */
  private runHosting?: RunHosting;
  /** The STABLE goal-writer identity (auth mode) — minted once at
   *  registration alongside the serve identity; a renewal re-mints the SAME nkey with a fresh
   *  bounded exp and re-stages its distinct credId into the §13.1 revocation family. The current
   *  goal-writer credential is minted INSIDE {@link registerManagerService}'s run block (fence
   *  live) and stashed here for {@link startGoalWriter} to build the standing connection from. */
  private goalWriterIdentity?: Identity;
  private goalWriterCreds?: string;
  /** The manager's ONE §13.6 session plane — offer mint + one-use redeem + PTY-bridge
   *  standup for `attach`. The face's establisher and the CLI attach handler both call THIS one
   *  plane; the manager never constructs a second. Undefined until {@link startSessionPlane}. */
  private sessionPlane?: ManagerSessionPlane;
  /** The standing session-LEDGER connection + its mutable creds holder (the authenticator
   *  presents the refreshed cred on the next reconnect after a half-TTL renewal — the goal-writer
   *  precedent). Auth mode only; an open mesh runs the plane over a bare connection. */
  private sessionLedgerConn?: { nc: NatsConnection; creds?: string };
  /** Renews the session signing key long before its window closes. A key that expires unattended
   *  takes the whole session plane down until the manager is restarted, which kills live sessions. */
  private sessionKeyRenewTimer?: ReturnType<typeof setInterval>;
  /** The STABLE session-LEDGER identity (auth mode) — minted once at registration
   *  alongside the serve + goal-writer identities; a renewal re-mints the SAME nkey with a fresh
   *  bounded exp and re-stages its distinct credId into the §13.1 revocation family. The current
   *  credential is minted INSIDE {@link registerManagerService}'s run block and stashed here. */
  private sessionLedgerIdentity?: Identity;
  private sessionLedgerCreds?: string;
  /** The acceptance replied for each goal this incarnation accepted, by {@link goalKey}, so an
   *  idempotent same-goalId retry serves the IDENTICAL acceptance (same allocated name/triple)
   *  without a second spawn. An entry lives while its goal is in flight and for
   *  {@link goalAcceptanceRetentionMs} after its terminal commits; a later retry, or one at another
   *  incarnation, is answered from the goal index while the goal runs and from its committed
   *  result fact once it has ended. */
  private goalAcceptances = new Map<string, SpawnAcceptance>();
  /** How long a terminal goal's acceptance stays in {@link goalAcceptances}: the retry window its
   *  turn twin keeps a settled answer for. An instance field so a test can shorten it. */
  private goalAcceptanceRetentionMs = TURN_ANSWER_RETENTION_MS;
  /** The boot reconcile of the durable goal index runs ONCE at start (a
   *  fresh incarnation inherits the endpoint's accepted-but-unterminal goals from any predecessor).
   *  Spawn-as-action REFUSES to accept until it completes, so the sweep never races a live goal's
   *  acceptance (settling one mid-flight would steal its real terminal). */
  private goalReconcileDone = false;
  /** The live spawn goal ref for each managed agent name, so a despawn MID-GOAL
   *  drives the cancel path (transition -> cancel terminal). Cleared when the goal terminalizes. */
  private agentGoals = new Map<string, GoalRef>();
  private turnRelayInstance?: TurnRelay;
  private get turnRelay(): TurnRelay {
    return this.turnRelayInstance ??= new TurnRelay({
      goalWriter: () => this.goalWriter,
      serviceServe: () => this.serviceServe,
      space: this.space,
      managerInstanceId: () => this.managerInstanceId,
      execution: this.execution,
      executionRefusal: this.executionRefusal(),
      goalReconcileDone: () => this.goalReconcileDone,
      readinessTimeoutMs: () => this.readinessTimeoutMs,
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
  private readonly participants = new Map<string, PersonalTurnParticipant>();
  /** Once tasks whose seat's exit is watched: that exit, not the spawn's outcome, settles the debt. */
  private readonly onceWatched = new Set<string>();
  /** Process start, for the served `status` uptime. */
  private readonly startedAtMs = Date.now();
  /** Connector harness inventory. Available paths stay pinned; missing binaries are retried when
   * launch, model lookup or status asks, without stopping unrelated Manager work. */
  private connectorStatuses: ManagerConnectorStatus[] = [];
  private connectorRequirements = new Map<string, readonly string[]>();
  /** The boot inventory's warnings, printed once start completes, so a refused start prints none. */
  private bootNotes: string[] = [];
  /** The complete boot task. stop() joins it after fencing static reconciliation, so a registration
   * already past an earlier shutdown check cannot finish after stop() returns. */
  private startTask?: Promise<void>;
  /** This instance's side of a carried resume transcript (#1499); absent where it has no transfer reader. */
  private transcripts?: TranscriptReceiver;
  /** The one stop this manager runs, with the agent policy it was asked for. A stop takes seats out
   *  of `agents` before they have exited, so a second teardown would find none and report success
   *  while the first still waits on a live seat. */
  private stopTask?: { withAgents: boolean; done: Promise<void> };
  /** Held as an instance field so broker-owning smokes can compress the schedule without changing
   *  production semantics. It is never a fence expiry: the durable non-retired row stays authoritative. */
  private staticReconcileRetryDelaysMs: readonly number[] = STATIC_RECONCILE_RETRY_DELAYS_MS;
  /** Retirements holding one of the {@link RETIREMENT_CONCURRENCY} slots. */
  private retirementsRunning = 0;
  /** Retirements waiting for a slot, oldest first. */
  private readonly retirementQueue: Array<() => void> = [];
  private readonly attach: AttachEndpoint;
  private ep!: CotalEndpoint;
  /** Space trust material when the mesh runs in auth mode (`.cotal/auth` present);
   *  the manager mints per-agent creds from it at spawn. Undefined when the mesh is open. */
  private auth?: SpaceAuth;
  /** Readiness-race backstop (#159 B1) — the {@link READINESS_TIMEOUT_MS} constant, held as an instance
   *  field so a test can shorten it (the join/exit signals are event-driven; only the backstop is timed).
   *  Production leaves it at the constant. */
  private readinessTimeoutMs = READINESS_TIMEOUT_MS;
  /** True on a USER-AUTH space (the on-disk marker; cross-checked against the registry at start).
   *  Gates the whole spawn path: user mode grants ledger actors + bearer plumbing, never static mints. */
  private userMode = false;
  private readonly namesCapacity = new NamesCapacity({
    userMode: () => this.userMode,
    authEnabled: () => this.auth !== undefined,
    maintenanceActive: () => this.maintenanceState === "active",
    roster: () => this.ep.getRoster(),
    agentFor: (name) => this.agents.get(name),
    hasAgent: (name) => this.agents.has(name),
    removeAgent: (name) => { this.agents.delete(name); },
    managedCount: () => this.agents.size,
    predecessor: (name) => this.retirement.predecessor(name),
    hasRetirementHold: (name) => this.retirement.hasHold(name),
    holdRetirement: (name, hold) => this.retirement.hold(name, hold),
    endSessionsForTarget: (...args) => { this.sessionPlane?.endForTarget(...args); },
    logSeatReaped: (...args) => this.logSeatReaped(...args),
    recordContinuityAtStop: (...args) => this.recordContinuityAtStop(...args),
    releasedSeatPending: (...args) => this.releasedSeatPending(...args),
    dropSeatRecord: (...args) => this.dropSeatRecord(...args),
    failSeatTurns: (...args) => this.failSeatTurns(...args),
    teardownTarget: (...args) => this.teardownTarget(...args),
    dropInlineSnapshot: (...args) => this.dropInlineSnapshot(...args),
    trackDeprovision: (...args) => this.trackDeprovision(...args),
  });
  private readonly servePlane = new ServePlane({
    auth: () => this.auth,
    remoteAuthority: () => this.remoteAuthority,
    space: () => this.space,
    servers: () => this.servers,
    workspaceRoot: () => this.workspaceRoot,
    managerInstanceId: () => this.managerInstanceId,
    managerServeIdentity: () => this.managerServeIdentity,
    leaseStopping: () => this.leaseStopping,
    remoteBundleRenewal: () => this.remoteBundleRenewal,
    maxSessions: () => this.maxSessions,
    serviceServe: () => this.serviceServe,
    setServiceServe: (value) => { this.serviceServe = value; },
    sessionLedgerIdentity: () => this.sessionLedgerIdentity,
    setSessionLedgerIdentity: (value) => { this.sessionLedgerIdentity = value; },
    sessionLedgerCreds: () => this.sessionLedgerCreds,
    setSessionLedgerCreds: (value) => { this.sessionLedgerCreds = value; },
    sessionLedgerConn: () => this.sessionLedgerConn,
    setSessionLedgerConn: (value) => { this.sessionLedgerConn = value; },
    sessionPlane: () => this.sessionPlane,
    setSessionPlane: (value) => { this.sessionPlane = value; },
    sessionKeyRenewTimer: () => this.sessionKeyRenewTimer,
    setSessionKeyRenewTimer: (value) => { this.sessionKeyRenewTimer = value; },
    connectorStatuses: () => { this.refreshUnavailableConnectors(); return this.connectorStatuses; },
    setGoalWriterIdentity: (value) => { this.goalWriterIdentity = value; },
    setGoalWriterCreds: (value) => { this.goalWriterCreds = value; },
    remoteStandingBudgetMs: REMOTE_STANDING_BUDGET_MS,
    dial: (...args) => this.dial(...args),
    dialRemoteStanding: (...args) => this.dialRemoteStanding(...args),
    trackTransport: (...args) => this.trackTransport(...args),
    discardServeCandidate: (...args) => this.discardServeCandidate(...args),
    managerServiceDefs: (...args) => this.managerServiceDefs(...args),
    omitClassCommands: (...args) => this.omitClassCommands(...args),
    resolveTarget: (target) => this.resolveServeTarget(target),
    withEndpointServeExecutor: (...args) => this.withEndpointServeExecutor(...args),
    withOpenServeConnection: (...args) => this.withOpenServeConnection(...args),
    boundedReconnect: (...args) => this.boundedReconnect(...args),
    renewRemoteBeforeRedial: (...args) => this.renewRemoteBeforeRedial(...args),
    scheduleServeRenewal: (...args) => this.scheduleServeRenewal(...args),
    stop: (...args) => this.stop(...args),
    healFrozenRegistrationGate: (...args) => this.healFrozenRegistrationGate(...args),
    mintAndStageGoalWriter: (...args) => this.mintAndStageGoalWriter(...args),
    retireConnection: (...args) => this.retireConnection(...args),
    withTimeout,
    remoteStandingTimeLeft,
    openMeshUnverifiedEviction,
    openMeshFrozenGateRefusal,
  });

  private resolveServeTarget(t: { owner: string; actor: string }): { lifecycleUid: string; mappingRevision: number } | undefined {
          if (this.remoteAuthority) {
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
  private readonly retirement = new Retirement({
    auth: () => this.auth,
    remoteAuthority: () => this.remoteAuthority,
    userMode: () => this.userMode,
    workspaceRoot: () => this.workspaceRoot,
    space: () => this.space,
    servers: () => this.servers,
    secrets: () => this.secrets,
    serveIdentity: () => this.managerServeIdentity,
    lifecycleUid: () => this.managerLifecycleUid,
    instanceId: () => this.managerInstanceId,
    serveEpoch: () => this.serviceServe?.grant.epoch,
    dial: (opts) => this.dial(opts),
    withRetirementSlot: (run) => this.withRetirementSlot(run),
    driveStaticRetirement: (a) => this.driveStaticRetirement(a),
    awaitHandleExit: (handle) => this.awaitHandleExit(handle),
    shredUserSecrets: (failures, family) => this.shredUserSecrets(failures, family),
    dropSeatRecord: (a) => this.dropSeatRecord(a),
    fenceRetiringAcl: (a) => this.fenceRetiringAcl(a),
    lifecycleMembershipInventory: (a) => this.lifecycleMembershipInventory(a),
    brokerTeardown: (task, message) => withTimeout(task, DEPROVISION_TIMEOUT_MS, message),
    trackLifecycle: () => { this.lifecycleInFlight++; return () => this.releaseLifecycle(); },
  });
  private readonly lease = new LeaseKeeper({
    endpoint: () => this.ep,
    instanceId: () => this.managerInstanceId,
    space: () => this.space,
    stopping: () => this.leaseStopping,
  });
  private get leaseInfo(): Omit<ManagerLeaseInfo, "since"> | undefined { return this.lease.leaseInfo; }
  private set leaseInfo(info: Omit<ManagerLeaseInfo, "since"> | undefined) { this.lease.leaseInfo = info; }
  private get leaseRevision(): number | undefined { return this.lease.leaseRevision; }
  private set leaseRevision(revision: number | undefined) { this.lease.leaseRevision = revision; }
  private get leaseTimer(): ReturnType<typeof setInterval> | undefined { return this.lease.leaseTimer; }
  private set leaseTimer(timer: ReturnType<typeof setInterval> | undefined) { this.lease.leaseTimer = timer; }
  private get leaseRenewTask(): Promise<void> | undefined { return this.lease.leaseRenewTask; }
  private acquireInstanceLease(info: Omit<ManagerLeaseInfo, "since">): Promise<number> { return this.lease.acquireInstanceLease(info); }
  private renewLease(): Promise<void> { return this.lease.renewLease(); }
  private releaseOwnManagerLease(): Promise<void> { return this.lease.releaseOwnManagerLease(); }
  /** Set at the top of `stop()`. `renewLease` returns at once once this is set, and its `gone` arm
   *  does not re-acquire: a manager that is stopping never puts its own key back. It also closes the
   *  lifecycle fence ({@link beginLifecycle}), so no spawn can launch a seat the stop never sees. */
  private leaseStopping = false;
  private readonly shutdownReadiness = new AbortController();
  /** The class-2 renewal owner's half-TTL schedule; armed only on auth meshes. */
  private credRenewTimer?: ReturnType<typeof setInterval>;
  private resumeCredRenewal?: () => void;
  /** #2073: the `endpoint-serve` credential's OWN renewal, armed from its `[renewAt, exp)` window
   *  (`credsRenewalDelayMs`) rather than left to `credRenewTimer`'s boot-phased TTL/4 tick, which can
   *  miss the window by ordering. Re-armed at registration and after every successful re-mint;
   *  cleared in `stop()` beside `credRenewTimer`. */
  private endpointServeRenewalTimer?: ReturnType<typeof setTimeout>;
  /** #1634: does THIS manager own the delivery daemon's credential renewal? True only while the
   *  daemon reloads from this manager's store AND this manager holds the per-space renewal lease.
   *  Starts false: a manager that has not proved both must not remint. */
  private daemonRenewalOwner = false;
  /** #2561: may the lease heartbeat contend at all? Set by every claim, false while the daemon names
   *  another store or the challenge refused. Without it the heartbeat re-takes the lease the claim
   *  just released and holds it against every manager and `doctor auth --fix` that can remint. */
  private daemonRenewalEligible = false;
  private daemonRenewalLeaseTimer?: ReturnType<typeof setInterval>;
  private maintenanceState: ManagerMaintenanceState = "active";
  private lifecycleInFlight = 0;
  private lifecycleDrainWaiters: Array<() => void> = [];
  private preservationTask?: Promise<ManagerPreserveResult>;
  private preparationTask?: Promise<ManagerPreservationPlan>;
  private preservationGeneration = 0;
  private preservationAttemptId?: string;
  private preservationStarted = false;
  private preservationFailures: ManagerPreserveFailure[] = [];
  private unverifiedStops: Array<{ name: string; id: string; handle: AgentHandle; authoritative?: boolean; error?: string }> = [];
  private preservationInventory?: ManagerResumeInventory;
  private resumeAttemptId?: string;
  private resumeInventoryDigest?: string;
  private resumeInventory?: ManagerResumeInventory;
  private resumeTask?: Promise<ManagerResumeResult>;
  private resumeResult?: ManagerResumeResult;
  private resumeRequired = false;
  private resumeAwaitingCommit = false;
  private resumeCommitted = false;
  private resumeCommitTask?: Promise<ControlReply>;
  private resumeFinalized = false;
  private resumeDurableCommitToken?: string;
  private readonly resumedAgentNames = new Set<string>();
  private readonly remoteAuthority?: NonNullable<ManagerOptions["remoteAuthority"]>;
  private remoteExecutorCreds?: string;
  private remoteSupervisorCreds?: string;
  private remoteBundleRenewal?: Promise<void>;
  private remoteBundleAdoption?: Promise<void>;
  private finishRemoteBundleAdoption?: () => void;
  /** A refused or failed standing candidate is cleanup debt, never a silent loss: the last-good
   * family stays live and this records what the host may have signed but the manager never adopted. */
  private remoteRenewalDebt?: { at: number; processEpoch: number; reason: string; unadoptedSubjects: string[] };

  /** Every broker dial this manager makes, through ONE transport decision.
   *
   *  `this.servers` is whatever the mesh record held (`cotal supervise` reads it from there), so it
   *  can be a `ws://`/`wss://` broker published through an HTTPS edge. The raw node transport
   *  refuses such a URL instead of dialing it, so the scheme picks the dialer here rather than at
   *  thirteen call sites. `dialerFor` also owns the websocket transport's options, which is why
   *  callers below still pass their own auth options unchanged. */
  private dial(opts: Parameters<ReturnType<typeof dialerFor>>[0]): Promise<NatsConnection> {
    const servers = this.servers ?? DEFAULT_SERVER;
    return dialerFor(servers)({ ...opts, servers });
  }

  /** Initial NATS timeout is per dial, not per server list. Keep the aggregate deadline too, and
   * close a late result rather than letting an abandoned preflight or recovery install a transport. */
  private async dialRemoteStanding(opts: Parameters<ReturnType<typeof dialerFor>>[0], deadline: number): Promise<NatsConnection> {
    const ms = remoteStandingTimeLeft(deadline);
    const pending = this.dial({ ...opts, timeout: ms });
    try {
      const nc = await withTimeout(pending, ms, "remote manager standing dial exceeded its 10000ms aggregate budget");
      remoteStandingTimeLeft(deadline);
      if (this.leaseStopping) throw new Error("manager stopped while a remote standing dial was in flight");
      return nc;
    } catch (e) {
      // Timing out our wait does not cancel connect(). It still owns its socket until it rejects
      // or returns a connection, which must close without serving or changing a current holder.
      void pending.then((nc) => nc.close(), () => {}).catch((error) => console.error(`! remote manager abandoned standing dial cleanup: ${rejectionText(error)}`));
      throw e;
    }
  }

  private readonly seatCustody = new SeatCustody({
    staticAuth: () => !!this.auth && !this.userMode,
    workspaceRoot: () => this.workspaceRoot,
    space: () => this.space,
    instanceId: () => this.managerInstanceId,
    endpoint: () => this.ep,
    secrets: () => this.secrets,
    eventPayloadsWithheld: () => this.eventPayloadsWithheld,
    runtimeFor: (kind) => this.runtimeFor(kind),
    requiredRuntime: () => this.requiredRuntime,
    withLifecycleExecutor: (pin, fn) => this.withLifecycleExecutor(pin, fn),
    watchConnectorHolder: (handle, holder) => this.watchConnectorHolder(handle, holder),
    resumeEntryOf: (agent) => this.resumeEntryOf(agent),
    inventoryReferenceError: (entry) => this.inventoryReferenceError(entry),
    registerAgent: (name, agent) => { this.agents.set(name, agent); },
    agentFor: (name) => this.agents.get(name),
    watchExit: (agent) => this.watchExit(agent),
    bindOnceSeat: (agent) => this.bindOnceSeat(agent),
    renewManagedStaticCred: (agent) => this.renewManagedStaticCred(agent),
    resumeSupervisedAgent: (entry, supervised) => this.resumePreservedAgent(entry, false, false, undefined, supervised),
  });

  private readonly sessionRecovery = new SessionRecovery({
    workspaceRoot: () => this.workspaceRoot,
    execution: () => this.execution,
    executionRefusal: () => this.executionRefusal(),
    instanceId: () => this.managerInstanceId,
    endpoint: () => this.ep,
    beginLifecycle: () => this.beginLifecycle(),
    freeSlot: (agent, floor, cause) => this.freeSlot(agent, floor, cause),
    reapChildrenOf: (principal) => this.reapChildrenOf(principal),
    managedPrincipal: (agent) => this.managedPrincipal(agent),
    inlineSnapshotChange: (agent) => this.inlineSnapshotChange(agent),
    agentFor: (name) => this.agents.get(name),
    maintenanceState: () => this.maintenanceState,
    resolveConnector: (name) => this.resolveConnector(name),
    runtimeFor: (kind) => this.runtimeFor(kind),
    reserveCustody: (runtime) => this.reserveCustody(runtime),
    recordSlotCustody: (agent, reference) => this.recordSlotCustody(agent, reference),
    spawnCustodied: (runtime, name, spec, cwd, reserved) => this.spawnCustodied(runtime, name, spec, cwd, reserved),
    awaitReadiness: (agent, timeoutMs, opts) => this.awaitReadiness(agent, timeoutMs, opts),
    readinessTimeoutMs: () => this.readinessTimeoutMs,
    recordSlotRuntime: (agent) => this.recordSlotRuntime(agent),
    refreshSeatRecord: (agent) => this.refreshSeatRecord(agent),
    watchExit: (agent) => this.watchExit(agent),
    tail: (session) => this.tail(session),
    stopHandle: (agent, graceful, cause) => this.stopHandle(agent, graceful, cause),
    trackStoppedHandle: (agent, floor, cause) => this.trackStoppedHandle(agent, floor, cause),
  });

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

  private readonly staticLifecycle = new ManagedStaticLifecycle({
    space: () => this.space,
    servers: () => this.servers,
    auth: () => this.auth,
    secrets: () => this.secrets,
    workspaceRoot: () => this.workspaceRoot,
    instanceId: () => this.managerInstanceId,
    processUid: () => this.managerLifecycleUid,
    userMode: () => this.userMode,
    eventPayloadsWithheld: () => this.eventPayloadsWithheld,
    evictor: () => this.staticLifecycleEvict,
    retryDelays: () => this.staticReconcileRetryDelaysMs,
    resumeRequired: () => this.resumeRequired,
    records: () => this.goalWriter?.ctx.kv,
    agentFor: (name) => this.agents.get(name),
    retirementFor: (name) => this.retirement.held(name),
    recordStaticRetirement: (a) => this.retirement.recordStaticRetirement(a),
    noteRetiredPrincipal: (principal) => { this.retirement.rememberRetired(principal); },

    foreignEventChannels: (channels, owner, actor) => foreignEventChannels(channels, owner, actor),
    withIssuer: (fn) => this.withIssuer(fn),
    deprovisionBroker: (a) => this.deprovisionBroker(a),
    reapOrphanSeat: (a) => this.reapOrphanSeat(a),
    withLifecycleExecutor: (pin, fn) => this.withLifecycleExecutor(pin, fn),
    readerRemedy: (owner, channel) => this.readerRemedy(owner, channel),
    withProvisioner: (fn) => this.withProvisioner(fn),
    beginLifecycle: (resumeOperation) => this.beginLifecycle(resumeOperation),
    maintenanceError: () => this.maintenanceError(),
    withRetirementSlot: (run) => this.withRetirementSlot(run),
    managedStaticInstanceReads: (capabilities) => this.managedStaticInstanceReads(capabilities),
    issuanceSeam: (i, mode, a, exp) => this.issuanceSeam(i, mode, a, exp),
    refreshSeatRecord: (a) => this.refreshSeatRecord(a),
    dial: (opts) => this.dial(opts),
    seatRecordFor: (row) => this.seatRecordFor(row),
    restartSupervisedSeat: (row, record) => this.restartSupervisedSeat(row, record),
    adoptSeat: (row, record) => this.adoptSeat(row, record),
    dropSeatRecord: (a) => this.dropSeatRecord(a),
  });

  /** User-mode provisioning owns no manager state: each dependency reads through at its use. */
  private readonly userProvision = new UserProvision({
    space: () => this.space,
    workspaceRoot: () => this.workspaceRoot,
    secrets: () => this.secrets,
    managerInstanceId: () => this.managerInstanceId,
    runHosting: () => this.runHosting,
    remoteAuthority: () => this.remoteAuthority,
    deprovision: (target) => this.deprovision(target),
    withProvisioner: (fn) => this.withProvisioner(fn),
    shredUserSecrets: (failures, family) => this.shredUserSecrets(failures, family),
    bearerEntryArgv,
  });

  constructor(opts: ManagerOptions) {
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
    this.space = opts.space;
    this.servers = opts.servers;
    this.name = opts.name ?? "manager";
    this.workspaceRoot = opts.workspaceRoot ?? findCotalRoot();
    this.onServiceIdentity = opts.onServiceIdentity;
    this.eventsRequired = opts.eventsRequired === true;
    this.eventPayloadsWithheld = opts.eventPayloadsWithheld === true;
    this.maxSessions = opts.maxSessions;
    this.seatCap = opts.seatCap ?? DEFAULT_SEAT_CAP;
    this.remoteAuthority = opts.remoteAuthority;
    this.remoteExecutorCreds = opts.remoteAuthority?.executorCreds;
    this.remoteSupervisorCreds = opts.remoteAuthority?.supervisorCreds;
    if (opts.pooled && (!opts.remoteAuthority?.accountPublicKey ||
        accountFromCreds(opts.remoteAuthority.supervisorCreds) !== opts.remoteAuthority.accountPublicKey))
      throw new Error("pooled control requires a proved assigned account for its initial supervisor credential");
    if (opts.remoteAuthority) this.managerLifecycleUid = opts.remoteAuthority.lifecycleUid;
    this.secrets = opts.secretStore ?? workspaceSecretStore(this.workspaceRoot);
    if (opts.secretStore) this.secretStoreIdentity = injectedSecretStoreIdentity(opts.secretStore);
    this.installedExtensions = opts.installedExtensions ?? false;
    this.expectedConnectorGeneration = MANAGER_VERSION;
    this.machineSetupCommand = opts.machineSetupCommand;
    this.pooled = opts.pooled === true;
    this.executionState = opts.execution === "none" ? { kind: "none" } : { kind: "runtime" };
    if (!this.remoteAuthority) {
      // A fresh root has no execution record, so construction does not read the identity. Records
      // survive identity retirement; only the currently stored identity's record can be claimed.
      const prefix = `manager-execution.${spaceKey(this.space)}.`;
      const dir = join(this.workspaceRoot, ".cotal");
      const hasRecord = existsSync(dir) && readdirSync(dir).some((name) => name.startsWith(prefix) && name.endsWith(".json"));
      if (hasRecord) {
        const local = loadManagerInstanceIdentity(this.workspaceRoot, this.space);
        if (local && existsSync(this.executionRecordPath(local.instanceId))) {
          this.claimExecutionRecord(local.instanceId);
          this.admittedLocalIdentity = local;
        }
      }
    }
    if (this.executionState.kind === "runtime") this.runtime = createRuntime(opts.runtime ?? "auto", `cotal-${this.space}`);
    if (opts.pooled && this.executionState.kind === "runtime" && isCustodialRuntime(this.requiredRuntime))
      throw new Error(`pooled control refuses custodial runtime "${this.requiredRuntime.kind}" before starting agents`);
    this.preserveStopTimeoutMs = opts.preserveStopTimeoutMs ?? PRESERVE_STOP_TIMEOUT_MS;
    this.endpointServeExecutorExpiresInSeconds = opts.endpointServeExecutorExpiresInSeconds;
    if (opts.resumeAttemptId && !/^[A-Za-z0-9_-]{1,128}$/.test(opts.resumeAttemptId))
      throw new Error("resumeAttemptId must be a safe token (letters, digits, _, -; max 128)");
    if (opts.resumeDurableCommitToken && !/^[a-f0-9]{64}$/.test(opts.resumeDurableCommitToken))
      throw new Error("resumeDurableCommitToken must be a lowercase 32-byte token");
    if (opts.resumeDurableCommitToken && !opts.resumeAttemptId)
      throw new Error("resumeDurableCommitToken requires resumeAttemptId");
    this.resumeAttemptId = opts.resumeAttemptId;
    this.resumeRequired = opts.resumeAttemptId !== undefined;
    this.resumeDurableCommitToken = opts.resumeDurableCommitToken;
    this.wsPort = opts.wsPort;
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
  }

  get runtimeKind(): string {
    return this.executionState.kind === "none" ? "none" : this.requiredRuntime.kind;
  }

  /** Whether this manager's runtime opens a terminal stream on the seats it spawns, so a caller
   *  knows before it asks whether `attach` can open one here. A control instance with no execution
   *  spawns no seat, so it streams no terminal either. */
  get streamsTerminal(): boolean {
    return this.executionState.kind !== "none" && this.requiredRuntime.streamsTerminal;
  }

  get execution(): "runtime" | "none" {
    return this.executionState.kind;
  }

  private executionRefusal(): string {
    return "execution: none forbids seat launch, workflow hosting, model inspection and caller-driven writes on this control instance; select the participant Manager with an instance-pinned manager-caller view";
  }

  /** A defensive last barrier, not a substitute Runtime. Entry admission runs before effects. */
  private get requiredRuntime(): Runtime {
    if (this.executionState.kind === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    return this.runtime;
  }

  /** Import the installed extension that provides a seat's runtime before {@link runtimeFor}
   *  resolves it, as {@link resolveConnector} does for a connector. On the published binary the
   *  manager process imports only its own runtime, so a seat that names another installed runtime
   *  found nothing in the registry and was refused as unknown. The manifest is consulted first, so a
   *  live `cotal ext remove` refuses the next launch even while an earlier import keeps the provider
   *  registered; seats already on that runtime keep their cached backend. A library composition
   *  resolves only what its root imported. The refusal names an official runtime's package. */
  private async loadSeatRuntime(kind: string | undefined): Promise<void> {
    const asked = kind?.trim();
    if (!this.installedExtensions || this.executionState.kind === "none" || !asked || asked === "auto" || asked === "pty" || asked === this.runtime.kind) return;
    if (!manifestExtensionNames("runtime").includes(asked)) throw new Error(runtimeInstallHint(asked));
    await materializeFromManifest<RuntimeProvider>({ kind: "runtime", name: asked }, { hint: (ref) => runtimeInstallHint(ref.name), expectedGeneration: this.expectedConnectorGeneration });
  }

  /** The backend one seat launches, restarts, and is reaped through. An omitted or blank choice is
   *  this manager's own runtime. A named one is created once, cached by its resolved kind, and reused
   *  for every later seat of that kind. The manager's own runtime is never replaced. An unknown or
   *  unreachable runtime throws, and pooled control refuses a custodial one by the same rule the
   *  constructor applied to the manager's own. */
  private runtimeFor(kind: string | undefined): Runtime {
    if (this.executionState.kind === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    const asked = kind?.trim();
    if (!asked) return this.runtime;
    if (asked === "auto")
      throw new Error(`runtime "auto" chooses the manager's runtime, not one seat; omit runtime to use ${this.runtime.kind}`);
    if (asked === this.runtime.kind) return this.runtime;
    const cached = this.runtimes.get(asked);
    if (cached) return cached;
    const runtime = createRuntime(asked, `cotal-${this.space}`);
    if (this.pooled && isCustodialRuntime(runtime))
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
    const state = this.serviceServe;
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

  private serviceIdentityObservation(): ManagerServiceIdentity {
    if (!this.managerInstanceId || !this.managerServeIdentity) throw new Error("manager native service identity has not been selected");
    const principal: EpCaller = this.remoteAuthority
      ? { owner: this.remoteAuthority.owner, actor: this.remoteAuthority.actors.serve, uid: this.managerLifecycleUid }
      : { owner: DEV_OWNER, actor: this.managerServeIdentity.id, uid: this.managerLifecycleUid };
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
  private get meshMode(): "open" | "static" | "user" {
    if (this.userMode) return "user";
    if (this.auth !== undefined) return "static";
    return "open";
  }

  /** The CHAT stream frontier at a preservation cut (issue #545), read through whichever local
   *  authority this mesh mode holds: open mode's own endpoint already has `$JS.API.STREAM.INFO`
   *  on the CHAT stream. Local and remote supervisor credentials also hold this metadata grant
   *  for transcript startup checks, but this preservation path retains its existing local-authority
   *  boundary. Static/user modes borrow the ephemeral `provisioner` profile the manager already
   *  mints per spawn. A remote-authority manager (`this.auth`
   *  undefined in static/user mode) has no local space authority to mint that provisioner with, so
   *  it prints one line and returns no floor — the inventory then carries none and resumed seats
   *  behave exactly as before this fix, not a silent partial degrade. */
  private async chatFrontierForPreservation(): Promise<number | undefined> {
    switch (this.meshMode) {
      case "open":
        return this.ep.chatFrontier();
      case "static":
      case "user":
        if (!this.auth) {
          console.error(
            "! preservation: this manager holds no local space authority to read the chat frontier; retained seats replay their channel windows on resume",
          );
          return undefined;
        }
        return this.withProvisioner((prov) => prov.chatFrontier());
    }
  }

  private readerRemedy(owner: string, channel: string): string {
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
    const task = this.runStart();
    let wrapped!: Promise<void>;
    wrapped = task.finally(() => {
      if (this.startTask === wrapped) this.startTask = undefined;
    });
    this.startTask = wrapped;
    return wrapped;
  }

  private executionRecordPath(instanceId: string): string {
    return join(this.workspaceRoot, ".cotal", `manager-execution.${spaceKey(this.space)}.${instanceId}.json`);
  }

  private claimExecutionRecord(instanceId: string): void {
    const record = claimIdentityRecord(this.executionRecordPath(instanceId), "manager execution capability", (raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
      const r = raw as Record<string, unknown>;
      return Object.keys(r).sort().join(",") === "execution,instanceId,space,v" && r.v === 1 && r.space === this.space &&
        r.instanceId === instanceId && (r.execution === "none" || r.execution === "runtime") ? r : undefined;
    }, () => ({ v: 1, space: this.space, instanceId, execution: this.execution }));
    if (record.execution !== this.execution)
      throw new Error("manager execution capability differs from its retained instance record; execution cannot change across restart");
  }

  private async admitExecutionState(): Promise<void> {
    if (!this.remoteAuthority) {
      let local = this.admittedLocalIdentity;
      this.admittedLocalIdentity = undefined;
      if (this.execution === "none") {
        const recorded = loadMeshes().find((m) => m.space === this.space);
        const auth = hasUserAuthState(this.workspaceRoot, this.space) && recorded?.mode === "user"
          ? await getSpaceAuth(this.secrets, this.space) : undefined;
        if (!auth)
          throw new Error("execution: none requires a genuine hosting user-auth root and its user-mode mesh record");
        if (!local) local = loadManagerInstanceIdentity(this.workspaceRoot, this.space);
        if (local && !existsSync(this.executionRecordPath(local.instanceId)))
          throw new Error("execution: none refuses an existing unclassified manager instance; keep its runtime and retained state, or register a fresh control instance");
        if (!local) {
          const proposed = { instanceId: mintLifecycleUid(), serveIdentity: newIdentity() };
          local = createManagerInstanceIdentity(this.workspaceRoot, this.space, () => proposed);
          if (local.instanceId !== proposed.instanceId)
            throw new Error("execution: none refuses a concurrently claimed unclassified manager identity");
        }
        const localInstanceId = local.instanceId;
        this.claimExecutionRecord(localInstanceId);
        const nc = await this.dial({ ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "provisioner"), tls: false }), maxReconnectAttempts: 0 });
        try {
          const kvm = new Kvm(nc);
          await ensureAuthorityStores(await jetstreamManager(nc), kvm, this.space);
          const entries = await listGoalIndex(await kvm.open(recordsBucket(this.space)), MANAGER_ENDPOINT);
          if (entries.some((entry) => entry.iid === localInstanceId && (entry.allocated !== undefined || entry.note !== undefined)))
            throw new Error("execution: none refuses retained seat or turn inventory before recovery; keep the execution-owning Manager");
        } finally { await drainAndClose(nc); }
        this.admittedLocalIdentity = local;
      } else {
        local ??= createManagerInstanceIdentity(this.workspaceRoot, this.space, () => ({ instanceId: mintLifecycleUid(), serveIdentity: newIdentity() }));
        this.claimExecutionRecord(local.instanceId);
        this.admittedLocalIdentity = local;
      }
      return;
    }
    if (this.remoteAuthority) {
      if (this.execution === "none" && (await localTrustOfSpace(this.secrets, this.space)).present)
        throw new Error("remote manager-service authority cannot be combined with local space signing trust - choose one authority path, never a fallback");
      // Execution is fixed for a registered instance. An older instance with no capability
      // record might own retained seats/runs, so it cannot be converted to none by omission.
      const remote = this.remoteAuthority;
      const path = this.executionRecordPath(remote.instanceId);
      if (this.execution === "none" && !existsSync(path) && remote.serveGrant.epoch !== 0)
        throw new Error("execution: none refuses an existing unclassified manager instance; keep its runtime and retained state, or register a fresh control instance");
      if (this.execution === "none") {
        const entries = await remote.scanGoalIndex();
        if (entries.some((entry) => entry.iid === remote.instanceId && (entry.allocated !== undefined || entry.note !== undefined)))
          throw new Error("execution: none refuses retained seat or turn inventory before recovery; keep the execution-owning Manager");
      }
      if (this.execution === "none" || existsSync(path)) this.claimExecutionRecord(remote.instanceId);
    }
  }

  private async runStart(): Promise<void> {
    await this.admitExecutionState();
    this.staticLifecycle.start();
    await this.inspectConnectorsAtBoot();
    await this.attach.start();
    // In auth mode the manager is just another user in the space's account — it mints
    // itself creds from the same signing key it uses for the agents it spawns. The signer comes
    // through the SecretStore seam (`this.secrets` — the injected `ManagerOptions.secretStore`, or
    // the local `.cotal/auth/auth.json` FS default), so a HOSTED composition mints from its KMS/Vault
    // and no signing seed is ever read from the hosted disk. `this.space` cross-checks the bundle.
    //
    // REMOTE AUTHORITY (#1944): a manager holding host-issued remote authority mints nothing from a
    // local signer, so it never composes or validates local trust. It asks ONE question of the
    // store — does THIS space's own local signing trust exist (`localTrustOfSpace`) — because that
    // alone is the conflict of authorities a supervisor refuses. The stock behaviour this replaces
    // read the whole root's trust chain (`getSpaceAuth`): with no records for this space it fell
    // back to the legacy monolith of an UNRELATED static tenant and reported that bundle as
    // "corrupt or mislabeled". Other tenants' records — split (their account + the shared
    // per-root broker record) or monolith — are not this space's trust and never refuse; an
    // unreadable record on a key that is read refuses loud with the store's own parse message.
    //
    // An OPEN mesh mints nothing, also in a root that still holds a static stack's accounts. A
    // credential minted there joins this instance's family in the open account, and the next open
    // boot could re-register only by verify-evicting it through a delivery daemon that an open mesh
    // does not run.
    const recorded = loadMeshes().find((m) => m.space === this.space);
    if (this.remoteAuthority) {
      if ((await localTrustOfSpace(this.secrets, this.space)).present)
        throw new Error("remote manager-service authority cannot be combined with local space signing trust - choose one authority path, never a fallback");
      this.auth = undefined;
    } else {
      this.auth = recorded?.mode === "open" ? undefined : await getSpaceAuth(this.secrets, this.space);
    }
    // USER-MODE detection is FAIL-CLOSED on the on-disk marker (the space-scoped state dir), never
    // on the mutable mesh registry alone — registry drift/tamper must not let a user-auth space
    // take the static self-mint branch. A marker/registry disagreement is a refused start with the
    // repair, not a guess.
    this.userMode = this.remoteAuthority !== undefined || hasUserAuthState(this.workspaceRoot, this.space);
    if (!this.remoteAuthority && recorded && (recorded.mode === "user") !== this.userMode)
      throw new Error(
        `mesh registry says space "${this.space}" is ${recorded.mode}-mode but the on-disk user-auth marker ${this.userMode ? "exists" : "is missing"} (${userAuthStateDir(this.workspaceRoot, this.space)}) - \`cotal down\` and re-\`cotal up\` this space to reconcile before running a manager`,
      );
    if (!this.remoteAuthority && this.userMode && !recorded)
      throw new Error(
        `space "${this.space}" has user-auth state on disk but no mesh registry entry - a user-mode manager needs the authoritative record (\`cotal up\` writes it before the control plane); \`cotal up --user-auth\` this space, or remove the stale ${userAuthStateDir(this.workspaceRoot, this.space)}`,
      );
    if (!this.remoteAuthority && this.userMode && !this.auth)
      throw new Error(
        `space "${this.space}" has user-auth state but no auth.json under ${authDir(this.workspaceRoot)} - the pre-flip manager still needs the space trust bundle; re-run \`cotal up --user-auth\` here`,
      );
    // SPEC 13.6 item 7: the LOGICAL instance id + serve identity PERSIST across restart
    // (a space-scoped manager identity file under .cotal). A restart re-registers the SAME id with an
    // ADVANCED epoch (the successor fences the predecessor); a fresh mint over a malformed file is
    // refused loud (no-fallbacks - a restart never silently becomes a fresh instance). A second
    // manager in a DIFFERENT workspace root is a DIFFERENT logical id by construction (its own state
    // dir) - two managers in ONE space are two workspace roots.
    //
    // First mint on a fresh root is exclusive create (#1263). Two processes that both observe no
    // file must not keep different in-memory ids: of N concurrent starts exactly one publishes the
    // file by hard link and the others adopt that identity before taking a lease, or refuse with
    // identity-record-create-lost. A filesystem without hard links refuses the first start with
    // atomic-publish-unsupported. Atomic rename is not enough, because the loser
    // of a replace would still serve under the id it minted.
    {
      if (this.remoteAuthority) {
        this.managerInstanceId = this.remoteAuthority.instanceId;
        this.managerServeIdentity = this.remoteAuthority.identities.serve;
      } else {
        // Admission already resolved this identity, including the first mint. A second claim here
        // would stat the same record again.
        const claimed = this.admittedLocalIdentity;
        if (!claimed) throw new Error("manager start has no admitted local identity");
        this.admittedLocalIdentity = undefined;
        this.managerInstanceId = claimed.instanceId;
        this.managerServeIdentity = claimed.serveIdentity;
      }
    }
    await this.onServiceIdentity?.(this.serviceIdentityObservation());
    let creds: (() => Promise<string>) | undefined;
    let id: string | undefined;
    if (this.remoteAuthority) {
      const remote = this.remoteAuthority;
      id = remote.identities.supervisor.id;
      creds = async () => this.remoteSupervisorCreds!;
    } else if (this.auth) {
      const identity = newIdentity();
      const auth = this.auth;
      id = identity.id;
      // The long-lived SUPERVISOR cred (closure (ii), residual 2): serve the three control tiers, hold the
      // singleton lease (open-only), publish + watch presence — and nothing else. Provisioning runs on an
      // EPHEMERAL provisioner connection per spawn (withProvisioner); destructive purge mints a PURGER per
      // call. So the always-on daemon holds no DM/DLV read, no consumer-create, no stream-admin tamper.
      //
      // STANDING RENEWAL (class 1): the manager holds the DATA signing seed, so it is its
      // own renewal owner — the cred rides the endpoint's SOURCE seam and self-remints (same identity,
      // pinned by the endpoint) ahead of each bounded supervisor JWT's expiry. A copied supervisor
      // cred is broker-dead within the matrix TTL.
      creds = () => mintCreds(auth, identity, "supervisor");
    }
    this.ep = new CotalEndpoint({
      space: this.space,
      servers: this.servers,
      channels: [],
      creds,
      // The supervisor registers on the roster, and an authed presence-registering endpoint is
      // lifecycle-keyed (SPEC 13.1, fail-before-presence). The manager process is the top of its
      // own launch chain (the operator command IS its launcher): its incarnation uid is the
      // per-process `managerLifecycleUid` field (also the `managerInstance` audit coordinate on
      // every static activation).
      lifecycleUid: this.remoteAuthority?.lifecycleUid ?? this.managerLifecycleUid,
      // The supervisor serves control + watches presence; it never consumes chat/dm/task
      // (no message handler). consume:false avoids binding consumers it doesn't use — and
      // under auth avoids trying to bind its own DM/task durables that nothing pre-created.
      // It still pre-creates OTHERS' durables via provisionDmInbox/provisionTaskQueue (lazy jsm).
      consume: false,
      // It also never reads the channel registry (it provisions + serves control, no channel
      // pull/display), so skip the channel-registry watch — the supervisor cred (residual 2) then
      // holds no channel-KV read grant. Presence (the roster) is still watched.
      watchChannels: false,
      // `host` says which machine runs this manager, as an agent's card does: an owner with several
      // managers tells them apart by it. Advisory display metadata, never a routing input.
      card: { id, ...(this.remoteAuthority ? { owner: this.remoteAuthority.owner, actor: this.remoteAuthority.actors.supervisor } : {}), name: this.name, role: "manager", kind: "endpoint", meta: { host: hostname(), terminal: this.streamsTerminal ? "stream" : "none" } },
    });
    // Raw failures ride error; conditions the endpoint is already surviving ride warning. Both
    // matter to a supervisor operator, especially a failed standing-credential renewal.
    const reportEndpoint = (e: Error) => console.error(`! manager endpoint: ${e.message}`);
    this.ep.on("error", reportEndpoint);
    this.ep.on("warning", reportEndpoint);
    // Every roster change and every view transition, so a seat that is offline in a fresh snapshot
    // (recorded with no presence event) is logged the moment the view can support the verdict.
    this.ep.on("roster", () => this.logSeatMeshTransitions());
    this.ep.on("presence-view", () => this.logSeatMeshTransitions());
    console.error("manager startup: connecting the supervisor endpoint");
    await this.ep.start();
    await this.ep.setActivity(`supervisor (${this.runtimeKind})`);
    // Per-instance liveness lease (the old per-space singleton is DEMOTED). Acquire
    // THIS logical instance's own key (atomic CAS create). A DIFFERENT instance (a second manager in a
    // second workspace root) has a distinct id ⇒ a distinct key ⇒ it coexists; the create THROWS only
    // when the SAME instance id is already live (a same-root double-start, or a restart racing the
    // crashed predecessor's not-yet-expired key). A double-start REFUSES loud; a restart whose
    // predecessor is provably dead on this host waits for that key's bucket TTL to remove it (#4092,
    // {@link acquireInstanceLease}). Losing the key LATER ends this process only when another process holds it; otherwise
    // the renew loop puts it back or keeps retrying ({@link renewLease}).
    this.leaseInfo = { holder: this.ep.ref().id, instanceId: this.managerInstanceId, runtime: this.runtimeKind, root: resolve(this.workspaceRoot), pid: process.pid };
    try {
      console.error("manager startup: acquiring the instance liveness lease");
      this.leaseRevision = await this.acquireInstanceLease(this.leaseInfo);
    } catch (e) {
      await this.ep.stop();
      await this.attach.stop();
      throw e;
    }
    this.leaseTimer = setInterval(() => { void this.renewLease(); }, MANAGER_LEASE_RENEW_MS);
    this.leaseTimer.unref?.();
    // THE PEER-READABLE LIVENESS RESPONDER for the manager plane (#1577). Bound HERE — after the
    // lease, before registration — precisely so it is up during the window in which the manager is
    // NOT yet serving. A responder that only appeared once everything worked could never report the
    // broken state it exists to report, which is the reported defect in a new place.
    //
    // WHAT IT GRADES is `serviceServe`, the v0.4 service endpoint's serve handle, which is assigned
    // only after `serveEndpoint` has bound this instance's rails, AND that handle's connection. A
    // closed serve connection holds no subscriptions, while `onServeConnectionClosed` keeps the
    // handle through its re-dial waits, so the handle alone would answer `bound` with every rail
    // gone. The re-dial swaps in the fresh connection and handle together, so `bound` returns only
    // once the rails are served again. A DISCONNECTED serve connection is the same fault without the
    // close: it reconnects without limit, so it stays open while the broker holds none of its rails,
    // and this probe arrives on the separate supervisor connection that is still up. So the grade
    // also requires the serve transport to be connected. That is a RESPONDER fact. It is
    // deliberately NOT "this process is alive": this process is trivially alive whenever it answers
    // at all, so grading on that would make the surface a `pgrep` that also lies in both directions
    // — the exact instrument the reporter's evidence table indicts. Between lease acquisition and a
    // successful registration the honest answer is `unbound`, and that is what a peer is told.
    //
    // The lease row is never consulted and never sent: presence is the whole ask, and the row
    // carries the operator's workspace root and pid.
    this.ep.serveLiveness("manager", () => {
      const s = this.serviceServe;
      return s?.handle && !s.nc.isClosed() && !this.transportDown.has(s.nc) ? "bound" : "unbound";
    });
    // Static §13.1: after this instance holds its lease, collect the durable static rows
    // now, but do not let their exact-op terminals make the whole space unreachable. The service
    // comes up below, then the sweep overlaps the remaining registration work. Two-window
    // heal-then-register is slower than one executor, but the overlap is still the no-outage
    // property: `reconcilingAliases` refuses spawn or attach of THAT alias until its terminal
    // attempt returns.
    const startupReconcile = this.auth && !this.userMode ? this.reconcileStaticLifecycles() : undefined;
    if (startupReconcile)
      void startupReconcile.catch((e) => console.error(`! ${STARTUP_RECONCILING}: ${rejectionText(e)} - no per-alias retry could be planned; a later manager start re-reads unfinished durable terminals`));
    // A default stop records a user-mode seat it released while the seat was still running. This
    // start adopts that seat, or retires it when the runtime proves it gone. Static seats stay on
    // the sweep above.
    if (this.userMode)
      void this.adoptReleasedSeats().catch((e) => console.error(`! a released seat was not adopted: ${rejectionText(e)}`));
    // The manager serves NO ctl tiers - its whole control surface is the v0.4
    // service endpoint registered below. The old three-tier rail (self/manager/admin) is deleted;
    // `ctl.delivery`/`ctl.delivery-admin` (the delivery daemon) and `ctl.auth-admin` (the auth
    // plane) are separate services and keep their rails.
    // Class 2: the manager is the CLASS-2 RENEWAL OWNER — the one control-plane process
    // that is resident in EVERY mesh mode (foreground `up`, `up --detach`, same-root refresh) and
    // holds the signer. Ordered initial pass NOW (ensureControlPlane starts delivery BEFORE the
    // manager, so the daemon's launch-time creds write always precedes this — no write race), then
    // every half-TTL: re-sign the daemon creds files for their EXISTING nkeys, request the explicit
    // `reloadCreds` adoption on the delivery-admin rail, and persist the audit record doctor renders.
    if (this.auth) {
      // #1634: a space may be served by several managers, so ownership of the daemon's credential
      // renewal is decided here rather than by being the only manager able to start. #871: a daemon
      // that is still binding or re-acquiring its lease leaves this challenge unanswered for a few
      // seconds, so boot waits that out instead of exiting over a daemon about to answer.
      await this.claimDaemonRenewalOwnership(DELIVERY_ADMIN_BOOT_WAIT_MS);
      // ARMED BEFORE the first remint, not after. That first `renewDaemonCreds()` re-signs through
      // the SecretStore, and a slow or contended store makes the one pass outlast the lease's
      // MANAGER_LEASE_TTL_MS. Arming afterwards leaves the whole first remint unprotected: the lease
      // expires mid-pass, a second manager's CAS create succeeds, and both remint into one store.
      this.daemonRenewalLeaseTimer = setInterval(() => { void this.keepDaemonRenewalLease(); }, MANAGER_LEASE_RENEW_MS);
      this.daemonRenewalLeaseTimer.unref?.();
      await this.renewDaemonCreds();
      this.credRenewTimer = setInterval(() => { void this.renewDaemonCreds(); }, credRenewIntervalMs(STANDING_RENEWABLE_TTL_SEC));
      this.credRenewTimer.unref?.();
    } else if (this.remoteAuthority) {
      if (this.remoteAuthority.renewStandingBundle) await this.renewRemoteStandingBundle();
      else await this.renewRemoteExecutor();
      let standingTtl = STANDING_RENEWABLE_TTL_SEC;
      if (this.remoteSupervisorCreds) {
        try {
          const claims = credsClaims(this.remoteSupervisorCreds);
          if (typeof claims.exp === "number" && typeof claims.iat === "number" && claims.exp > claims.iat) {
            standingTtl = claims.exp - claims.iat;
          }
        } catch {}
      }
      // A refused family needs another pass inside the final quarter of its lifetime.
      const intervalMs = Math.min(credRenewIntervalMs(5 * 60), Math.max(1, Math.floor(standingTtl * 1000 / 8)));
      this.resumeCredRenewal = () => {
        if (this.credRenewTimer || this.leaseStopping) return;
        this.credRenewTimer = setInterval(async () => {
          try {
            if (this.remoteAuthority?.renewStandingBundle) await this.renewRemoteStandingBundle();
            else await this.renewRemoteExecutor();
          } catch (e) {
            console.error(`! remote manager renewal pass failed: ${rejectionText(e)}`);
          }
          try {
            await this.runHosting?.renew();
          } catch (e) {
            console.error(`! remote run-hosting renewal pass failed: ${rejectionText(e)}`);
          }
        }, intervalMs);
        this.credRenewTimer.unref?.();
      };
      this.resumeCredRenewal();
    }
    // stop() fences before it waits for an accepted startup reconciliation terminal. Once that
    // terminal drains, start() and stop() resume from the same await boundary; start must observe
    // the fence before it can publish a fresh service registration after shutdown.
    if (this.staticLifecycle.stopping) return;
    // Register the manager as an ordinary v0.4 `service` endpoint (SPEC §13.7/§13.9)
    // and serve its typed command surface on the ep rails - the ONLY control door, in
    // EVERY mesh mode. Static + user meshes mint the scoped executor + endpoint-serve credential;
    // an open mesh runs the same gate/registration ceremony over bare connections and never mints
    // (there is no credential system - the broker enforces nothing, matching the old open-mesh ctl
    // trust). Fail-loud: a manager that cannot register does not start half-registered.
    console.error("manager startup: binding the service endpoint");
    await this.registerManagerService();
    if (this.staticLifecycle.stopping) return;
    // Stand up the standing goal-writer connection for spawn-as-action — AFTER
    // registration (it writes this endpoint's goal facts/records), disjoint from the serve cred.
    await this.startGoalWriter();
    // Stand up the ONE §13.6 session plane for `attach` — AFTER registration too (it
    // rides the serve grant's epoch + the family-staged session-ledger cred), on its own standing
    // connection disjoint from both the serve and goal-writer creds.
    await this.startSessionPlane();
    // Reconcile any accepted-but-unterminal goals inherited from a predecessor
    // BEFORE spawn-as-action begins accepting (the goalReconcileDone gate) — a fresh incarnation
    // never drops a goal a dead predecessor accepted. Never fatal; the gate opens either way.
    console.error("manager startup: reconciling predecessor goals");
    await this.reconcileGoalIndex();
    // SPEC 14.3: the manager hosts workflow runs. Stood up AFTER registration (it names this
    // instance's coordinates) and reconciled AFTER the goal index, for the same reason: a fresh
    // incarnation takes back every run a dead predecessor was driving before it accepts new ones.
    // The serve surface is already live by here, so the family itself holds the gate: `runHost()`
    // refuses `run-start`/`run-resume` as `unavailable` until the host exists and `RunHosting`
    // refuses them until its reconcile has returned. A remote user-auth manager uses its four
    // registered issuer callbacks instead of holding a signer; a local user mesh stands none up.
    const remoteRuns = this.remoteAuthority?.runHosting;
    if (this.execution !== "none" && this.remoteAuthority && remoteRuns) {
      this.runHosting = new RunHosting({
        space: this.space,
        servers: this.servers,
        endpoint: MANAGER_ENDPOINT,
        instanceId: this.managerInstanceId,
        holder: { id: this.remoteAuthority.identities.supervisor.id, lifecycleUid: this.managerLifecycleUid },
        auth: undefined,
        log: (line) => console.error(line),
        admitRun: remoteRuns.admitRun,
        submitRun: remoteRuns.submitRun,
        revokeRun: remoteRuns.revokeRun,
        cancelRun: remoteRuns.cancelRun,
        issueAttempt: remoteRuns.issueAttempt,
        issueOperator: remoteRuns.issueOperator,
        renewRun: remoteRuns.renewRun,
      });
      await this.runHosting.reconcile();
    } else if (!this.remoteAuthority && !this.userMode) {
      this.runHosting = new RunHosting({
        space: this.space,
        servers: this.servers,
        endpoint: MANAGER_ENDPOINT,
        instanceId: this.managerInstanceId,
        holder: { id: this.ep.ref().id, lifecycleUid: this.managerLifecycleUid },
        auth: this.auth,
        log: (line) => console.error(line),
      });
      await this.runHosting.reconcile();
    }
    // A carried resume (#1499) needs this instance's transfer reader: minted from the space's signing
    // seed, issued by the host to a remote manager, or none on an open mesh.
    if (this.execution !== "none" && (!this.remoteAuthority || this.remoteAuthority.mintTransferReader)) {
      this.transcripts = new TranscriptReceiver({
        space: this.space,
        instanceId: this.managerInstanceId,
        workspaceRoot: this.workspaceRoot,
        withReader: (fn) => this.withTransferReader(fn),
        log: (line) => console.error(line),
      });
      await this.transcripts.start();
    }
    for (const note of this.bootNotes.splice(0)) console.error(note);
    // Plane-3 (durable backstop) is NOT the manager's job — the manager only manages agent lifecycle.
    // The server-side delivery daemon hosts the fan-out writer + trusted reader, owns the durable
    // membership registry, and serves the runtime durable join/leave/list ops (on `ctl.delivery`). The
    // manager records each agent's read ACL at spawn (`commitAcl`, in provisionAgent) so the daemon can
    // re-authorize it; that is the only Plane-3 state the manager touches, and it rides minting.
  }

  /** The delivery shard whose lease names the process that reloads the standing credentials.
   *  Delivery is single-shard today and the endpoint's own responder reads row 0; naming it here
   *  keeps the manager's binding check and that reply arguing about the same row. */
  private static readonly DELIVERY_SHARD = 0;

  /** Proof that this manager remints into the store the delivery daemon reloads from.
   *  Fingerprint-only `reloadCreds` is safe only after this. Two named, different stores
   *  refuse the pass. A daemon that is not bound yet is not a named store: start and
   *  remint still proceed (tests, delayed delivery), writing this manager's store. The
   *  challenge runs again before every remint, so a later daemon on a foreign store is
   *  refused then rather than certified by an earlier absence. A request timeout is not
   *  absence: a hung rail would skip the proof, so it fails closed.
   *
   *  ABSENCE IS READ OFF THE LEASE ROW, never off the rail's no-responder shape alone (#1694).
   *  The rail is queue-grouped, so "no responder answered" is itself something the rail reports,
   *  and a responder that answers in a shape the client turns into that error makes the pass read
   *  "absent" while a holder is live on the row — certifying every later remint with no proof at
   *  all. So a no-responder outcome is decided by the row: a row that names a holder makes the
   *  pass refuse (undetermined — a live daemon went unanswered, which must not read as "no
   *  daemon"), and only a row that is absent or holderless settles "absent", the state start()
   *  treats as not-yet-bound. An unreadable row (a failed read, or a key that exists but does not
   *  parse) is a genuine unknown and refuses fail-closed, like a hung rail. */
  private async daemonStoreRelation(timeoutMs: number): Promise<"shared" | "absent" | "divergent"> {
    let reply: ControlReply;
    try {
      reply = await this.ep.requestDeliveryAdmin("reloadStoreIdentity", {}, timeoutMs);
    } catch (e) {
      const msg = rejectionText(e);
      if (isAbsentDeliveryAdmin(e)) return this.absentByLeaseRow(isUnansweredDeliveryAdmin(e));
      const failure = `could not challenge the delivery daemon's SecretStore: ${msg}`;
      throw isUnansweredDeliveryAdmin(e) ? new DeliveryAdminUnanswered(failure) : new Error(failure);
    }
    if (!reply.ok)
      throw new Error(
        reply.error ?? "delivery daemon refused to name the SecretStore it reloads from",
      );
    let answer: DaemonStoreAnswer;
    try {
      answer = parseDaemonStoreAnswer(reply.data);
    } catch (e) {
      throw new Error(
        `delivery daemon named an unreadable SecretStore: ${rejectionText(e)}. Nothing reminted. ` +
          `Check that delivery and manager use the same Cotal version, then restart delivery through its supervisor. ` +
          `For a saved local delivery service: \`cotal down delivery --space ${this.space}\`, ` +
          `then \`cotal up --space ${this.space}\``,
      );
    }
    // The answerer's own claim first, so an honest non-holder is refused by its own admission and
    // the operator-facing reason names that. This is the CHEAP half of the test and NOT the binding
    // one: a responder that does not hold the lease can assert `true` here just as easily.
    if (!answer.holdsDeliveryLease)
      throw new Error(
        "the delivery-admin rail was answered by a responder that does not hold this space's " +
          "delivery lease, so its SecretStore is not the store the daemon reloads from - nothing reminted",
      );
    // THE BINDING TEST, measured by this manager rather than asserted by the answerer. The lease
    // row's holder is read here under this manager's own credential; the answerer must BE that
    // principal. A reply asserting the claim while some other process holds the shard fails here,
    // which is the case a bare store identity could not see. An unreadable row is an unknown and
    // refuses too: this test may never be satisfied by failing to run.
    const holder = await this.ep.deliveryLeaseHolder(Manager.DELIVERY_SHARD);
    if (holder === undefined)
      throw new Error(
        "this manager could not read the delivery lease row, so it cannot verify that the answering " +
          "responder is the process that reloads the standing credentials - nothing reminted",
      );
    if (holder !== answer.responder)
      throw new Error(
        `the delivery-admin rail was answered by ${answer.responder}, which is not the holder of ` +
          `this space's delivery lease (${holder}), so its SecretStore is not the store the daemon ` +
          `reloads from - nothing reminted`,
      );
    const daemon = answer.identity;
    // The workspace store records its id the first time it is named, so it is named here, where
    // only an auth manager reaches, rather than in a constructor every open-mode manager runs.
    this.secretStoreIdentity ??= parseSecretStoreIdentity(this.secrets.identity);
    if (!sameSecretStoreIdentity(this.secretStoreIdentity, daemon)) {
      console.error(`! ${divergentSecretStoreNotice(this.secretStoreIdentity, daemon)}`);
      return "divergent";
    }
    return "shared";
  }

  /** Settle a no-responder challenge outcome from the lease row, never from the rail's own
   *  reporting shape (#1694). The three cases:
   *
   *  1. The row READS but names a holder: a live daemon holds the shard and the rail went
   *     unanswered. That is undetermined, not "no daemon" — treating it as absent would let this
   *     manager remint with no proof while a reloading daemon runs, which is exactly what the
   *     challenge exists to prevent. Refuse.
   *  2. The row is unreadable — a read that fails (a denied or erroring bucket) OR a key that
   *     exists but does not parse as a lease record (`readDeliveryLeaseEntry` throws for both):
   *     undetermined, and it refuses the same fail-closed way a hung rail does. Never a silent
   *     "absent" over a row the manager could not read.
   *  3. The row is absent or holderless (no key, a DEL/PURGE tombstone, or a row that names no
   *     holder): today's "absent", the state start() treats as a daemon that is not bound yet.
   *
   *  `deliveryLeaseHolder` swallows its read failures into `undefined`, which would fold case 2
   *  into case 3 — so this reads the entry directly and lets the read's own failure refuse. */
  private async absentByLeaseRow(unanswered: boolean): Promise<"absent"> {
    let entry: { info: DeliveryLeaseInfo } | undefined;
    try {
      entry = await this.ep.readDeliveryLeaseEntry(Manager.DELIVERY_SHARD);
    } catch (e) {
      throw new Error(
        `could not read the delivery lease row to settle whether the delivery daemon is absent ` +
          `(${rejectionText(e)}) - absence is undetermined, nothing reminted`,
      );
    }
    const holder = entry?.info.holder;
    if (holder !== undefined && holder !== "") {
      const refusal =
        `the delivery-admin rail reported no responder while the delivery lease names a holder ` +
        `(${holder}) - absence cannot be read off the rail alone, and nothing reminted`;
      throw unanswered ? new DeliveryAdminUnanswered(refusal) : new Error(refusal);
    }
    return "absent";
  }

  /** Keep this manager's renewal lease alive between credential passes (#1634). The manager bucket
   *  expires keys at MANAGER_LEASE_TTL_MS, far below the credential pass's cadence, so the lease
   *  needs its own heartbeat like the per-instance liveness lease. A non-owner calls this too: the
   *  CAS is how a survivor picks up a dead owner's expired lease with no operator step. Never
   *  throws; a failed heartbeat leaves ownership to the next pass rather than ending the process. */
  private async keepDaemonRenewalLease(): Promise<void> {
    if (!this.auth || !this.daemonRenewalEligible) return;
    try {
      const held = await this.ep.holdDaemonRenewalLease(this.managerInstanceId);
      if (this.daemonRenewalOwner && !held)
        console.error(`! daemon credential renewal for space "${this.space}" passed to another manager (this one lost the renewal lease) - it keeps serving its seats`);
      this.daemonRenewalOwner = held;
    } catch (e) {
      console.error(`! could not refresh the daemon renewal lease: ${rejectionText(e)} - ownership is re-decided on the next pass`);
    }
  }

  /** Decide whether THIS manager owns the daemon's credential renewal (#1634). Both conditions are
   *  required, because each answers a question the other cannot:
   *
   *  1. The daemon must reload from this manager's store (#1447). Reminting into a store the daemon
   *     never reads writes bytes nobody adopts, and fingerprint-only `reloadCreds` would then name a
   *     generation the daemon cannot see.
   *  2. This manager must hold the per-space renewal lease. Store identity CANNOT pick one owner on
   *     its own: `sameSecretStoreIdentity` is pure equality with no holder and no tiebreak, so every
   *     manager sharing one store passes it, and two owners reminting on independent timers have no
   *     ordering between them - one's write lands between the other's re-sign and its adoption
   *     request, which is the #773 refusal the challenge exists to prevent.
   *
   *  A manager failing either test serves the space normally and skips only the daemon remint. */
  private async claimDaemonRenewalOwnership(waitMs = 0): Promise<void> {
    // EVERY refusal outcome drops a held lease, not only "divergent". The refusal paths THROW
    // (#1694: a non-holder answer, an unbindable answerer, an unreadable or holder-naming row on a
    // no-responder rail), and a thrown refusal caught by renewDaemonCreds would otherwise leave a
    // manager that once owned the renewal still holding the lease behind its own heartbeat — the
    // pass refuses, the log says so, and the space keeps a renewal owner that must not remint.
    // Deciding here, inside the claim, is what keeps the release on the refusal path itself.
    let relation: "shared" | "absent" | "divergent";
    try {
      // Only the read-only challenge is retried, so a wait that ends mid-attempt abandons a read,
      // never the lease work below.
      relation = await untilDeliveryAdminAnswers(
        waitMs,
        (requestMs) => this.daemonStoreRelation(requestMs(STORE_CHALLENGE_TIMEOUT_MS)),
        (reason, delayMs) => console.error(`! delivery-admin rail did not answer the store challenge (${reason}); retrying in ${delayMs / 1000}s`),
        (e) => e instanceof DeliveryAdminUnanswered,
      );
    } catch (e) {
      this.daemonRenewalEligible = false;
      if (this.daemonRenewalOwner) await this.ep.releaseDaemonRenewalLease().catch(() => {});
      this.daemonRenewalOwner = false;
      throw e;
    }
    this.daemonRenewalEligible = relation !== "divergent";
    if (relation === "divergent") {
      // Not our daemon's store: drop any lease we hold rather than sit on it, so the manager that
      // CAN remint is not blocked behind us.
      if (this.daemonRenewalOwner) await this.ep.releaseDaemonRenewalLease();
      this.daemonRenewalOwner = false;
      return;
    }
    await this.keepDaemonRenewalLease();
  }

  /** #2073: arm the `endpoint-serve` credential's own renewal from its `[renewAt, exp)` window
   *  instead of `credRenewTimer`'s boot-phased TTL/4 tick, which can miss that window depending on
   *  when the timer happened to start relative to the credential's `iat`. Called after the initial
   *  mint (`registerManagerService`) and after every successful re-mint in the serve branch below,
   *  so the schedule always tracks the CURRENT credential. `credsRenewalDelayMs` is the same 75%
   *  convention the endpoint's delivery renewal and the membership feed use (`@cotal-ai/core`); no
   *  second copy of that arithmetic lives here. */
  private scheduleServeRenewal(creds: string): void {
    if (this.endpointServeRenewalTimer) clearTimeout(this.endpointServeRenewalTimer);
    const delay = Math.max(1_000, credsRenewalDelayMs(creds));
    const renewAt = new Date(Date.now() + delay).toISOString();
    this.endpointServeRenewalTimer = setTimeout(() => { void this.renewDaemonCreds(); }, delay);
    this.endpointServeRenewalTimer.unref?.();
    console.error(`manager endpoint-serve renewal scheduled at ${renewAt}`);
  }

  private credentialPushRetry?: ReturnType<typeof setTimeout>;
  private readonly credentialPushes = new Map<NatsConnection, Promise<void>>();
  private supervisorCredentialPush?: Promise<void>;
  private readonly pendingCredentialPushes = new Set<NatsConnection>();
  private supervisorCredentialPushPending = false;

  private scheduleCredentialPushRetry(): void {
    if (this.credentialPushRetry || this.leaseStopping) return;
    this.credentialPushRetry = setTimeout(() => {
      this.credentialPushRetry = undefined;
      if (this.leaseStopping) return;
      void Promise.all([
        ...[...this.pendingCredentialPushes].map((nc) => this.pushRenewedCreds(nc)),
        ...(this.supervisorCredentialPushPending ? [this.pushSupervisorCreds()] : []),
      ]);
    }, 1_000);
    this.credentialPushRetry.unref();
  }

  /** Retain a busy transport and retry its adopted credential without replaying requests. */
  private pushRenewedCreds(nc: NatsConnection): Promise<void> {
    const active = this.credentialPushes.get(nc);
    if (active) return active;
    const push = this.pushRenewedCredsOnce(nc).finally(() => { this.credentialPushes.delete(nc); });
    this.credentialPushes.set(nc, push);
    return push;
  }

  private async pushRenewedCredsOnce(nc: NatsConnection): Promise<void> {
    this.pendingCredentialPushes.add(nc);
    try {
      await requestSafeReconnect(nc);
      this.pendingCredentialPushes.delete(nc);
    } catch (e) {
      if (nc.isClosed()) this.pendingCredentialPushes.delete(nc);
      console.error(`! manager credential push deferred: ${rejectionText(e)}`);
      if (!nc.isClosed()) this.scheduleCredentialPushRetry();
    }
  }

  private pushSupervisorCreds(): Promise<void> {
    if (this.supervisorCredentialPush) return this.supervisorCredentialPush;
    const push = this.pushSupervisorCredsOnce().finally(() => { this.supervisorCredentialPush = undefined; });
    this.supervisorCredentialPush = push;
    return push;
  }

  private async pushSupervisorCredsOnce(): Promise<void> {
    this.supervisorCredentialPushPending = true;
    try {
      await this.ep.refreshCredsRequestSafe();
      this.supervisorCredentialPushPending = false;
    } catch (e) {
      console.error(`! remote manager supervisor credential push deferred: ${rejectionText(e)}`);
      this.scheduleCredentialPushRetry();
    }
  }

  /** #2073: the shared bounded-retry shape for a closed standing connection: wait out each of
   *  {@link STATIC_RECONCILE_RETRY_DELAYS_MS}, trying `attempt` after each. Waiting does not repair
   *  two closes, so they skip the first delay. One that closes while an all-duty renewal is in flight,
   *  as one the broker expires just before adoption, tries when that renewal adopts. One whose
   *  credential has `expired` tries at once, because its attempt renews the credential. A stop landing
   *  while this loop waits is not a fault this loop reports (the caller re-checks `leaseStopping`). */
  private async boundedReconnect(label: string, attempt: () => Promise<boolean>, expired = false): Promise<boolean> {
    let first = this.remoteBundleAdoption ?? (expired ? Promise.resolve() : undefined);
    for (const delayMs of STATIC_RECONCILE_RETRY_DELAYS_MS) {
      await (first ?? new Promise((r) => setTimeout(r, delayMs)));
      first = undefined;
      if (this.leaseStopping) return true;
      try {
        if (await attempt()) return true;
      } catch (e) {
        console.error(`! manager ${label} re-dial attempt failed: ${rejectionText(e)}`);
      }
    }
    return false;
  }

  /** One class-2 renewal pass: re-sign `.cotal/delivery.creds` + `.cotal/membership-rw.creds`
   *  for their existing nkeys, then request the delivery daemon's EXPLICIT `reloadCreds` adoption on the
   *  delivery-admin rail and persist the audit record (`.cotal/renewal.<spaceKey>.json`) that `cotal doctor auth`
   *  renders — so "file re-signed" and "daemon adopted" are distinguishable states. A missing daemon
   *  (no responder) is recorded honestly: each daemon's own 75% renewal timer remains the adoption backstop.
   *  Never throws — renewal failure must be LOUD (log + record), not fatal to the supervisor. */
  private async renewDaemonCreds(): Promise<void> {
    const release = this.beginLifecycle();
    if (!release) return;
    try {
      // #1634: re-decide every pass, so a daemon that moved onto this manager's store becomes
      // ownable, one that moved off retires this manager's ownership, and a crashed owner's expired
      // lease is taken over by a survivor.
      await this.claimDaemonRenewalOwnership();
      // Re-sign through the manager's ONE store — the SAME store the delivery daemon reads
      // (`runDelivery(args, store)`), so a hosted remint writes the store the daemon renews from,
      // never a divergent one. Locally this is the workstation FS store (`.cotal/*.creds`).
      // `this.space` gates cross-space signer swaps; the `preflight` proves broker acceptance before
      // overwriting from ANY signer form (full or stripped). A same-label alternate full bundle is
      // self-bound, not broker-bound, so the manager-hosted path proves every re-sign before it could
      // clobber the last-good with a broker-dead cred; a wrong-account signer's cred is refused here.
      const results = this.daemonRenewalOwner
        ? await remintDaemonCreds(this.workspaceRoot, this.space, this.secrets, {
            preflight: (creds) => this.probeStaticCredential(creds).then((r) => r.ok),
          })
        : [];
      const resigned = results.filter((r) => r.ok);
      let adoption: RenewalRecord["adoption"];
      if (resigned.length) {
        // Hand the daemon the EXPECTED generation per component (SHA-256 of the JWT we just
        // re-signed) so its reply proves it adopted THIS generation, not merely re-read some file.
        const expected: { delivery?: string; membership?: string } = {};
        for (const r of resigned) {
          if (r.file === DELIVERY_CREDS_KIND && r.fingerprint) expected.delivery = r.fingerprint;
          else if (r.file === MEMBERSHIP_RW_CREDS_KIND && r.fingerprint) expected.membership = r.fingerprint;
        }
        try {
          const reply = await this.ep.requestDeliveryAdmin("reloadCreds", { expected }, DELIVERY_ADMIN_RELOAD_TIMEOUT_MS);
          // Keep the per-component aggregate on BOTH outcomes: on a top-level failure `reply.data`
          // still carries which component adopted and which was refused, which `doctor auth` renders.
          adoption = reply.ok
            ? { ok: true, detail: reply.data }
            : { ok: false, error: reply.error, detail: reply.data };
        } catch (e) {
          adoption = { ok: false, error: `no delivery-admin responder (${rejectionText(e)}) - the daemon's 75% re-read backstop adopts the re-signed file` };
        }
      }
      for (const r of results.filter((x) => !x.ok && !x.skipped))
        console.error(`! credential renewal: could not re-sign ${r.file}: ${r.error} - the daemon dies loud at this cred's expiry unless it is reminted`);
      if (adoption && !adoption.ok) console.error(`! credential renewal: daemon adoption failed: ${adoption.error}`);
      // `writeRenewalRecord` redacts the ephemeral fingerprint at the persistence boundary (covering
      // the `doctor auth --fix` writer too), so the results pass straight through.
      // A non-owner (#1634) re-signed nothing, so it writes no record: an empty one renders in
      // `doctor auth` as a pass that never ran.
      if (this.daemonRenewalOwner)
        writeRenewalRecord(this.workspaceRoot, this.space, { ts: new Date().toISOString(), owner: "manager", results, adoption });
      this.warnOnSystemCredExpiry();
      // The MANAGER is the renewal owner for its managed-static agent creds —
      // supervisor-side PUSH remint for recorded LIVE slots (the child JWT is never proof of
      // incarnation; a copied credential cannot drive this and is stranded at its own row's TTL).
      // Same class-2 mechanics as the daemon creds: re-sign the file for the SAME nkey; the
      // agent endpoint's 75% source re-read adopts it.
      //
      // Each credential is judged as of the NEXT pass, so one whose renewal point falls before it
      // is re-signed now, ahead of the endpoint's re-read. Judged as of now, a credential whose
      // renewal point lands just after a pass waited a whole interval: the endpoint warned every
      // minute that the file still held the old generation, and when the next pass came in the
      // credential's last minute, the endpoint's one-minute retry could miss it and the connection
      // expired.
      const nextPassSec = Math.floor(Date.now() / 1000) + Math.ceil(credRenewIntervalMs(STANDING_RENEWABLE_TTL_SEC) / 1000);
      if (!this.userMode) {
        for (const a of [...this.agents.values()]) {
          // The `terminalizing` test here is an OPTIMISATION, NOT THE GUARD. There are awaits below
          // it, so an agent can latch mid-iteration and this filter will have already let it
          // through — what actually refuses is the same test at the top of
          // {@link renewManagedStaticCred}, which every renewal on this path goes through.
          // COUPLING: deleting or weakening that check silently promotes this line from an
          // optimisation into the whole guard, and nothing fails at the moment of the change.
          if (a.userOwner || a.terminalizing || !a.seed || !a.secretPaths?.creds) continue;
          try {
            const stored = await this.secrets.get(agentSecretKeyForFile(a.secretPaths.creds, this.space));
            if (stored === undefined) continue; // no materialized cred (never minted here) - nothing to renew
            const health = inspectCredHealth(stored, nextPassSec);
            if (health.state === "healthy") continue;
            if (health.state === "unbounded" || health.state === "unreadable") {
              console.error(`! managed cred renewal ${a.name}: credential is ${health.state}${health.error ? ` (${health.error})` : ""} - not renewed (a pre-TTL credential stays as minted until respawn)`);
              continue;
            }
            await this.renewManagedStaticCred(a);
          } catch (e) {
            console.error(`! managed cred renewal ${a.name}: ${rejectionText(e)} - the agent dies loud at this cred's expiry unless it is reminted`);
          }
        }
      }
      // The manager is the `endpoint-serve` renewal owner for its own
      // service credential: re-mint the same serve identity with a fresh bounded exp through the
      // §13.1 mint fence over a scoped one-shot executor (staging a new ledger row in a later
      // second or idempotently re-staging the active row within the same second, and releasing only
      // on winning the gate CAS; never the standing connection). The serve connection's
      // authenticator presents the refreshed credential on its next (re)connect.
      if (this.serviceServe?.creds && this.auth) {
        const s = this.serviceServe;
        const authRef = this.auth;
        try {
          const health = inspectCredHealth(this.serviceServe.creds);
          if (health.state !== "healthy") {
            s.creds = await this.withEndpointServeExecutor(({ authKv }) =>
              mintCreds(authRef, s.identity, "endpoint-serve", {
                serveIssuance: serveIssuanceGateKv(authKv, this.space, { endpoint: MANAGER_ENDPOINT, instanceId: this.managerInstanceId }),
                endpointServe: s.grant,
              }));
            // #2073: a superseded instance's re-mint fails the gate CAS above and lands in the
            // catch below, not here — this re-mint already re-checks the issuance gate through
            // the SAME executor a fresh registration would use, so there is no second epoch read
            // to add before re-binding after a re-dial.
            await this.pushRenewedCreds(s.nc);
            this.scheduleServeRenewal(s.creds);
          }
        } catch (e) {
          console.error(`! endpoint-serve renewal: ${rejectionText(e)} - the manager's service endpoint dies loud at this cred's expiry unless it is re-registered`);
        }
      }
      // The manager is also the goal-writer's renewal owner — re-mint the SAME
      // goal-writer nkey with a fresh bounded exp AND re-stage its new credId into the §13.1 family,
      // through the scoped executor (never the standing seed). Without this the standing goal-writer
      // connection dies at its TTL and spawn-as-action stops accepting until a restart. The
      // connection's authenticator presents the refreshed credential on its next (re)connect.
      if (this.goalWriter && this.goalWriterCreds && this.auth) {
        const gw = this.goalWriter;
        try {
          if (inspectCredHealth(this.goalWriterCreds).state !== "healthy") {
            const fresh = await this.withEndpointServeExecutor(({ authKv }) => this.mintAndStageGoalWriter(authKv));
            this.goalWriterCreds = fresh;
            gw.creds = fresh;
            await this.pushRenewedCreds(gw.nc);
          }
        } catch (e) {
          console.error(`! goal-writer renewal: ${rejectionText(e)} - spawn-as-action stops accepting at this cred's expiry unless the manager restarts`);
        }
      }
      // The manager is also the session-ledger's renewal owner — re-mint the SAME nkey
      // with a fresh bounded exp AND re-stage its new credId into the §13.1 family, through the
      // scoped executor. Without this the standing session-ledger connection dies at its TTL and
      // `attach` stops establishing sessions until a restart. The connection's authenticator presents
      // the refreshed credential on its next (re)connect.
      // SPEC 14.6: every hosted drive's per-run `run-driver` credential is the manager's to renew
      // for the same nkey; a run parked in a pause for days must not die at the credential's TTL.
      await this.runHosting?.renew();
      if (this.sessionLedgerConn && this.sessionLedgerCreds && this.auth) {
        const sw = this.sessionLedgerConn;
        try {
          if (inspectCredHealth(this.sessionLedgerCreds).state !== "healthy") {
            const fresh = await this.withEndpointServeExecutor(({ authKv }) => this.mintAndStageSessionLedger(authKv));
            this.sessionLedgerCreds = fresh;
            sw.creds = fresh;
            await this.pushRenewedCreds(sw.nc);
          }
        } catch (e) {
          console.error(`! session-ledger renewal: ${rejectionText(e)} - attach stops establishing sessions at this cred's expiry unless the manager restarts`);
        }
      }
    } catch (e) {
      console.error(`! credential renewal pass failed: ${rejectionText(e)}`);
    } finally {
      release();
    }
  }

  /** Renew the remote registration executor through the typed host protocol. A healthy credential
   * is retained; near-expiry and expired credentials are replaced for the same nkey. */
  private async renewRemoteExecutor(force = false): Promise<void> {
    if (!this.remoteAuthority) return;
    const current = this.remoteExecutorCreds;
    if (!force && current && inspectCredHealth(current).state === "healthy") return;
    try {
      this.remoteExecutorCreds = await this.remoteAuthority.renewExecutor();
    } catch (e) {
      console.error(`! remote manager executor renewal: ${rejectionText(e)} - registration maintenance and clean deregistration remain unavailable until renewal succeeds`);
      if (force) throw e;
    }
  }

  /** An active signerless manager renews its standing duties together. The issuer stages the closed
   * credential family first; broker preflight proves every JWT and existing caller-held nkey
   * before any mutable holder changes. A failed candidate leaves all current creds intact. */
  private async renewRemoteStandingBundle(force = false): Promise<void> {
    if (this.remoteBundleRenewal) return this.remoteBundleRenewal;
    if (this.leaseStopping) return;
    this.remoteBundleAdoption = new Promise<void>((resolve) => { this.finishRemoteBundleAdoption = resolve; });
    const renewal = this.renewRemoteStandingBundleOnce(force, performance.now() + REMOTE_STANDING_BUDGET_MS);
    this.remoteBundleRenewal = renewal;
    try { await renewal; } finally {
      this.finishRemoteBundleAdoption?.();
      if (this.remoteBundleRenewal === renewal) {
        this.remoteBundleRenewal = undefined;
        this.remoteBundleAdoption = undefined;
        this.finishRemoteBundleAdoption = undefined;
      }
    }
  }

  /** A signerless manager's closed standing connection re-dials through the all-duty family only.
   *  A healthy holder re-dials as is. An unhealthy one waits for the closed renewal and adoption,
   *  and a refusal fails this attempt with last-good and debt kept. Nothing is minted locally. */
  private async renewRemoteBeforeRedial(label: string, read: () => string | undefined): Promise<void> {
    if (inspectCredHealth(read() ?? "").state === "healthy") return;
    await this.renewRemoteStandingBundle(true);
    if (inspectCredHealth(read() ?? "").state !== "healthy")
      throw new Error(`the ${label} credential is not healthy after all-duty renewal; last-good is kept and nothing is minted locally`);
  }

  private async renewRemoteStandingBundleOnce(force: boolean, deadline: number): Promise<void> {
    const remote = this.remoteAuthority;
    if (!remote?.renewStandingBundle || !this.serviceServe) return;
    const current = [this.remoteSupervisorCreds, this.remoteExecutorCreds, this.serviceServe.creds,
      this.goalWriterCreds, this.sessionLedgerCreds];
    if (!force && current.every((cred) => cred && inspectCredHealth(cred).state === "healthy")) {
      await Promise.all([
        ...[...this.pendingCredentialPushes].map((nc) => this.pushRenewedCreds(nc)),
        ...(this.supervisorCredentialPushPending ? [this.pushSupervisorCreds()] : []),
      ]);
      return;
    }
    const processEpoch = this.serviceServe.grant.epoch;
    let candidate: Awaited<ReturnType<NonNullable<typeof remote.renewStandingBundle>>> | undefined;
    const serving = this.serviceServe;
    const previous = { nc: serving.nc, handle: serving.handle };
    let replacement: { nc: NatsConnection; handle: EpServeHandle } | undefined;
    let adopted = false;
    try {
      // Only this continuation can adopt. A host operation may still issue after this wait times
      // out, but its late result cannot re-enter preflight or change any Manager holder.
      candidate = await withTimeout(remote.renewStandingBundle(processEpoch), remoteStandingTimeLeft(deadline),
        "remote manager standing authority exceeded its 10000ms aggregate budget; issuance outcome is unknown");
      if (Object.keys(candidate).sort().join(",") !== [...REMOTE_MANAGER_IDENTITY_NAMES].sort().join(","))
        throw new Error("host returned an incomplete or widened standing credential family");
      for (const name of REMOTE_MANAGER_IDENTITY_NAMES) {
        if (typeof candidate[name] !== "string" || inspectCredHealth(candidate[name]).state === "unreadable")
          throw new Error(`host returned an unreadable ${name} credential`);
        if (!remote.accountPublicKey || accountFromCreds(candidate[name]) !== remote.accountPublicKey)
          throw new Error(`host returned a ${name} credential for another account`);
        if (credsClaims(candidate[name]).sub !== remote.identities[name].id)
          throw new Error(`host returned a ${name} credential for a different nkey than the held identity`);
        const staged = candidate[name];
        const nc = await this.dialRemoteStanding({ authenticator: (nonce?: string) => credsAuthenticator(new TextEncoder().encode(staged))(nonce), maxReconnectAttempts: 0 }, deadline);
        await nc.close();
      }
      remoteStandingTimeLeft(deadline);
      if (this.leaseStopping || this.serviceServe !== serving || serving.nc !== previous.nc || serving.grant.epoch !== processEpoch)
        throw new Error("manager changed its active serve epoch or connection while standing renewal was in flight");
      const stagedServeCreds = candidate.serve;
      replacement = await this.dialServeConnection({ ...serving, creds: stagedServeCreds },
        () => adopted ? serving.creds! : stagedServeCreds, deadline);
      remoteStandingTimeLeft(deadline);
      if (this.leaseStopping || this.serviceServe !== serving || serving.nc !== previous.nc || serving.grant.epoch !== processEpoch)
        throw new Error("manager changed its active serve epoch or connection while standing renewal was in flight");
      if (REMOTE_MANAGER_IDENTITY_NAMES.some((name) => inspectCredHealth(candidate![name]).state !== "healthy"))
        throw new Error("standing candidate is no longer healthy after broker preflight");
      serving.nc = replacement.nc;
      serving.handle = replacement.handle;
      replacement = undefined;
      this.remoteSupervisorCreds = candidate.supervisor;
      this.remoteExecutorCreds = candidate.executor;
      this.serviceServe.creds = candidate.serve;
      adopted = true;
      this.goalWriterCreds = candidate.goalWriter;
      this.sessionLedgerCreds = candidate.sessionLedger;
      if (this.goalWriter) this.goalWriter.creds = candidate.goalWriter;
      if (this.sessionLedgerConn) this.sessionLedgerConn.creds = candidate.sessionLedger;
      // Adoption is committed above; a connection that cannot come back yet is a push failure the
      // endpoint's own reconnect loop retries with the adopted credential, not unadopted debt.
      this.remoteRenewalDebt = undefined;
      // Maintenance needed by admitted handlers must not wait for those same handlers to drain.
      this.finishRemoteBundleAdoption?.();
      await withTimeout(Promise.all([
        this.pushSupervisorCreds(),
        (async () => {
          try {
            // A handler or a lost broker PONG can keep stop/flush pending forever. Only the
            // retired transport is expendable: never retry its requests or close the replacement.
            await withTimeout((async () => {
              await previous.handle.stop();
              await previous.nc.flush();
            })(), 5_000, "old serve drain unfinished after 5000ms; closing retired transport, in-flight request outcomes are unknown and must not be retried");
          } finally {
            await previous.nc.close();
          }
        })().catch((e) => console.error(`! remote manager retired serve drainage after renewal: ${rejectionText(e)}`)),
        ...(this.goalWriter ? [this.pushRenewedCreds(this.goalWriter.nc)] : []),
        ...(this.sessionLedgerConn ? [this.pushRenewedCreds(this.sessionLedgerConn.nc)] : []),
      ]), remoteStandingTimeLeft(deadline), "remote manager standing reconnect exceeded its 10000ms aggregate budget; adopted transports keep their native reconnect ownership");
    } catch (e) {
      if (replacement) {
        await this.discardServeCandidate(replacement.nc, replacement.handle);
      }
      if (adopted) {
        console.error(`! remote manager adopted standing family: ${rejectionText(e)}`);
        return;
      }
      const unadoptedSubjects = candidate && typeof candidate === "object"
        ? Object.values(candidate).flatMap((cred) => { try { return typeof cred === "string" && credsClaims(cred).sub ? [credsClaims(cred).sub!] : []; } catch { return []; } })
        : REMOTE_MANAGER_IDENTITY_NAMES.map((name) => remote.identities[name].id);
      this.remoteRenewalDebt = { at: Date.now(), processEpoch, reason: rejectionText(e), unadoptedSubjects };
      console.error(`! remote manager all-duty renewal: ${this.remoteRenewalDebt.reason} - no unsigned or local replacement is available`);
      if (force) throw e;
    }
  }

  /** Warn, on every renewal pass, when a $SYS credential is at or past its renewal point.
   *
   *  The manager is the renewal owner for every credential it CAN re-sign, and these two are the ones
   *  it cannot: they are `rotation-renewed`, so no resident process re-mints them and they simply die
   *  on their 30-day horizon. Before this, a mesh that never ran `doctor auth` got no signal at all,
   *  it discovered the expiry as an "Authorization Violation" in the delivery log and a refused
   *  membership adoption, weeks after the warning would have been actionable (#338). The pass runs
   *  every half-TTL of the 24h class, so this repeats about twice a day for the ~7 days between the
   *  renewal point and expiry: loud enough to be seen, bounded enough not to be noise.
   *
   *  Diagnostic only, and deliberately non-fatal: renewal is an operator action (`cotal down` then
   *  `cotal up --rotate-sys`, which needs a broker restart), so the manager must report it, never
   *  attempt it. An absent file is the unprovisioned space, reported by the daemon that needs it. */
  private warnOnSystemCredExpiry(): void {
    for (const file of SYSTEM_CREDS_FILES) {
      let health: CredHealth;
      try {
        // The pair is PER-SPACE, so the location comes from the resolver and never from a
        // path built here (§2 rule 1). Building `.cotal/<kind>` instead would not warn on a wrong
        // file — it would silently warn on NOTHING, for every provisioned root, forever, which is
        // exactly the signal #338 added this for. The resolver may also refuse (§2 rules 3, 4); that
        // refusal is caught with the unreadable case for the reason on the tin — the daemon that
        // NEEDS the pair resolves it through the same function and reports it loudly there, so a
        // diagnostic pass has nothing to add by crashing renewal.
        const path = join(this.workspaceRoot, ".cotal", spaceMaterialKey(file, this.space, { injected: false, root: this.workspaceRoot }));
        if (!existsSync(path)) continue;
        health = inspectCredHealth(readFileSync(path, "utf8"));
      } catch {
        continue; // an unreadable $SYS file is the daemon's loud failure, not a renewal-pass crash
      }
      const when = health.exp ? new Date(health.exp * 1000).toISOString() : "an unknown date";
      if (health.state === "expired")
        console.error(
          `! $SYS credential ${file} EXPIRED ${when} - the broker denies it, and NOTHING renews it in place (it is rotation-renewed). Live eviction and the membership feed stay down until: \`cotal down\` then \`cotal up --rotate-sys\` (agents, creds and data survive)`,
        );
      else if (health.state === "near-expiry")
        console.error(
          `! $SYS credential ${file} expires ${when} and nothing renews it in place (it is rotation-renewed) - schedule: \`cotal down\` then \`cotal up --rotate-sys\` (agents, creds and data survive)`,
        );
    }
  }

  /** Admit one lifecycle/control operation while active. The synchronous increment is the fence:
   * preserveState and stop close it before their first await, so work is either counted or rejected. */
  private beginLifecycle(resumeOperation = false): (() => void) | undefined {
    if (this.leaseStopping || this.maintenanceState !== "active" || (this.resumeRequired && !resumeOperation)) return undefined;
    this.lifecycleInFlight++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseLifecycle();
    };
  }

  private releaseLifecycle(): void {
    this.lifecycleInFlight--;
    if (this.lifecycleInFlight !== 0) return;
    const waiters = this.lifecycleDrainWaiters;
    this.lifecycleDrainWaiters = [];
    for (const wake of waiters) wake();
  }
  private trackDeprovision(a: TeardownTarget, context = ""): void { this.retirement.trackDeprovision(a, context); }

  private async awaitLifecycleDrain(): Promise<void> {
    if (this.lifecycleInFlight === 0) return;
    await new Promise<void>((resolve) => this.lifecycleDrainWaiters.push(resolve));
  }

  private maintenanceError(): string {
    if (this.leaseStopping) return "manager is stopping; new lifecycle/control work is fenced";
    if (this.resumeRequired) return `manager is waiting for resume attempt ${this.resumeAttemptId}; ordinary lifecycle/control work is fenced`;
    return `manager is in ${this.maintenanceState} mode; new lifecycle/control work is fenced`;
  }

  /** Fence and build the inventory without stopping a child. The coordinator must durably persist
   * this exact plan before calling commitPreservation with the same attempt id. */
  preparePreservation(attemptId: string): Promise<ManagerPreservationPlan> {
    if (this.execution === "none") return Promise.reject(new EpEnvelopeError("unimplemented", this.executionRefusal()));
    if (!attemptId.trim()) return Promise.reject(new Error("preservation attemptId is required"));
    if (this.preservationAttemptId && this.preservationAttemptId !== attemptId)
      return Promise.reject(new Error(`manager is fenced for preservation attempt ${this.preservationAttemptId}; refusing different attempt ${attemptId}`));
    if (this.maintenanceState === "preserved" && this.preservationInventory)
      return Promise.resolve({ ok: true, attemptId, state: "preserved", inventory: this.preservationInventory, failures: [] });
    if (this.preparationTask) return this.preparationTask;
    if (this.maintenanceState === "active") {
      // The fence lands before any await. Accepted work has already incremented lifecycleInFlight.
      this.maintenanceState = "preserving";
      this.preservationAttemptId = attemptId;
      this.preservationGeneration++;
      if (this.credRenewTimer) {
        clearInterval(this.credRenewTimer);
        this.credRenewTimer = undefined;
      }
    }
    const generation = this.preservationGeneration;
    const task = this.runPreparation(attemptId, generation);
    let wrapped!: Promise<ManagerPreservationPlan>;
    wrapped = task.finally(() => {
      if (this.preservationGeneration === generation && this.preparationTask === wrapped)
        this.preparationTask = undefined;
    });
    this.preparationTask = wrapped;
    return wrapped;
  }

  private assertPreservationGeneration(attemptId: string, generation: number): void {
    if (this.preservationAttemptId !== attemptId || this.preservationGeneration !== generation)
      throw new Error(`preservation attempt ${attemptId} was abandoned before preparation completed`);
  }

  private async runPreparation(attemptId: string, generation: number): Promise<ManagerPreservationPlan> {
    await this.awaitLifecycleDrain();
    this.assertPreservationGeneration(attemptId, generation);
    // Read the chat frontier BEFORE any child stops (issue #545): a message posted between this
    // read and the child's stop is delivered live now and again as `historical` on resume, a
    // duplicate bounded to the cut window that the seat's own id dedup on `durable` channels
    // absorbs, whereas a read taken after the stops would instead skip messages the seat never
    // actually saw.
    const backfillFloor = await this.chatFrontierForPreservation();
    const inventory = this.preservationInventory ?? {
      version: "cotal-manager-resume/v2",
      space: this.space,
      createdAt: new Date().toISOString(),
      agents: [...this.agents.values()].map((a) => this.resumeEntry(a, backfillFloor)),
    } satisfies ManagerResumeInventory;
    const failures: ManagerPreserveFailure[] = [];
    for (const entry of inventory.agents) {
      const error = this.inventoryReferenceError(entry);
      if (error) failures.push({
        name: entry.name,
        id: entry.identity.mode === "user" ? principalKey(entry.identity.owner, entry.identity.actor).key : entry.identity.id,
        error,
      });
    }
    // A later manager does not resume a delegated seat, and its close runs only inside its
    // retirement, so a cut that holds one is refused before any child stops. A carried resume seat's
    // private home is removed when its slot is freed, so a later manager would find nothing to fork.
    for (const a of this.agents.values()) {
      if (a.handedOff) failures.push({ name: a.name, id: a.id, error: "a delegated seat is not resumed by a later manager; stop it before preserving" });
      if (a.seatHome) failures.push({ name: a.name, id: a.id, error: "a carried resume seat's private home is not kept for a later manager; stop it before preserving" });
      if (a.once) failures.push({ name: a.name, id: a.id, error: "a once seat runs its one task in this process, and a later manager would start it again; let its task end or stop it before preserving" });
    }
    const unverifiedStops = this.unverifiedStops.filter((stopped) => {
      try {
        if (!stopped.authoritative && stopped.handle.status() === "exited") return false;
      } catch { /* fail closed below */ }
      failures.push({
        name: stopped.name,
        id: stopped.id,
        error: stopped.error ?? `an earlier stop on runtime "${stopped.handle.kind}" cannot prove the child is gone`,
      });
      return true;
    });
    this.assertPreservationGeneration(attemptId, generation);
    // The prepared inventory must round-trip through the EXACT resume control parser (schema and
    // byte cap) NOW, before any child stops: a cut that cannot resume must fail at prepare time,
    // never after listener exposure.
    try {
      parseResumeControlArgs({ attemptId, inventory });
    } catch (e) {
      failures.push({ name: "<inventory>", id: attemptId, error: `prepared inventory would be rejected at resume: ${rejectionText(e)}` });
    }
    this.preservationInventory = inventory;
    this.preservationFailures = failures;
    this.unverifiedStops = unverifiedStops;
    return {
      ok: failures.length === 0,
      attemptId,
      state: "prepared",
      inventory,
      failures: [...failures],
    };
  }

  /** Stop children only after the coordinator has persisted the prepared inventory. Same-attempt
   * retries are idempotent; a different attempt is refused. */
  commitPreservation(attemptId: string): Promise<ManagerPreserveResult> {
    if (this.execution === "none") return Promise.reject(new EpEnvelopeError("unimplemented", this.executionRefusal()));
    if (!this.preservationAttemptId || this.preservationAttemptId !== attemptId)
      return Promise.reject(new Error(`preservation attempt ${attemptId} was not prepared by this manager`));
    if (!this.preservationInventory)
      return Promise.reject(new Error(`preservation attempt ${attemptId} has no prepared inventory`));
    if (this.preservationFailures.length)
      return Promise.resolve({
        ok: false,
        attemptId,
        state: "preserving",
        inventory: this.preservationInventory,
        failures: [...this.preservationFailures],
      });
    if (this.maintenanceState === "preserved")
      return Promise.resolve({ ok: true, attemptId, state: "preserved", inventory: this.preservationInventory, failures: [] });
    if (this.preservationTask) return this.preservationTask;
    this.preservationStarted = true;
    this.preservationTask = this.runPreservation(attemptId).finally(() => {
      this.preservationTask = undefined;
    });
    return this.preservationTask;
  }

  /** Recover an abandoned prepare before any child stop. Once commit begins, preservation is
   * irreversible and remains fenced until the coordinator records failure/recourse. */
  abortPreservation(attemptId: string): void {
    if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    if (this.preservationAttemptId !== attemptId)
      throw new Error(`preservation attempt ${attemptId} is not the active manager attempt`);
    if (this.preparationTask || this.lifecycleInFlight > 0)
      throw new Error(`preservation attempt ${attemptId} is still preparing or draining accepted lifecycle work and cannot be aborted`);
    if (this.preservationStarted || this.preservationTask || this.maintenanceState === "preserved")
      throw new Error(`preservation attempt ${attemptId} has begun stopping children and cannot return to active mode`);
    this.preservationGeneration++;
    this.maintenanceState = "active";
    this.preservationAttemptId = undefined;
    this.preservationInventory = undefined;
    this.preservationFailures = [];
    if (this.auth && !this.credRenewTimer) {
      this.credRenewTimer = setInterval(() => { void this.renewDaemonCreds(); }, credRenewIntervalMs(STANDING_RENEWABLE_TTL_SEC));
      this.credRenewTimer.unref?.();
    }
    this.resumeCredRenewal?.();
    // Exit watchers were suppressed while the fence stood: reconcile every child that died during
    // preparation now, or its slot/credential footprint would linger unreaped after the abort.
    for (const agent of [...this.agents.values()]) {
      try {
        if (agent.handle.status() === "exited") this.onAgentExit(agent);
      } catch { /* status unavailable - the exit watcher fires again on real exit */ }
    }
  }

  /** In-process convenience that preserves the crash barrier by awaiting durable persistence between
   * prepare and commit. Wire callers use the explicit two-phase admin operations. */
  async preserveState(opts: ManagerPreserveOptions): Promise<ManagerPreserveResult> {
    const plan = await this.preparePreservation(opts.attemptId);
    if (!plan.ok)
      return { ok: false, attemptId: opts.attemptId, state: "preserving", inventory: plan.inventory, failures: plan.failures };
    await opts.persistInventory(plan.inventory);
    return this.commitPreservation(opts.attemptId);
  }

  private async runPreservation(attemptId: string): Promise<ManagerPreserveResult> {
    const failures: ManagerPreserveFailure[] = [];
    for (const a of [...this.agents.values()]) a.suppressCleanup = true;
    await Promise.all(
      [...this.agents.values()].map(async (a) => {
        try {
          // A preservation cut must not run the connector's logical leave/cleanup hooks.
          a.handle.stop({ graceful: false });
        } catch (e) {
          failures.push({ name: a.name, id: a.id, error: `stop failed: ${rejectionText(e)}` });
          return;
        }
        try {
          await this.awaitHandleExit(a.handle);
          if (this.agents.get(a.name) === a) this.agents.delete(a.name);
        } catch (e) {
          failures.push({ name: a.name, id: a.id, error: rejectionText(e) });
        }
      }),
    );

    if (failures.length === 0) this.maintenanceState = "preserved";
    return {
      ok: failures.length === 0,
      attemptId,
      state: this.maintenanceState === "preserved" ? "preserved" : "preserving",
      inventory: this.preservationInventory!,
      failures,
    };
  }

  private async awaitHandleExit(handle: AgentHandle): Promise<void> {
    if (!handle.waitForExit)
      throw new Error(`runtime "${handle.kind}" cannot prove child exit (AgentHandle.waitForExit is not implemented)`);
    await withTimeout(
      handle.waitForExit(),
      this.preserveStopTimeoutMs,
      `child did not exit within ${this.preserveStopTimeoutMs}ms`,
    );
    if (handle.status() !== "exited")
      throw new Error(`runtime "${handle.kind}" reported exit completion but status is still running`);
  }

  private inventoryReferenceError(entry: ManagerResumeAgent): string | undefined {
    if (entry.launch.source.kind === "manifest" && !entry.launch.source.runId)
      return "resolved manifest launch has no retained runId";
    if (entry.launch.unresolvedLaunchOptionKeys?.length)
      return `imperative launch options have no non-secret durable source (${entry.launch.unresolvedLaunchOptionKeys.join(", ")})`;
    if (!entry.dependencies.some((path) => resolve(path) === resolve(entry.launch.source.configPath)))
      return `launch config is not declared as a retained dependency: ${entry.launch.source.configPath}`;
    if (entry.launch.source.kind === "inline" && resolve(entry.launch.source.configPath) !== resolve(inlineSnapshotPath(this.workspaceRoot, entry.identity.lifecycleUid)))
      return `inline persona snapshot ${entry.launch.source.configPath} is not this lifecycle's snapshot path`;
    if (entry.launch.source.kind === "manifest" && entry.launch.source.runId) {
      const specPath = join(this.workspaceRoot, ".cotal", "run", `${entry.launch.source.runId}.json`);
      if (!entry.dependencies.some((path) => resolve(path) === resolve(specPath)))
        return `manifest source is not declared as a retained dependency: ${specPath}`;
    }
    const required = [...entry.dependencies];
    if (entry.identity.mode === "static") required.push(entry.identity.credential.path);
    if (entry.identity.mode === "user") {
      required.push(entry.identity.actorToken.path, entry.identity.sentinelCredential.path);
    }
    for (const path of required) {
      try {
        const st = lstatSync(path);
        if (!st.isFile() || st.isSymbolicLink()) return `retained reference is not a regular non-symlink file: ${path}`;
      } catch (e) {
        return `retained reference unavailable: ${path} (${rejectionText(e)})`;
      }
    }
    if (process.platform !== "win32") {
      const secrets = entry.identity.mode === "static"
        ? [entry.identity.credential.path]
        : entry.identity.mode === "user"
          ? [entry.identity.actorToken.path, entry.identity.sentinelCredential.path]
          : [];
      for (const path of secrets)
        if ((lstatSync(path).mode & 0o077) !== 0) return `retained identity file is not private (expected 0600): ${path}`;
    }
    try {
      if (this.fileDigest(entry.launch.source.configPath) !== entry.launch.source.configSha256)
        return `launch config changed since it became effective: ${entry.launch.source.configPath}`;
      if (entry.identity.mode === "static" && this.fileDigest(entry.identity.credential.path) !== entry.identity.credential.sha256)
        return `retained credential changed after the cut: ${entry.identity.credential.path}`;
      if (entry.identity.mode === "user" &&
          (this.fileDigest(entry.identity.actorToken.path) !== entry.identity.actorToken.sha256 ||
           this.fileDigest(entry.identity.sentinelCredential.path) !== entry.identity.sentinelCredential.sha256))
        return `retained user identity files changed after the cut for ${entry.name}`;
      if (entry.launch.source.kind === "manifest" && entry.launch.source.runId) {
        const specPath = join(this.workspaceRoot, ".cotal", "run", `${entry.launch.source.runId}.json`);
        if (!entry.launch.source.manifestSha256 || this.fileDigest(specPath) !== entry.launch.source.manifestSha256)
          return `manifest source changed since it became effective: ${specPath}`;
      }
    } catch (e) {
      return `retained reference cannot be hashed: ${rejectionText(e)}`;
    }
    return undefined;
  }

  private fileDigest(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }

  private fileDigestOrEmpty(path: string): string {
    try { return this.fileDigest(path); } catch { return ""; }
  }

  private resumeEntry(a: ManagedAgent, backfillFloor?: number): ManagerResumeAgent {
    // A preservation cut is a stop boundary too, so a manifest launch after it reopens what a resume would.
    this.recordContinuityAtStop(a, "preservation");
    return this.resumeEntryOf(a, backfillFloor);
  }

  /** The resume entry of one live seat, with no side effect: a preservation cut and a supervised
   *  seat's record both build it. The entry is its own copy, so a caller's write to the plan it was
   *  handed cannot change the launch the manager keeps supervising (#3241). */
  private resumeEntryOf(a: ManagedAgent, backfillFloor?: number): ManagerResumeAgent {
    const principal = a.userOwner
      ? parsePrincipalKey(a.id)
      : { owner: DEV_OWNER, actor: a.id };
    if (!principal) throw new Error(`managed agent ${a.name} has an invalid principal ${a.id}`);
    // The RECORDED secret-family paths (set at spawn or adoption) — never a re-derivation by name:
    // under mixed generations (a name-keyed pre-split incarnation adopted by this manager) the
    // recorded path is the only truth, and re-deriving would preserve a family that isn't there.
    const files = a.secretPaths;
    const identity: ManagerResumeIdentity = a.userOwner
      ? (() => {
          if (!files?.actorToken || !files.sentinelCreds || !files.health)
            throw new Error(`managed agent ${a.name} is user-mode but its secret-family paths were not recorded`);
          return {
            mode: "user" as const,
            owner: principal.owner,
            actor: principal.actor,
            lifecycleUid: a.lifecycleUid,
            actorToken: { kind: "file" as const, path: files.actorToken, sha256: this.fileDigestOrEmpty(files.actorToken) },
            sentinelCredential: { kind: "file" as const, path: files.sentinelCreds, sha256: this.fileDigestOrEmpty(files.sentinelCreds) },
            health: { kind: "file" as const, path: files.health },
          };
        })()
      : this.auth
        ? (() => {
            if (!files?.creds)
              throw new Error(`managed agent ${a.name} is static-auth but its credential path was not recorded`);
            return { mode: "static" as const, id: principal.actor, lifecycleUid: a.lifecycleUid, credential: { kind: "file" as const, path: files.creds, sha256: this.fileDigestOrEmpty(files.creds) }, ...(a.issued ? { issued: a.issued } : {}) };
          })()
        : { mode: "open", id: principal.actor, lifecycleUid: a.lifecycleUid };
    const dependencies = [a.launch.source.configPath];
    if (a.launch.source.kind === "manifest" && a.launch.source.runId)
      dependencies.unshift(join(this.workspaceRoot, ".cotal", "run", `${a.launch.source.runId}.json`));
    return structuredClone({
      space: this.space,
      name: a.name,
      role: a.role,
      identity,
      launch: {
        connector: a.agent,
        runtime: a.handle.kind,
        cwd: a.launch.cwd,
        source: a.launch.source,
        model: a.launch.model,
        variant: a.launch.variant,
        subscribe: a.launch.subscribe,
        allowSubscribe: a.launch.allowSubscribe,
        allowPublish: a.launch.allowPublish,
        capabilities: a.launch.capabilities,
        ...(a.launch.endpoints?.length ? { endpoints: copyPersonaEndpoints(a.launch.endpoints) } : {}),
        events: a.launch.events,
        eventPayloads: a.launch.eventPayloads,
        shareTools: a.launch.shareTools,
        forkSource: a.launch.forkSource,
        ...(this.forkProvenance(a) ? { resumed: this.forkProvenance(a) } : {}),
        // A supervised seat whose connector keeps no session state is armed with no state file to read.
        sessionId: a.restart?.armed && a.restart.sessionStatePath ? this.readManagedSession(a) : a.launch.sessionId,
        // Additive and only when the connector supplied one. A seat with no pointer records no
        // field, which is what keeps an older inventory and a fresh one the same document shape.
        ...(a.restart?.sessionStatePath ? { sessionStatePath: a.restart.sessionStatePath } : {}),
        unresolvedLaunchOptionKeys: a.launch.unresolvedLaunchOptionKeys,
      },
      dependencies,
      spawner: a.spawner,
      authorityParent: a.authorityParent,
      startedAt: new Date(a.startedAt).toISOString(),
      ...(backfillFloor !== undefined ? { backfillFloor } : {}),
    });
  }

  /** Tear down every managed agent's footprint on an explicit destructive {@link stop}, or only the
   *  in-process seats a default stop cannot detach. A manager exit is
   *  a mass agent-exit, and without this its agents' footprints (creds files + `dm_`/`dlv_` durables + ACL
   *  rows) would orphan exactly as the per-agent exit path prevents. Stop each child gracefully, so its
   *  own shutdown runs before the runtime escalates, and AWAIT its deprovision — bounded per agent (`withTimeout`) and
   *  best-effort (`allSettled` + a loud log), so one slow/failed teardown can neither hang nor abort exit.
   *  The creds file is dropped even if the broker teardown fails (see {@link deprovision}). Deliberately
   *  touches NEITHER the lease NOR the endpoints — the caller owns those. */
  private async teardownManagedAgents(managed = [...this.agents.values()]): Promise<void> {
    const failures: string[] = [];
    const stopped: ManagedAgent[] = [];
    for (const a of managed) {
      // Free the slot and stop each the way an operator stop does. `stopHandle` is best-effort (never
      // throws — see it), so one bad stop can't strand the rest, and every snapshot entry is
      // deprovisioned below regardless. A hard kill never runs the seat's shutdown, so a helper that
      // has left the process group keeps running after `cotal down`. The runtime still escalates to
      // SIGKILL after its grace.
      this.recordContinuityAtStop(a, "shutdown");
      if (process.platform !== "win32" || a.handle.kind !== "pty") {
        this.agents.delete(a.name);
        this.dropSeatRecord(a);
      }
      const refused = this.stopHandle(a, true, { kind: "stopped-shutdown" });
      if (refused === undefined) stopped.push(a);
      else failures.push(`${a.name}: stop failed: ${refused}`);
    }
    // A runtime stop request is not exit proof. Do not release the manager lease or registration
    // while any seat may still hold this instance's broker rails: that creates the exact orphan
    // window where a successor sees a dead manager but live predecessor authority. Every shipped
    // runtime now supplies waitForExit; absence or timeout is a failed shutdown, never a clean one.
    // The slot delete above bypasses freeSlot, which is where the reap line lives, so say it
    // here once this shutdown has proved the seat exited. A seat whose stop was refused, or
    // whose exit wait did not prove it gone, is named only by the shutdown error below (#1423, #3404).
    await Promise.all(stopped.map(async (a) => {
      try {
        await this.awaitHandleExit(a.handle);
        if (process.platform === "win32" && a.handle.kind === "pty") {
          this.agents.delete(a.name);
          this.dropSeatRecord(a);
        }
        this.logSeatReaped(a, { kind: "stopped-shutdown" });
      } catch (e) {
        failures.push(`${a.name}: ${rejectionText(e)}`);
      }
    }));
    // Deprovision EVERY snapshot entry regardless of whether its stop failed (allSettled + a loud log).
    await Promise.allSettled(
      managed.filter((a) => !a.suppressCleanup).map((a) => {
        // Retired here on every mesh, the open mesh included, which runs no teardown of its own.
        const settled = a.launch.source.kind !== "inline" || this.dropInlineSnapshot(a.name, a.lifecycleUid);
        return this.deprovision({ ...this.teardownTarget(a), ...(settled ? { snapshotSettled: true as const } : {}) }).catch((e) => console.error(`deprovision ${a.name} (${a.id}) on shutdown: ${rejectionText(e)}`));
      }),
    );
    if (failures.length)
      throw new Error(`manager shutdown could not prove every seat exited: ${failures.join("; ")}`);
  }

  private isProcessBoundSeat(agent: ManagedAgent): boolean {
    return agent.handle.kind === "pty" && typeof agent.handle.release !== "function";
  }

  /** Drop local custody of every seat that can outlive this process, and leave it running. A seat
   *  with a runtime reference is recorded first, so the next manager on this workspace adopts it, or
   *  retires it once its runtime proves it gone. The stopping manager keeps no watch on a released
   *  seat: its endpoint is closing, and a retirement it drove afterwards would run over a dead
   *  connection and race the next manager's. `stop` is every seat left for the caller to stop and
   *  retire now: an in-process seat, a seat the runtime already reports gone, and a seat whose record
   *  could not be written, because a released seat nobody can find again is the leak this stop must
   *  not create. */
  private releaseManagedAgents(): { failures: string[]; stop: ManagedAgent[] } {
    const failures: string[] = [];
    const stop: ManagedAgent[] = [];
    for (const a of [...this.agents.values()]) {
      if (this.isProcessBoundSeat(a)) {
        stop.push(a);
        continue;
      }
      let exited = false;
      try {
        exited = a.handle.status() === "exited";
      } catch {
        // Status is not proof either way; the seat is released as any running seat is.
      }
      if (exited) {
        stop.push(a);
        continue;
      }
      const reference = a.handle.reference;
      if (reference) {
        try {
          // A static manager records an adoptable seat at launch and keeps that record current. A
          // user-mode manager records nothing until here.
          if (this.userMode)
            writeSeatRecord(this.workspaceRoot, { version: "cotal-seat-record/v1", instanceId: this.managerInstanceId, crashes: a.restart?.crashes ?? [], agent: this.resumeEntryOf(a) });
          writeReleasedSeatReference(this.workspaceRoot, this.space, a.name, { version: "cotal-released-seat/v1", lifecycleUid: a.lifecycleUid, kind: reference.kind, id: reference.id });
        } catch (e) {
          console.error(`! ${a.name}: the released seat could not be recorded (${rejectionText(e)}); this stop retires it instead`);
          stop.push(a);
          continue;
        }
      }
      try {
        a.handle.release?.();
        a.suppressCleanup = true;
        this.agents.delete(a.name);
      } catch (e) {
        failures.push(`${a.name}: ${rejectionText(e)}`);
      }
    }
    return { failures, stop };
  }

  /** Take back user-mode seats a previous manager released while they were still running. A seat
   *  the runtime adopts is watched, and retired when that watch proves it gone. A seat the runtime
   *  has already reaped is retired now. Anything the runtime cannot prove is left recorded. */
  private async adoptReleasedSeats(): Promise<void> {
    const dir = join(this.workspaceRoot, ".cotal", "seat-records", this.space);
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".runtime-ref")) continue;
      const name = file.slice(0, -".runtime-ref".length);
      try {
        await this.adoptReleasedSeat(name);
      } catch (e) {
        console.error(`! ${name}: the released seat was not adopted: ${rejectionText(e)}`);
      }
    }
  }

  private async adoptReleasedSeat(name: string): Promise<void> {
    const reference = readReleasedSeatReference(this.workspaceRoot, this.space, name);
    const record = reference ? readSeatRecord(this.workspaceRoot, this.space, name) : undefined;
    const identity = record?.agent.identity;
    if (!reference || !record || identity?.mode !== "user" || identity.lifecycleUid !== reference.lifecycleUid) return;
    try {
      await this.validateRetainedAuthority(record.agent);
    } catch (e) {
      console.error(`! ${name}: the released seat's record was not adopted: ${rejectionText(e)}`);
      return;
    }
    const held = this.agents.get(name);
    if (held?.lifecycleUid === reference.lifecycleUid) return;
    if (held) return;
    const runtime = this.runtimeFor(reference.kind);
    if (typeof runtime.adopt !== "function" || reference.kind !== runtime.kind) return;
    let handle: AgentHandle;
    try {
      handle = runtime.adopt(reference);
    } catch (e) {
      try {
        await requireRuntimeReap(runtime, reference);
      } catch {
        // The runtime could not prove the seat gone. Leave the record for a later start.
        return;
      }
      console.error(`! ${name}: the released seat is gone (${rejectionText(e)}); retiring its lifecycle`);
      handle = {
        name,
        kind: runtime.kind,
        reference: { kind: runtime.kind, id: reference.id },
        status: () => "exited",
        stop: () => {},
        interrupt: () => {},
        waitForExit: () => Promise.resolve(),
        attach: () => { throw new Error(`released seat ${name} has exited`); },
      };
    }
    const launch = record.agent.launch;
    const agent: ManagedAgent = {
      name,
      role: record.agent.role,
      agent: launch.connector,
      id: principalKey(identity.owner, identity.actor).key,
      lifecycleUid: identity.lifecycleUid,
      userOwner: identity.owner,
      secretPaths: {
        actorToken: identity.actorToken.path,
        sentinelCreds: identity.sentinelCredential.path,
        health: identity.health.path,
      },
      spawner: record.agent.spawner,
      authorityParent: record.agent.authorityParent,
      startedAt: Date.parse(record.agent.startedAt) || Date.now(),
      handle,
      launch: {
        source: launch.source,
        runtime: launch.runtime,
        cwd: launch.cwd,
        model: launch.model,
        variant: launch.variant,
        subscribe: launch.subscribe,
        allowSubscribe: launch.allowSubscribe,
        allowPublish: launch.allowPublish,
        capabilities: launch.capabilities,
        events: launch.events,
        eventPayloads: launch.eventPayloads,
        shareTools: launch.shareTools,
        forkSource: launch.forkSource,
        sessionId: launch.sessionId,
        unresolvedLaunchOptionKeys: launch.unresolvedLaunchOptionKeys,
      },
    };
    this.agents.set(name, agent);
    this.watchExit(agent);
  }

  private async stopRetainedAgentsOnExit(): Promise<void> {
    const managed = [...this.agents.values()];
    for (const a of managed) a.suppressCleanup = true;
    const failures: string[] = [];
    await Promise.all(managed.map(async (a) => {
      try {
        // No cut holds a delegated seat (runPreparation refuses one), so stopping it is its retirement.
        if (a.handedOff) await this.deprovision(this.teardownTarget(a));
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
    this.shutdownReadiness.abort();
    clearTimeout(this.credentialPushRetry);
    this.credentialPushRetry = undefined;
    this.transcripts?.stop();
    this.staticLifecycle.stop();
    const starting = this.startTask;
    await this.awaitStaticReconcileDrain();
    await starting?.catch(() => {});
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    if (this.credRenewTimer) clearInterval(this.credRenewTimer);
    if (this.endpointServeRenewalTimer) clearTimeout(this.endpointServeRenewalTimer);
    if (this.daemonRenewalLeaseTimer) clearInterval(this.daemonRenewalLeaseTimer);
    if (this.sessionKeyRenewTimer) clearInterval(this.sessionKeyRenewTimer);
    // A renew already in flight when the timer was cleared above must be awaited, not raced: it can
    // still move the key's revision after we clear the timer, and releasing against a cached
    // revision it has since moved is a CAS the broker correctly refuses, silently, forever.
    await this.leaseRenewTask?.catch(() => {});
    // Join the bounded Manager renewal. Its stop/deadline fence refuses late adoption, but the
    // host still owns any submitted issuance and its outcome can remain unknown after timeout.
    await this.remoteBundleRenewal?.catch(() => {});
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
          const detached = this.releaseManagedAgents();
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
    if (this.maintenanceState === "active" && !this.resumeRequired) await step("retire chat sessions", () => this.retireChatSessionsOnStop());
    else this.reportChatSessionsLeftAtStop(this.resumeRequired ? "this manager is waiting for a resume" : "this manager is preserving its state");
    // A seat that may still be alive keeps this instance's leases and registration (see
    // teardownManagedAgents): they lapse on their TTL instead of being handed to a successor.
    if (seatFailure === undefined) {
      await step("release manager lease", () => this.releaseOwnManagerLease());
      // #1634: hand the renewal lease back on a clean stop so a sibling picks it up on its next pass
      // rather than waiting out the bucket TTL. A non-owner holds no revision and this is a no-op.
      await step("release renewal lease", () => this.ep.releaseDaemonRenewalLease());
    }
    // Capture BEFORE the serve loop is torn down: `stopServiceServe` clears the state, and what is
    // being asked here is "which registration did this process write", which only the state
    // before teardown can answer. Deregistration runs AFTER the serve loop has drained, so no
    // in-flight command can write a status back onto the record it just removed.
    const registrationRevision = this.serviceServe?.grant.registrationRevision;
    await step("stop service serve", () => this.stopServiceServe());
    // The drives AFTER the serve loop (no new `run-start` can land) and BEFORE deregistration: a
    // released run's status write is the last thing this incarnation says about it.
    await step("stop run hosting", () => this.runHosting?.stop());
    this.runHosting = undefined;
    if (registrationRevision !== undefined && seatFailure === undefined)
      await step("deregister service", () => this.deregisterServiceOnStop(registrationRevision));
    await step("stop goal writer", () => this.stopGoalWriter());
    await step("stop session plane", () => this.stopSessionPlane());
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
      const outcome = await ((this.auth || this.remoteAuthority)
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
          `  Its registration now outlives this process and will be frozen into every class scatter in space "${this.space}", each paying the full deadline.\n` +
          `  NEXT: once this process is gone, start this manager again and stop it cleanly; on a static space \`cotal endpoint deregister manager ${iid} --yes\` from the space's own root also removes it.`,
      );
    }
  }

  /** Stop the v0.4 service-endpoint serve loop (drain subscriptions, await in-flight handlers)
   *  and drop its dedicated connection, or only close the connection while its transport is down.
   *  Best-effort so a graceful stop completes its remaining teardown even when the broker is gone. */
  private async stopServiceServe(): Promise<void> {
    const s = this.serviceServe;
    if (!s) return;
    this.serviceServe = undefined;
    await this.retireConnection(s.nc, () => s.handle.stop());
  }

  /** Retire a dedicated connection on stop: drain it while its transport is up, close it while the
   *  client is reconnecting it. A drain on a reconnecting connection does not fail, it waits for the
   *  reconnect, so the stop would last as long as the outage; a broker this connection cannot reach
   *  has nothing left to flush. `flush` (the serve loop's own drain) runs only while the transport is
   *  up. Best-effort, so a graceful stop completes its remaining teardown even when the broker is gone. */
  private async retireConnection(nc: NatsConnection, flush?: () => Promise<unknown>): Promise<void> {
    if (this.transportDown.has(nc)) {
      try { await nc.close(); } catch { /* best effort */ }
      return;
    }
    if (flush) try { await flush(); } catch { /* best effort */ }
    try { await drainAndClose(nc); } catch { /* best effort */ }
  }

  /** A failed candidate must not extend preparation by draining subscriptions on a stalled socket.
   * Close only that candidate first. Native stop still owns any already-dispatched handlers, whose
   * outcomes remain unknown to callers and must not be replayed; they do not hold family adoption. */
  private async discardServeCandidate(nc: NatsConnection, handle?: EpServeHandle): Promise<void> {
    await nc.close();
    if (handle) void handle.stop().catch((e) => console.error(`! remote manager discarded serve candidate cleanup: ${rejectionText(e)}`));
  }

  /** Track a dedicated connection's transport into {@link transportDown} from the first moment:
   *  nats.js reports `disconnect` when the socket drops and `reconnect` only after it has re-sent the
   *  connection's subscriptions. If the status stream itself fails, the transport can no longer be
   *  observed, so it counts as down. */
  private trackTransport(nc: NatsConnection): void {
    void (async () => {
      for await (const st of nc.status()) {
        if (st.type === "disconnect") this.transportDown.add(nc);
        else if (st.type === "reconnect") this.transportDown.delete(nc);
      }
    })().catch(() => this.transportDown.add(nc));
  }

  private async opFinalizeResume(rawArgs: unknown): Promise<ControlReply> {
    if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    {
      let args: { attemptId: string; durableCommitToken: string };
      try {
        args = parseResumeFinalizeArgs(rawArgs);
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
      if (!this.resumeAttemptId || this.resumeAttemptId !== args.attemptId)
        return { ok: false, error: `manager expects resume attempt ${this.resumeAttemptId ?? "<none>"}, not ${args.attemptId}` };
      if (!this.resumeCommitted || !this.resumeDurableCommitToken)
        return { ok: false, error: `resume attempt ${args.attemptId} has no successful commit to finalize` };
      if (this.resumeDurableCommitToken !== args.durableCommitToken)
        return { ok: false, error: `resume attempt ${args.attemptId} durable commit token does not match` };
      if (this.resumeFinalized) return { ok: true, data: { attemptId: args.attemptId, state: "active" } };
      const inventory = this.resumeInventory;
      if (!inventory)
        return { ok: false, error: `resume attempt ${args.attemptId} has no bound inventory` };
      let inactive: string[];
      try {
        inactive = this.resumeLivenessErrors(inventory, this.ep.getRoster());
      } catch (e) {
        return { ok: false, error: `resume attempt ${args.attemptId} cannot verify live principals at finalize: ${rejectionText(e)}` };
      }
      if (inactive.length)
        return { ok: false, error: `resume attempt ${args.attemptId} is not live at finalize: ${inactive.join("; ")}` };
      for (const entry of this.resumeInventory?.agents ?? []) {
        const managed = this.agents.get(entry.name);
        if (managed) managed.suppressCleanup = false;
      }
      // distsys/security CONDITIONAL @ 9e13648: the boot sweep DEFERRED every active
      // slot while a resume was pending (it could not know which would be adopted). Now adoption
      // is complete and `this.agents` is EXACTLY the adopted set, so re-sweep to terminalize any
      // active slot the resume did NOT claim — a durable ACTIVE ORPHAN (crashed after slot->active
      // before agents.set, then not in the resumed inventory). This runs while `resumeRequired` is
      // still true, so no ordinary spawn can race it (beginLifecycle refuses non-resume ops), and
      // it closes both the alias wedge AND the membership-gate gap (the orphan's principal enters
      // retiredPrincipals, so a copied JWT is refused). Best-effort + loud: a sweep failure must
      // not fail the finalize (the next non-resume boot re-drives it), but it is never swallowed.
      if (this.auth && !this.userMode)
        await this.reconcileStaticLifecycles(true).catch((e) => console.error(`! post-resume static reconcile: ${rejectionText(e)} - no per-alias retry could be planned; a later manager start re-reads unfinished durable terminals`));
      this.resumeFinalized = true;
      this.resumeRequired = false;
      return { ok: true, data: { attemptId: args.attemptId, state: "active" } };
    }
  }

  private async opCommitResume(rawArgs: unknown): Promise<ControlReply> {
    if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    {
      let attemptId: string;
      try {
        attemptId = parseResumeCommitArgs(rawArgs).attemptId;
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
      if (!this.resumeAttemptId || this.resumeAttemptId !== attemptId)
        return { ok: false, error: `manager expects resume attempt ${this.resumeAttemptId ?? "<none>"}, not ${attemptId}` };
      if (this.resumeCommitted)
        return {
          ok: true,
          data: {
            attemptId,
            state: this.resumeFinalized ? "active" : "awaitingFinalize",
            durableCommitToken: this.resumeDurableCommitToken,
          },
        };
      if (this.resumeCommitTask) return this.resumeCommitTask;
      const task = this.commitResumeActivation(attemptId);
      this.resumeCommitTask = task;
      try {
        return await task;
      } finally {
        if (this.resumeCommitTask === task) this.resumeCommitTask = undefined;
      }
    }
  }

  private async opResumePreserved(rawArgs: unknown): Promise<ControlReply> {
    if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    {
      try {
        const args = parseResumeControlArgs(rawArgs);
        const inventoryDigest = createHash("sha256").update(JSON.stringify(args.inventory)).digest("hex");
        if (!this.resumeAttemptId)
          return { ok: false, error: "resumePreserved requires a manager started with --resume-attempt" };
        if (this.resumeAttemptId !== args.attemptId)
          return { ok: false, error: `manager expects resume attempt ${this.resumeAttemptId}, not ${args.attemptId}` };
        if (this.resumeInventoryDigest && this.resumeInventoryDigest !== inventoryDigest)
          return { ok: false, error: `resume attempt ${args.attemptId} is already bound to a different inventory` };
        if (!this.resumeInventoryDigest) {
          this.resumeInventoryDigest = inventoryDigest;
          this.resumeInventory = args.inventory;
        }
        if (!this.resumeTask && !this.resumeResult) {
          this.resumeTask = this.resumePreserved(args.inventory).then((result) => {
            if (result.ok || this.resumedAgentNames.size > 0) this.resumeResult = result;
            return result;
          }).finally(() => {
            this.resumeTask = undefined;
          });
        }
        const result = this.resumeResult ?? await this.resumeTask!;
        const data = { attemptId: args.attemptId, state: result.ok ? "awaitingCommit" : "degraded", ...result };
        return result.ok
          ? { ok: true, data }
          : { ok: false, data, error: result.error ?? "retained-agent resume failed" };
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
    }
  }

  private async opPreservationCtl(op: string, rawArgs: unknown): Promise<ControlReply> {
    if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    if (this.resumeRequired) return { ok: false, error: this.maintenanceError() };
    const attemptId = String((rawArgs as Record<string, unknown> | undefined)?.attemptId ?? "").trim();
    if (!attemptId) return { ok: false, error: `${op} requires attemptId` };
    try {
      if (op === "abortPreservation") {
        this.abortPreservation(attemptId);
        return { ok: true, data: { attemptId, state: "active" } };
      }
      const result = op === "preparePreservation"
        ? await this.preparePreservation(attemptId)
        : await this.commitPreservation(attemptId);
      return result.ok
        ? { ok: true, data: result }
        : {
            ok: false,
            data: result,
            error: `preservation incomplete: ${result.failures.map((f) => `${f.name}: ${f.error}`).join("; ")}`,
          };
    } catch (e) {
      return { ok: false, error: rejectionText(e) };
    }
  }

  /** The ONE shared control-admission chokepoint BOTH dispatch doors
   *  run — the v0.3 `ctl` door ({@link handle}) and the v0.4 `ep` service handlers
   *  ({@link serveGated}): the maintenance/resume fence (`beginLifecycle`: a resume-pending or
   *  non-active manager accepts no ordinary control work) and then the membership gate
   *  ({@link lifecycleMembershipRefusal}: a retiring/terminalizing/retired managed incarnation's
   *  AUTHENTICATED principal holds no control authority even with a valid JWT). Refusal carries
   *  WHICH fence refused so the ep door can map onto the §13.3 catalog; admission returns the
   *  accepted-work release. Never re-implemented per door — a fence on one door is a bypass. */
  private admitControl(caller: string):
    | { refusal: string; fence: "maintenance" | "membership"; release?: undefined }
    | { refusal?: undefined; release: () => void } {
    const release = this.beginLifecycle();
    if (!release) return { refusal: this.maintenanceError(), fence: "maintenance" };
    const membership = this.lifecycleMembershipRefusal(caller);
    if (membership) {
      release();
      return { refusal: membership, fence: "membership" };
    }
    return { release };
  }

  /** Run one v0.4 service-command handler through the SHARED admission chokepoint
   *  ({@link admitControl}) on the broker-authenticated caller principal, mapping the two fences
   *  onto the §13.3 catalog: maintenance/resume → `unavailable`, membership →
   *  `permission-denied`. The serve boundary publishes the structured error reply. */
  private async serveGated<T>(ctx: EpServeContext, fn: () => T | Promise<T>): Promise<T> {
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
   *  applies. `preserving` and a stopping manager stay fenced. Status writes nothing. */
  private async serveObservation<T>(ctx: EpServeContext, fn: () => T | Promise<T>): Promise<T> {
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

  /** The ep door's ADMIN flag for a caller. Static mesh: `true` — the
   *  admin-grade rows (any-mode despawn/attach, the `manager.admin` family, `launch`) are minted
   *  only into operator instruments (§13.2: `any` is operator-policy-mintable; the agent/spawn
   *  rollups never carry them), so REACHING the handler is holding the admin tier, exactly as
   *  holding `ctl.<admin>` is today. User mesh: the caller's CURRENT ledger scope must carry
   *  `admin`. A local-host manager reads its own ledger fresh. A remote-authority manager relays the
   *  subject-parsed caller tuple to its host-owned authorization callback, with no participant-ledger
   *  fallback. The same fresh authority drives {@link psOwnerFilter}, so a revoked scope demotes the
   *  very next call even on a still-valid bearer. Local ledger read failures authorize nothing;
   *  remote host-state faults throw and fail the operation closed.
   *  NAMED RESIDUAL: the static `true` has no serve-time re-check — a LEAKED static admin
   *  instrument keeps its reach until the credential's bounded
   *  TTL (the one-shot 5-minute profile), the same static-revoke≠reconnect-death class ruled
   *  across this campaign; static revocation is the TTL, not a ledger. */
  private async epAdminReach(caller: EpCaller): Promise<boolean> {
    if (!this.userMode) return true;
    if (this.remoteAuthority) {
      // A hosted run's own caller is derived from its id and holds no ledger row: it acts for the
      // caller its run was admitted for, so that caller's current grant decides, and a revoked
      // login demotes the run's next spawn.
      const asked = this.runHosting?.admittedCaller(caller) ?? caller;
      return this.remoteAuthority.authorizeAdmin({ owner: asked.owner, actor: asked.actor, lifecycleUid: asked.uid });
    }
    try {
      const scope = await resolveAuthProvider().actorScope({
        dir: userAuthStateDir(this.workspaceRoot, this.space),
        owner: caller.owner,
        actor: caller.actor,
      });
      return scope?.includes("admin") === true;
    } catch {
      return false;
    }
  }

  /** A targeted request's admin flag: mode `any` (the operator instrument's cross-agent form,
   *  rev 3) resolves through {@link epAdminReach}; a user-mode any-mode caller whose CURRENT
   *  ledger row lost `admin` since its rows were minted refuses loud rather than silently
   *  downgrading to the owner path (the request's declared mode is honored or denied, never
   *  reinterpreted). Owner mode is always the privileged (own-domain) path. */
  private async epAnyModeAdmin(ctx: EpServeContext): Promise<boolean> {
    if (ctx.subject.target?.mode !== "any") return false;
    if (!(await this.epAdminReach(ctx.subject.caller)))
      throw new EpEnvelopeError("permission-denied", `an any-mode ${ctx.subject.command} is operator reach; the caller's current ledger grant does not carry "admin" (SPEC 13.2)`);
    return true;
  }

  /** The run host, or one of three refusals. A remote-authority manager holds no space signer, so
   *  it cannot mint the per-run driver credential SPEC 14.6 requires without all four closed
   *  host callbacks. A local user-auth mesh is `unimplemented`: a hosted run's seats
   *  are spawned, turned and despawned by a caller derived from the run id under the static
   *  owner, which the user-mode spawn door refuses (no `u_` owner), so a program would fail at
   *  its first seat; no path to `--local` is offered there since a user bearer holds no run rows
   *  either. An ordinary manager whose host is not standing yet is still booting (the serve
   *  surface comes up before the host): `unavailable`, retry. The three are told apart, since
   *  the first sentence steers a caller to `--local` and the others must not. */
  private runHost(): RunHosting {
    if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    if (this.runHosting) return this.runHosting;
    if (this.remoteAuthority && !this.remoteAuthority.runHosting)
      throw new EpEnvelopeError("unimplemented", "this manager does not host workflow runs: its issuing host supplied no closed run callbacks, and a remote-authority manager mints no run-driver credentials (SPEC 14.6); drive the run from a terminal with `cotal run start --local --file <program>`");
    if (this.userMode && !this.remoteAuthority?.runHosting)
      throw new EpEnvelopeError("unimplemented", `user-auth space "${this.space}" hosts no workflow runs yet: a hosted run's seats would be spawned under the static owner, which a user mesh refuses; run programs on a static-auth mesh`);
    throw new EpEnvelopeError("unavailable", "the manager is still booting its workflow-run host; retry shortly (SPEC 14.3)");
  }

  /** The answerer a `run-answer` records (SPEC 14.5): the caller as this manager knows them. A
   *  managed seat is named by its persona name; any other authenticated caller (an operator
   *  instrument, a logged-in user) by its principal. Never the request body's word. */
  private runAnswerer(ctx: EpServeContext): string {
    const caller = principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key;
    for (const a of this.agents.values()) if (this.managedPrincipal(a) === caller) return a.name;
    return caller;
  }

  /** A baseline seat may answer only the pause whose relay is pending on that exact incarnation.
   *  Explicit `run` holders and unmanaged operator instruments keep the run capability's existing
   *  answer reach. The relay payload is manager-held state written by the runtime, never request
   *  input, and its token is checked against the open checkpoint before any answer is filed. */
  private authorizeRunAnswer(ctx: EpServeContext, args: { runId: string; stepKey: string }, open: { token: string }): void {
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
  private async serveTurnParticipation(caller: EpCaller): Promise<{
    owner: string; actor: string; lifecycleUid: string; name: string; managerInstanceId: string; expiresAt: number;
  }> {
    if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal(), undefined, "not-executed");
    if (!/^pa_[a-z2-7]{26}$/.test(caller.actor))
      throw new EpEnvelopeError("permission-denied", "workflow turn participation is reserved for approved personal conversation actors", undefined, "not-executed");
    if (!this.remoteAuthority)
      throw new EpEnvelopeError("unimplemented", "personal workflow participation requires a registered issuing host with fresh lifecycle authority", undefined, "not-executed");
    if (!this.remoteAuthority.authorizeParticipation)
      throw new EpEnvelopeError("unimplemented", "the issuing host supplies no closed personal participation authorization", undefined, "not-executed");
    const authorized = await this.remoteAuthority.authorizeParticipation({ owner: caller.owner, actor: caller.actor, lifecycleUid: caller.uid });
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
  private turnTarget(ctx: EpServeContext): { kind: "managed"; agent: ManagedAgent; name: string } | { kind: "personal"; participant: PersonalTurnParticipant; name: string } {
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
  private authorizeRunAmend(ctx: EpServeContext, accepted: { by: string }): void {
    const caller = principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key;
    const agent = [...this.agents.values()].find((a) =>
      this.managedPrincipal(a) === caller && a.lifecycleUid === ctx.subject.caller.uid);
    if (agent === undefined || agent.launch.capabilities?.includes("run")) return;
    if (accepted.by !== agent.name)
      throw new EpEnvelopeError("permission-denied", `run-answer amend is allowed to ${agent.name} only for an answer recorded under its own name; this step's accepted answer is ${JSON.stringify(accepted.by)}'s`);
  }

  /** The v0.4 typed command table: every ordinary handler runs the SHARED
   *  admission chokepoint ({@link serveGated}) and then delegates to the SAME op core the ctl
   *  door dispatches (one core, two thin doors). The resume/preservation family
   *  deliberately BYPASSES serveGated — exactly as it sits before {@link admitControl} on the ctl
   *  door (those ops must run while `resumeRequired` fences ordinary work) — riding its own state
   *  fences; its ep gate is the admin-grade `manager.admin` capability grant (static
   *  admin-class commands are capability-gated + untargeted, never a fabricated ledger mode).
   *
   *  TIER SEMANTICS on the ep door: the tier lives in the CALLER'S
   *  GRANT, refined per-op exactly as the ctl doors refine their subject tier. Owner-mode
   *  `despawn`/`attach` keep the privileged semantics (`admin=false`, own-domain via
   *  {@link authorizeNamed}) — every spawn-capable agent holds those rows. ANY-mode requests are
   *  the operator instrument's cross-agent reach (rev 3): the any-mode subject row is mintable
   *  only under operator policy (§13.2), so on a static mesh holding it IS the admin tier, and in
   *  user mode the caller's CURRENT ledger scope must still carry `admin`
   *  ({@link epAdminReach}, the same fresh-read authority `psOwnerFilter` consults). The
   *  `manager.admin` family (purge + the resume/preservation ops) is capability-gated at mint AND
   *  re-checked at serve time via {@link epAdminReach} (the `adminGated` wrapper) so a user's
   *  revoked scope demotes the next call. `launch` is OWNER-EQUALITY on this door for everyone:
   *  the deploy path is its only consumer and stamps the caller's own owner,
   *  so cross-owner launch was a ctl-tier incidental never exercised, and keying it on the actor's
   *  ledger scope broke the deployer-view attenuation - uniform owner-equality is the safe tier.
   *  TWO DELIBERATE NARROWINGS vs the ctl doors (NOT bit-exact parity): (1)
   *  `define-persona` is `admin=false` for everyone (own-persona discipline; no ep consumer needs
   *  cross-owner persona writes - an operator redefines via config, not the wire), where the ctl
   *  admin tier allowed operator cross-owner redefine; (2) launch is owner-equality-only, above.
   *  Both are least-privilege reductions, never widenings. */
  private managerServiceDefs(): EpCommandDef[] {
    const args = (ctx: EpServeContext): Record<string, unknown> => (ctx.request.args ?? {}) as Record<string, unknown>;
    const callerOf = (ctx: EpServeContext): string => principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key;
    // A ctl-core failure reply becomes the §13.3 structured error the serve boundary publishes.
    // The data half of a failure reply (e.g. a degraded resume result) rides the error MESSAGE
    // only — the action model gives failures a typed channel.
    const unwrap = (r: ControlReply): unknown => {
      if (!r.ok) throw new EpEnvelopeError((r.code ?? "failed-precondition") as EpErrorCode, r.error ?? "the operation failed", r.details, r.outcome);
      return r.data;
    };
    // The admin-family serve gate: every `manager.admin`-class
    // command re-checks operator reach AT SERVE TIME - static: true (the mint boundary already
    // gates the rows to instruments); user mesh: the caller's CURRENT ledger scope must still
    // carry `admin` ({@link epAdminReach}'s fresh read), so a revoked scope demotes the very next
    // call instead of riding the bearer's remaining JWT-row lifetime. The resume family keeps its
    // serveGated BYPASS (those ops must run while the maintenance fence holds) but not the gate.
    const adminGated = async <T>(ctx: EpServeContext, fn: () => T | Promise<T>): Promise<T> => {
      if (!(await this.epAdminReach(ctx.subject.caller)))
        throw new EpEnvelopeError("permission-denied", `${ctx.subject.command} is operator reach; the caller's current ledger grant does not carry "admin" (SPEC 13.2)`, undefined, "not-executed");
      return fn();
    };
    const targetAgent = (ctx: EpServeContext): ManagedAgent => {
      if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
      const t = ctx.request.target!; // targeted commands only: the serve boundary enforced body-target presence + fresh currency
      const a = this.findManagedByTarget(t);
      if (!a) throw new EpEnvelopeError("expired", `target ${t.owner}.${t.actor} (lifecycle ${t.lifecycleUid}) is not a live managed agent of this manager`, undefined, "not-executed");
      return a;
    };
    return managerCommandDefs({
      vitals: (ctx) => this.serveGated(ctx, () => measureManagerVitals()),
      // A remote Manager files every seat under its own owner, so only a user mesh's shared local
      // Manager narrows the count, and status never waits on a remote admin check.
      status: (ctx) => this.serveObservation(ctx, async () => this.managerStatusData(this.remoteAuthority ? undefined : await this.psOwnerFilter(ctx.subject.caller, false))),
      ps: (ctx) => this.serveGated(ctx, async () => this.list(await this.psOwnerFilter(ctx.subject.caller, false))),
      inspect: (ctx) => this.serveGated(ctx, async () => {
        const name = String(args(ctx).name ?? "").trim();
        const row = this.list(await this.psOwnerFilter(ctx.subject.caller, false)).find((x) => x.name === name);
        if (!row) {
          // The live hit above stays entirely local. Only a miss widens into durable static state,
          // where `not-found` is honest only after the slot read itself succeeds and returns absent.
          // User-mode lifecycles have no manager-local mgrslot row; their per-name projection remains
          // the live map until the auth service exposes an equivalent mediated reader.
          if (this.auth && !this.userMode) {
            const recordsKv = this.goalWriter?.ctx.kv;
            if (!recordsKv)
              throw new EpEnvelopeError("unavailable", `the durable static slot store is not ready while inspecting "${name}"`, [
                { kind: STATIC_SLOT_READ_FAILED_DETAIL, name, record: "slot", operation: "read" },
              ]);
            let observed;
            try {
              observed = await observeStaticSlot(recordsKv, DEV_OWNER, name, this.managerInstanceId);
            } catch (error) {
              throw new EpEnvelopeError("unavailable", `the durable static slot state for "${name}" could not be read: ${rejectionText(error)}`, [
                { kind: STATIC_SLOT_READ_FAILED_DETAIL, name, record: error instanceof StaticSlotReadError ? error.record : "slot-or-head", operation: "read" },
              ]);
            }
            // A retired row affirms that no agent exists now, so it keeps the old `not-found`
            // result. The changed refusal is reserved for durable NONTERMINAL state that contradicts
            // the live-map miss and needs operator attention.
            //
            // A sibling's nonterminal row is not a contradiction: the name belongs to another
            // manager instance in this space. In a multi-manager space the class queue hands this
            // read to either instance, so a plain `not-found` here read the same as a name that
            // exists nowhere and a caller had no way to tell the two apart (#443).
            if (observed?.ownerInstanceId !== undefined)
              throw new EpEnvelopeError("failed-precondition", `the durable slot for "${name}" belongs to manager instance ${observed.ownerInstanceId}, not ${this.managerInstanceId} which answered; only that instance can act on it ${renderStaticSlotObservation(observed)}`, [observed]);
            if (observed !== undefined && observed.slotPhase !== "retired")
              throw new EpEnvelopeError("failed-precondition", `no live agent "${name}"; durable state contradicts absence ${renderStaticSlotObservation(observed)}`, [observed]);
          }
          throw new EpEnvelopeError("not-found", `no agent "${name}"`, undefined, "not-executed");
        }
        return row;
      }),
      slots: (ctx) => this.serveGated(ctx, async () => {
        // No manager-local durable static slot store exists for a user-mode or open manager: an
        // empty list here would claim nothing is stranded from a store that was never consulted,
        // the very ambiguity #1274 is about.
        if (!this.auth || this.userMode)
          throw new EpEnvelopeError("failed-precondition", "user-mode and open managers own no durable static slot rows; the projection is static-manager local");
        const recordsKv = this.goalWriter?.ctx.kv;
        if (!recordsKv)
          throw new EpEnvelopeError("unavailable", "the durable static slot store is not ready", [
            { kind: STATIC_SLOT_READ_FAILED_DETAIL, name: "*", record: "slot", operation: "scan" },
          ]);
        let observed;
        try {
          const query = args(ctx);
          observed = await listStaticSlotObservations(recordsKv, DEV_OWNER, this.managerInstanceId, {
            ...(query.names === undefined ? {} : { names: query.names as string[] }),
            ...(query.includeRetired === true ? { includeRetired: true } : {}),
          });
        } catch (error) {
          throw new EpEnvelopeError("unavailable", `the durable static slot state could not be scanned: ${rejectionText(error)}`, [
            { kind: STATIC_SLOT_READ_FAILED_DETAIL, name: "*", record: error instanceof StaticSlotReadError ? error.record : "slot-or-head", operation: "scan" },
          ]);
        }
        return observed.map(({ kind: _kind, ...detail }) => ({
          ...detail,
          live: this.agents.has(detail.name),
          managerInstanceId: this.managerInstanceId,
        }));
      }),
      models: (ctx) => this.serveGated(ctx, async () => {
        const data = unwrap(await this.opModels(args(ctx)));
        return { catalogs: Array.isArray(data) ? data : [data] };
      }),
      goalResult: (ctx) => this.serveGated(ctx, async () => {
        const gw = this.goalWriter;
        if (!gw || gw.nc.isClosed()) throw new EpEnvelopeError("unavailable", "the manager goal-reader connection is not standing; the accepted goal is unaffected");
        const goalId = args(ctx).goalId as string;
        // Only the broker-authenticated caller's full incarnation can name this read. The
        // trusted goal-writer keeps the raw EPF authority; serveEndpoint derives the reply rail.
        const result = await readGoalResult(gw.ctx, goalRefOf(ctx.subject, goalId));
        return { goalId, ...(result === undefined ? {} : { result }) };
      }),
      listDir: (ctx) => this.serveGated(ctx, () => this.listSpawnDirectory(args(ctx))),
      resolveCwd: (ctx) => this.serveGated(ctx, () => this.resolveSpawnCwd(args(ctx).cwd)),
      resolveAgent: (ctx) => this.serveGated(ctx, async () => {
        if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
        const persona = await this.spawnPersona(args(ctx) as Pick<StartAgentOpts, "name" | "config" | "agent" | "defaultAgent">, callerOf(ctx), ctx.subject.caller);
        if ("error" in persona) throw new EpEnvelopeError(persona.code ?? (persona.error.startsWith("no persona") ? "not-found" : "failed-precondition"), persona.error);
        return { agent: persona.agent };
      }),
      // `spawn` is an ACTION - accept a goal + reply the acceptance floor payload, drive
      // progress + terminal off-handler (no ~30s block). The blocking reply path is gone.
      // #373: arming the event plane (events: true, or the omission that arms it by default)
      // follows owner-domain reach on a user mesh. Resolve the caller's admin tier once for
      // the residual cross-owner case; opStart decides before connector resolution or grant
      // mutation. Static meshes resolve true and nothing changes.
      spawn: (ctx) => this.loggedSpawnRefusal(ctx, () => this.serveGated(ctx, async () => this.serveSpawnGoal(ctx, async (h) => this.opStart(args(ctx), callerOf(ctx), await this.epAdminReach(ctx.subject.caller), h, ctx.subject.route, ctx.subject.caller, servedRequestSubject(this.space, ctx))))),
      despawn: (ctx) => this.serveGated(ctx, async () => {
        const a = targetAgent(ctx);
        const denied = await this.authorizeNamed(a, callerOf(ctx), await this.epAnyModeAdmin(ctx), ctx.subject.caller);
        if (denied) throw new EpEnvelopeError("permission-denied", denied, undefined, "not-executed");
        return unwrap(await this.despawnAuthorized(a, args(ctx).graceful !== false, true, callerOf(ctx)));
      }),
      attach: (ctx) => this.serveGated(ctx, async () => {
        const a = targetAgent(ctx);
        const denied = await this.authorizeNamed(a, callerOf(ctx), await this.epAnyModeAdmin(ctx), ctx.subject.caller);
        if (denied) throw new EpEnvelopeError("permission-denied", denied, undefined, "not-executed");
        return unwrap(await this.attachAuthorized(a, ctx.subject.caller));
      }),
      // C3 `input`: the SAME authorization as `attach`, deliberately written out rather than
      // factored with it - the two share a policy, not a body, and a shared wrapper would be a
      // place for one of them to quietly acquire a condition the other does not have.
      input: (ctx) => this.serveGated(ctx, async () => {
        const a = targetAgent(ctx);
        const denied = await this.authorizeNamed(a, callerOf(ctx), await this.epAnyModeAdmin(ctx), ctx.subject.caller);
        if (denied) throw new EpEnvelopeError("permission-denied", denied, undefined, "not-executed");
        return this.inputAuthorized(a, args(ctx));
      }),
      // The turn relay (§8 durable actions): `turn` shares despawn/input's reach policy — the
      // caller must hold owner-equality or admin over the TARGET seat — written out for the same
      // reason `input` is (a shared policy, not a shared body).
      turn: (ctx) => this.serveGated(ctx, async () => {
        const target = this.turnTarget(ctx);
        if (target.kind === "managed") {
          const denied = await this.authorizeNamed(target.agent, callerOf(ctx), await this.epAnyModeAdmin(ctx), ctx.subject.caller);
          if (denied) throw new EpEnvelopeError("permission-denied", denied, undefined, "not-executed");
        } else {
          const admitted = this.runHosting?.admittedCaller(ctx.subject.caller);
          if (!admitted || admitted.owner !== target.participant.owner || admitted.actor !== target.participant.actor || admitted.uid !== target.participant.uid)
            throw new EpEnvelopeError("permission-denied", "a personal participant may be turned only by the workflow run admitted for that exact owner, actor and lifecycle", undefined, "not-executed");
          if (!this.remoteAuthority?.authorizeParticipation)
            throw new EpEnvelopeError("unimplemented", "the issuing host supplies no closed personal participation authorization", undefined, "not-executed");
          const authorized = await this.remoteAuthority.authorizeParticipation({
            owner: target.participant.owner,
            actor: target.participant.actor,
            lifecycleUid: target.participant.uid,
          });
          if (!authorized) {
            this.participants.delete(participantKey(target.participant.owner, target.participant.actor, target.participant.uid));
            throw new EpEnvelopeError("permission-denied", "the exact personal lifecycle is no longer foreground-authorized with run scope", undefined, "not-executed");
          }
        }
        return this.serveTurnGoal(ctx, target);
      }),
      // A personal native lifecycle must opt in explicitly. The command is self-targeted and returns
      // only a finite relay lease. It never inserts a ManagedAgent or grants stop/attach/input custody.
      turnParticipate: (ctx) => this.serveGated(ctx, () => this.serveTurnParticipation(ctx.subject.caller)),
      // The seat's own half of the relay (`manager.self`, stop-self's tier): a seat pulls the
      // turns addressed to ITS incarnation and yields them; no reach beyond itself exists here.
      turnPending: (ctx) => this.serveGated(ctx, () => this.turnPendingFor(ctx.subject.caller)),
      turnYield: (ctx) => this.serveGated(ctx, () => this.serveTurnYield(ctx.subject.caller, args(ctx))),
      turnUnconfirmed: (ctx) => this.serveGated(ctx, () => this.serveTurnUnconfirmed(ctx.subject.caller, args(ctx))),
      // The reserved goal cancel (SPEC 13.6 item 4), served for the relay: the goal ref is the
      // authenticated caller's own, so a run withdraws only the turns it submitted.
      cancel: (ctx) => this.serveGated(ctx, () => this.serveTurnCancel(ctx)),
      stopSelf: (ctx) => this.serveGated(ctx, async () => unwrap(await this.opStopSelf(callerOf(ctx), args(ctx)))),
      definePersona: (ctx) => this.serveGated(ctx, async () => unwrap(await this.opDefinePersona(args(ctx), callerOf(ctx), false, ctx.subject.caller))),
      removePersona: (ctx) => this.serveGated(ctx, () => {
        const r = this.opRemovePersona(args(ctx), callerOf(ctx), false);
        if (!r.ok) throw new EpEnvelopeError((r.code ?? "failed-precondition") as EpErrorCode, r.error ?? "the operation failed", r.details, "not-executed");
        return r.data;
      }),
      // Reach is the broker's: only operator instruments carry these rows. The serve gate is the
      // maintenance fence, so neither runs while a shutdown or resume holds control.
      chatSessionOpen: (ctx) => this.serveGated(ctx, () => this.openStaticChatSession(args(ctx))),
      chatSessionRetire: (ctx) => this.serveGated(ctx, () => this.retireStaticChatSession(args(ctx))),
      listPersonas: (ctx) => this.serveGated(ctx, () => unwrap(this.opListPersonas(callerOf(ctx), false))),
      showPersona: (ctx) => this.serveGated(ctx, () => {
        const r = this.opShowPersona(args(ctx), callerOf(ctx), false);
        if (!r.ok) {
          const msg = r.error ?? "not found";
          if (msg.startsWith("no persona")) throw new EpEnvelopeError("not-found", msg);
          throw new EpEnvelopeError("failed-precondition", msg);
        }
        return r.data;
      }),
      purge: (ctx) => this.serveGated(ctx, () => adminGated(ctx, async () => unwrap(await this.opPurge(args(ctx), callerOf(ctx))))),
      // launch is OWNER-EQUALITY on the ep door for every caller: the deploy
      // path is the only launch consumer and its spec stamps the CALLER's own owner, so
      // owner-equality always holds for a legitimate deploy; cross-owner launch was a ctl
      // admin-tier INCIDENTAL never exercised by a real flow (static is single-owner, so the flag
      // is a no-op there). Keying admin on epAdminReach read the ACTOR's ledger scope, which does
      // NOT reflect the deployer VIEW's privileged-tier attenuation - an admin user's stolen
      // deployer bearer would then bypass owner-equality (operator launch) despite the view holding
      // no admin rows. Uniform owner-equality removes that divergence in the least-privilege
      // direction.
      // Manifest `launch` is an ACTION through the SAME chokepoint as spawn -
      // the manifest resolve + owner-equality authz run in opLaunch's accept path, then the goal
      // drives progress + terminal. The acceptance floor is the allocated identity + goal coords.
      launch: (ctx) => this.serveGated(ctx, () => this.serveSpawnGoal(ctx, (h) => this.opLaunch(args(ctx), callerOf(ctx), false, h, ctx.subject.route))),
      resumePreserved: (ctx) => adminGated(ctx, async () => unwrap(await this.opResumePreserved(args(ctx)))),
      commitResume: (ctx) => adminGated(ctx, async () => unwrap(await this.opCommitResume(args(ctx)))),
      finalizeResume: (ctx) => adminGated(ctx, async () => unwrap(await this.opFinalizeResume(args(ctx)))),
      // The workflow-run family (SPEC 14.3): the manager hosts the driver. Reach is the broker's
      // (`run` capability / privileged instrument rows); the serve gate is the maintenance fence.
      runStart: (ctx) => this.serveGated(ctx, () => this.runHost().start(ctx, args(ctx) as { source: string; file?: string; timeout?: string })),
      runStartKeyed: (ctx) => this.serveGated(ctx, () => this.runHost().startKeyed(ctx, args(ctx) as { source: string; file?: string; timeout?: string })),
      runSubmissionStatus: (ctx) => this.serveGated(ctx, () => this.runHost().submissionStatus(ctx, String(args(ctx).submissionId))),
      runResume: (ctx) => this.serveGated(ctx, () => this.runHost().resume(args(ctx) as { runId: string; timeout?: string }, ctx)),
      runCancel: (ctx) => {
        const host = this.runHost();
        host.validateCancellation(ctx, args(ctx));
        return this.serveGated(ctx, () => host.cancel(ctx, args(ctx)));
      },
      runAnswer: (ctx) => this.serveGated(ctx, () => {
        const input = args(ctx) as { runId: string; endpoint?: string; stepKey: string; value?: unknown; artifact?: string; amend?: boolean };
        if (input.amend === true)
          return this.runHost().amend(input, this.runAnswerer(ctx), (accepted) => this.authorizeRunAmend(ctx, accepted), ctx);
        return this.runHost().answer(input, this.runAnswerer(ctx), (open) => this.authorizeRunAnswer(ctx, input, open), ctx);
      }),
      runStatus: (ctx) => this.serveGated(ctx, () => this.runHost().status(args(ctx) as { runId: string; endpoint?: string; journal?: { offset: number } }, ctx)),
      runPs: (ctx) => this.serveGated(ctx, () => this.runHost().list(args(ctx) as { endpoint?: string; page?: { limit?: number; cursor?: string } }, ctx)),
      preparePreservation: (ctx) => adminGated(ctx, async () => unwrap(await this.opPreservationCtl("preparePreservation", args(ctx)))),
      commitPreservation: (ctx) => adminGated(ctx, async () => unwrap(await this.opPreservationCtl("commitPreservation", args(ctx)))),
      abortPreservation: (ctx) => adminGated(ctx, async () => unwrap(await this.opPreservationCtl("abortPreservation", args(ctx)))),
      transcriptReceive: (ctx) => this.serveGated(ctx, () => adminGated(ctx, () => {
        if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
        if (!this.transcripts)
          throw new EpEnvelopeError("failed-precondition", "transcript-receive: this manager does not receive carried transcripts (its remote authority issues no transfer reader)");
        return this.transcripts.receive(args(ctx) as unknown as TranscriptReceiveInput);
      })),
    });
  }

  private async commitResumeActivation(attemptId: string): Promise<ControlReply> {
    if (!this.resumeAwaitingCommit || !this.resumeResult?.ok)
      return { ok: false, error: `resume attempt ${attemptId} has no successful activation to commit` };
    const inventory = this.resumeInventory;
    if (!inventory)
      return { ok: false, error: `resume attempt ${attemptId} has no bound inventory` };
    const authority = await Promise.all(inventory.agents.map(async (entry) => {
      try {
        await this.validateRetainedAuthority(entry);
        return undefined;
      } catch (e) {
        return `${entry.name}: ${rejectionText(e)}`;
      }
    }));
    const drift = authority.filter((error): error is string => error !== undefined);
    if (drift.length)
      return { ok: false, error: `resume attempt ${attemptId} retained authority changed before commit: ${drift.join("; ")}` };
    let inactive: string[];
    try {
      inactive = this.resumeLivenessErrors(inventory, this.ep.getRoster());
    } catch (e) {
      return { ok: false, error: `resume attempt ${attemptId} cannot verify live principals: ${rejectionText(e)}` };
    }
    if (inactive.length)
      return { ok: false, error: `resume attempt ${attemptId} is not live at commit: ${inactive.join("; ")}` };
    this.resumeAwaitingCommit = false;
    this.resumeCommitted = true;
    this.resumeDurableCommitToken ??= randomBytes(32).toString("hex");
    return {
      ok: true,
      data: { attemptId, state: "awaitingFinalize", durableCommitToken: this.resumeDurableCommitToken },
    };
  }

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
  private async authorizeNamed(target: ManagedAgent, caller: string, admin: boolean, epCaller?: EpCaller): Promise<string | undefined> {
    if (this.remoteAuthority && epCaller && !admin) {
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
        resolveAuthProvider().actorScope({ dir: userAuthStateDir(this.workspaceRoot, this.space), owner, actor }),
    });
  }

  /** The wire PRINCIPAL dot-form a managed agent's presence/control identity carries: user-mode
   *  entries already store it in `id`; static mints store the raw nkey there (the durable/teardown
   *  key), so the wire form derives under DEV_OWNER. Every comparison against an AUTHENTICATED wire
   *  id (presence card.id, control from.id) must go through this, never raw `a.id`. */
  private managedPrincipal(a: { id: string; userOwner?: string }): string {
    return a.userOwner ? a.id : principalKey(DEV_OWNER, a.id).key;
  }

  private resumeLivenessErrors(inventory: ManagerResumeInventory, roster: Presence[]): string[] {
    const inactive: string[] = [];
    const expectedNames = new Set(inventory.agents.map((entry) => entry.name));
    for (const name of this.resumedAgentNames)
      if (!expectedNames.has(name)) inactive.push(`${name} is not part of the bound inventory`);
    for (const entry of inventory.agents) {
      const managed = this.agents.get(entry.name);
      if (!managed) {
        inactive.push(`${entry.name} is no longer managed`);
        continue;
      }
      const expectedId = entry.identity.mode === "user"
        ? principalKey(entry.identity.owner, entry.identity.actor).key
        : entry.identity.id;
      const expectedPrincipal = entry.identity.mode === "user"
        ? expectedId
        : principalKey(DEV_OWNER, entry.identity.id).key;
      if (managed.id !== expectedId || this.managedPrincipal(managed) !== expectedPrincipal) {
        inactive.push(`${entry.name} no longer holds retained principal ${expectedPrincipal}`);
        continue;
      }
      // The late paths (commit/finalize) must prove the SAME incarnation the incarnation-exact
      // readiness fence proved (§13.1): a principal-only match lets a wrong/absent-uid presence under
      // the reused alias satisfy commit/finalize after a readiness timeout, undoing the fence.
      if (managed.lifecycleUid !== entry.identity.lifecycleUid) {
        inactive.push(`${entry.name} manager metadata incarnation ${managed.lifecycleUid} drifted from the inventory's ${entry.identity.lifecycleUid}`);
        continue;
      }
      if (managed.handle.name !== entry.name || managed.handle.kind !== entry.launch.runtime) {
        inactive.push(`${entry.name} is not attached to its exact retained ${entry.launch.runtime} handle`);
        continue;
      }
      try {
        if (managed.handle.status() !== "running") {
          inactive.push(`${entry.name} runtime is not running`);
          continue;
        }
      } catch (e) {
        inactive.push(`${entry.name} runtime status failed: ${rejectionText(e)}`);
        continue;
      }
      if (!roster.some((presence) =>
        presence.card.id === expectedPrincipal && presence.card.name === entry.name && presence.status !== "offline" &&
        presence.lifecycleUid === entry.identity.lifecycleUid))
        inactive.push(`${entry.name} incarnation ${entry.identity.lifecycleUid} (principal ${expectedPrincipal}) is not exactly present`);
    }
    return inactive;
  }

  /** Self-despawn (P2b): stop the managed agent whose id == the authenticated caller. The
   *  no-name self-op can only ever resolve to the caller's OWN managed entry (ids are unique
   *  per spawn + non-forgeable in auth mode), never a peer — so it's structurally incapable of
   *  hitting another agent. Non-managed callers (human CLI, the manager itself, observers) find
   *  no match and get a loud error, not a silent no-op. */
  private opStopSelf(callerId: string, args: Record<string, unknown>): ControlReply | Promise<ControlReply> {
    if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    const target = [...this.agents.values()].find((a) => this.managedPrincipal(a) === callerId);
    if (!target) return { ok: false, error: `self-stop: caller ${callerId} is not a managed agent` };
    const graceful = args.graceful !== false;
    if (process.platform === "win32" && target.handle.kind === "pty") {
      return this.stopWindowsSeat(target, graceful, true, { kind: "stopped-self" }).then(() => ({ ok: true, data: { name: target.name, stopped: true, graceful } }));
    }
    this.stopHandle(target, graceful, { kind: "stopped-self" });
    this.trackStoppedHandle(target, true, { kind: "stopped-self" });
    return { ok: true, data: { name: target.name, stopped: true, graceful } };
  }

  // Plane-3 durable join/leave/list ops moved OFF the manager onto the server-side delivery daemon's
  // `ctl.delivery` control service (endpoint.startPlane3 → handleDeliveryControl). The manager is
  // lifecycle-only; it records each agent's read ACL at spawn (commitAcl) so the daemon can validate
  // those ops against the durable ACL registry — the single source of truth, no in-memory ledger.

  /** Tear an agent down — the single chokepoint for every stop path (despawn, self-stop, reap). On
   *  Windows a graceful stop can't ride a signal (ConPTY delivers none, so the agent never runs its
   *  exit handlers / leaves the mesh), so first send a cooperative `{op:"shutdown"}` over its authed
   *  control endpoint; the agent exits cleanly and the runtime hard-kills as a fallback after its
   *  grace window. POSIX delivers SIGTERM→SIGKILL natively, so it keeps the signal path. A hard stop
   *  (`graceful:false`, e.g. emergency reap) skips the cooperative step on every platform.
   *
   *  Never throws (#159 B2): a runtime hard-stop CAN throw (tmux `closeWindow` / cmux `closeWorkspace`
   *  are direct calls), and a throwing stop must not abort a caller's cleanup and leak the agent's
   *  footprint, nor (in `reapChildrenOf`) abort the reap of later siblings. The failure is logged and
   *  returned: a caller that must prove exit (shutdown, a failed resume) reports it as the cause at
   *  once instead of waiting out a stop the runtime already refused. */
  private stopHandle(a: ManagedAgent, graceful: boolean, cause: FreeSlotCause): string | undefined {
    // The TERMINALIZING latch: flipped SYNCHRONOUSLY, before any await anywhere on
    // this stop path — later renewals refuse, while an already-admitted renewal drains before the
    // durable terminal begins.
    a.terminalizing = true;
    a.stopCause ??= cause;
    try {
      // A delegated seat's close runs only inside its retirement, after the host revoked its grant,
      // so stopping it starts that retirement. Every exit wait on a stop path then settles on that
      // close; the free path's own teardown joins the same flight.
      if (a.handedOff) this.trackDeprovision(this.teardownTarget(a));
      else a.handle.stop({ graceful });
      // The runtime captured its cohort synchronously before the cooperative
      // request can let a root exit and orphan its already-running children.
      if (graceful && process.platform === "win32" && a.control) controlShutdown(a.control);
    } catch (e) {
      const failure = rejectionText(e);
      console.error(`stop ${a.name} (${a.id}): ${failure}`);
      return failure;
    }
  }

  /** Windows PTY stops release their name only after the captured process cohort and PTY exited. */
  private async stopWindowsSeat(a: ManagedAgent, graceful: boolean, floor: boolean, cause: FreeSlotStopCause): Promise<void> {
    if (a.once) a.once.stopReason ??= onceStopReason(cause);
    const failure = this.stopHandle(a, graceful, cause);
    this.lifecycleInFlight++;
    try {
      if (failure !== undefined) throw new Error(failure);
      await this.awaitHandleExit(a.handle);
      this.unverifiedStops = this.unverifiedStops.filter((stopped) => stopped.handle !== a.handle);
      this.freeSlot(a, floor, cause, true);
    } catch (error) {
      const detail = `Windows stop could not prove the captured process tree exited: ${rejectionText(error)}`;
      this.unverifiedStops = this.unverifiedStops.filter((stopped) => stopped.handle !== a.handle);
      this.unverifiedStops.push({ name: a.name, id: a.id, handle: a.handle, authoritative: true, error: detail });
      throw new EpEnvelopeError("unavailable", detail, undefined, "unknown");
    } finally {
      this.releaseLifecycle();
    }
  }

  /** Keep an accepted stop inside the lifecycle drain until the runtime proves the child is gone,
   * so a maintenance prepare can never fence ahead of a child that is still dying. The `cause` is
   * the stop-family cause the door already knows (which door, and who asked); it rides every
   * freeSlot below so the reap line can say it.
   *
   * An operator-accepted stop frees its slot at once: `stop` replying ✓ means `ps` no longer lists
   * the agent. That cannot omit a still-live child from a cut, because runPreparation drains the
   * lifecycle BEFORE it reads the roster — the exit proof below is what closes the race, not the
   * slot lingering. A recursive reap (`requireAuthoritativeExit`) instead keeps the slot until the
   * wait proves exit: nobody asked for those children to be gone, so they stay managed until the
   * runtime says otherwise, and a runtime that cannot prove exit records an unverified stop. */
  private trackStoppedHandle(a: ManagedAgent, floor: boolean, cause: FreeSlotCause, requireAuthoritativeExit = false): void {
    if (process.platform === "win32" && a.handle.kind === "pty") requireAuthoritativeExit = true;
    // What a once seat's task is cancelled with if this stop ends it before the task has a terminal.
    if (a.once && typeof cause !== "string") a.once.stopReason ??= onceStopReason(cause);
    if (!a.handle.waitForExit) {
      // Preserve ordinary external-runtime stop behavior, but retain enough evidence for a later
      // maintenance prepare to fail if that runtime still cannot prove the surface disappeared.
      this.unverifiedStops.push({
        name: a.name,
        id: a.id,
        handle: a.handle,
        authoritative: requireAuthoritativeExit,
        error: requireAuthoritativeExit
          ? `recursive reap cannot prove exit on runtime "${a.handle.kind}" (AgentHandle.waitForExit is not implemented)`
          : undefined,
      });
      if (requireAuthoritativeExit) return;
      this.freeSlot(a, floor, cause, true);
      return;
    }
    if (!requireAuthoritativeExit) this.freeSlot(a, floor, cause, true);
    this.lifecycleInFlight++;
    void this.awaitHandleExit(a.handle)
      .then(() => {
        this.unverifiedStops = this.unverifiedStops.filter((stopped) => stopped.handle !== a.handle);
        this.freeSlot(a, floor, cause, true);
      }) // no-op once an accepted stop already freed it
      .catch((e) => {
        this.unverifiedStops = this.unverifiedStops.filter((stopped) => stopped.handle !== a.handle);
        this.unverifiedStops.push({
          name: a.name,
          id: a.id,
          handle: a.handle,
          authoritative: true,
          error: `accepted stop could not prove exit: ${rejectionText(e)}`,
        });
      })
      .finally(() => this.releaseLifecycle());
  }

  private servedSpawnRequest(served: string, caller: EpCaller | undefined): { served: string; runId?: string } { return this.userProvision.servedSpawnRequest(served, caller); }

  private provisionUserAgent(name: string, opts: ProvisionUserAgentOpts): Promise<ProvisionedUserAgent | UserAgentRefusal> { return this.userProvision.provisionUserAgent(name, opts); }

  /** Shred a user agent's secret family from the store and from disk. Every removal is attempted,
   *  and each failure joins `unshredded`, so one fault cannot leave the rest of the family behind. */
  private async shredUserSecrets(unshredded: CleanupFailure[], family: { actorToken?: string; sentinelCreds?: string; health?: string }): Promise<void> {
    for (const path of [family.actorToken, family.sentinelCreds])
      if (path) await attemptCleanup(unshredded, `secret ${path}`, () => this.secrets.delete(agentSecretKeyForFile(path, this.space)));
    for (const path of [family.actorToken, family.sentinelCreds, family.health])
      if (path) await attemptCleanup(unshredded, `file ${path}`, () => rmSync(path, { force: true }));
  }

  private delegatedMeshRecord(): MeshEntry & { userAuth: UserAuthInfo } { return this.userProvision.delegatedMeshRecord(); }

  private composeManagedHandoff(enrolled: ManagedEnrollment, actorToken: string): ManagedLifecycleHandoff { return this.userProvision.composeManagedHandoff(enrolled, actorToken); }

  /**
   * WHY A SEAT LEFT — one line, at the one place every free path passes through.
   *
   * A manager that had held twelve seats could not say why any of them had died: the log carried no
   * per-seat exit line at all, so "the supervisor reaped them" and "they died on their own" were
   * indistinguishable after the fact and the incident was unattributable. `freeSlot` is the single
   * chokepoint for despawn, self-stop, reap and exit, which is why the line lives here rather than
   * being remembered at each of the six callers.
   *
   * THE RUNTIME'S EXIT DETAIL IS OPTIONAL AND ITS ABSENCE IS SAID OUT LOUD. `AgentHandle.exitInfo`
   * is only implemented by backends that own the child process; the rest genuinely cannot see how
   * it ended. Printing `code 0` for those would be a fabricated clean exit on exactly the seats
   * whose death nobody can explain, so an absent answer prints as unavailable and names the runtime
   * that could not provide it.
   */
  private logSeatReaped(a: ManagedAgent, cause: FreeSlotCause): void {
    const causeText = typeof cause === "string" ? FREE_SLOT_CAUSE_TEXT[cause] : stopCauseText(cause);
    let detail: string;
    try {
      const info = a.handle.exitInfo?.();
      detail = info === undefined
        ? `exit detail unavailable from runtime "${a.handle.kind}"`
        : `exit code ${info.code ?? "unknown"}${info.signal === undefined ? "" : `, signal ${info.signal}`}${info.diagnostic ? `; diagnostic: ${info.diagnostic}` : ""}`;
    } catch (e) {
      // A runtime that throws while being asked has told us something real; it must not take the
      // log line (or the free path it sits on) down with it.
      detail = `exit detail unreadable from runtime "${a.handle.kind}": ${rejectionText(e)}`;
    }
    console.error(
      `seat reaped: ${a.name} (${a.id}, uid ${a.lifecycleUid}${a.handle.pid !== undefined ? `, pid ${a.handle.pid}` : ""}) - ${causeText}; ${detail}`,
    );
  }

  /**
   * A SEAT THAT LEAVES THE MESH WHILE ITS SLOT IS HELD GETS A LINE, AND SO DOES ITS RETURN.
   *
   * Seats once read `running · mesh offline` for many hours with no manager log line, so a watchdog
   * keyed on process liveness saw nothing wrong and nobody could say when each seat dropped (#1208).
   * The line follows the same state `ps` reads, checked on every roster change and view transition,
   * because not every offline record arrives as a presence event: after a reconnect the fresh snapshot
   * records an already-offline seat quietly. Only a current view is a verdict, so a stale or
   * unpopulated one logs nothing. The match is {@link isOwnPresence}. A seat being stopped is left to
   * the reap line. The heartbeat is the seat's own record and nothing validated it, so an unreadable
   * one prints as unknown instead of throwing inside the watch.
   */
  private logSeatMeshTransitions(): void {
    if (typeof this.ep.presenceView === "function" && this.ep.presenceView().state !== "current") return;
    const roster = new Map(this.ep.getRoster().map((p) => [p.card.id, p]));
    for (const a of this.agents.values()) {
      const seen = roster.get(this.managedPrincipal(a));
      if (a.terminalizing || !this.isOwnPresence(a, seen)) continue;
      if (seen.status !== "offline") a.joinIssue = undefined;
      const who = `${a.name} (${a.id}, uid ${a.lifecycleUid}${a.handle.pid !== undefined ? `, pid ${a.handle.pid}` : ""})`;
      if (seen.status === "offline" && !a.offMesh) {
        a.offMesh = true;
        const ts = seen.ts;
        const last = typeof ts === "number" && !Number.isNaN(new Date(ts).getTime()) ? new Date(ts).toISOString() : "unknown";
        console.error(`seat offline on the mesh: ${who} - last heartbeat ${last}; process ${a.handle.status()}`);
      } else if (seen.status !== "offline" && a.offMesh) {
        a.offMesh = false;
        console.error(`seat back on the mesh: ${who}`);
      }
    }
  }

  /** Whether a roster record is this seat's own: the readiness fence's exact principal and
   *  incarnation, so a same-named foreign peer or an older incarnation never speaks for it (#1208). */
  private isOwnPresence(a: ManagedAgent, p: Presence | undefined): p is Presence {
    return p !== undefined && p.card.id === this.managedPrincipal(a) && p.lifecycleUid === a.lifecycleUid;
  }
  private freeSlot(a: ManagedAgent, floor: boolean, cause: FreeSlotCause, acceptedBeforeFence = false): void { this.namesCapacity.freeSlot(a, floor, cause, acceptedBeforeFence); }

  /** Remove one lifecycle's inline snapshot by the path its uid derives, never by a recorded one, so a
   *  resume inventory cannot point the removal at another file. Returns whether the file is gone. A
   *  failure is logged, never thrown, because the callers must still schedule the teardown. */
  private dropInlineSnapshot(name: string, lifecycleUid: string): boolean {
    try {
      removeInlineSnapshot(this.workspaceRoot, lifecycleUid);
      return true;
    } catch (e) {
      console.error(`! ${name}: its inline persona snapshot could not be removed: ${rejectionText(e)}`);
      return false;
    }
  }

  /** A live agent's teardown target, built field by field so the rest of its record (handle, seed,
   *  restart state) never rides into the detached teardown or its single-flight map. */
  private teardownTarget(a: ManagedAgent): TeardownTarget {
    return { id: a.id, name: a.name, lifecycleUid: a.lifecycleUid, userOwner: a.userOwner, delegated: a.delegated, secretPaths: a.secretPaths, runtime: a.handle?.reference, ...(a.handedOff ? { delegatedHandle: a.handle } : {}), launch: { allowSubscribe: a.launch.allowSubscribe }, staticCredentialRenewal: a.staticCredentialRenewal };
  }
  private deprovision(a: TeardownTarget): Promise<void> { return this.retirement.deprovision(a); }

  /** Run one retirement in a {@link RETIREMENT_CONCURRENCY} slot, oldest first: a seat's deprovision, a
   *  chat session's terminal and a static reconcile's terminal all take one. No retirement awaits
   *  another, so the bounded pool cannot deadlock. */
  private async withRetirementSlot<T>(run: () => Promise<T>): Promise<T> {
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
  private confirmRetirement(a: { id: string; name: string; lifecycleUid: string }): void { this.retirement.confirmRetirement(a); }
  private deprovisionBroker(a: { id: string; name: string; lifecycleUid: string; launch?: { allowSubscribe: readonly string[] } }): Promise<DeprovisionResourceAccounting> { return this.retirement.deprovisionBroker(a); }

  /** Narrow the retiring lifecycle's read-ACL row to no reads ({@link fenceLifecycleAcl}) through a
   *  `deprovisioner` credential pinned to it. Returns undefined once fenced, or the reason it was not. */
  private async fenceRetiringAcl(a: { id: string; lifecycleUid: string }): Promise<string | undefined> {
    try {
      const creds = await mintCreds(this.auth!, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: a.id, lifecycleUid: a.lifecycleUid, memberChannels: [] } });
      await withTimeout(
        fenceLifecycleAcl({ servers: this.servers ?? DEFAULT_SERVER, space: this.space, targetId: a.id, lifecycleUid: a.lifecycleUid, creds }),
        DEPROVISION_TIMEOUT_MS,
        `fence ${a.id}: the ACL fence timed out`,
      );
      return undefined;
    } catch (e) {
      return rejectionText(e);
    }
  }

  /** The retiring lifecycle's durable membership channels, read from the delivery daemon's
   *  `lifecycleMemberships` admin verb (read-only, lifecycle-exact). Incomplete on any refusal. */
  private async lifecycleMembershipInventory(a: { id: string; lifecycleUid: string }): Promise<{ complete: boolean; channels: string[]; reason?: string }> {
    const t = deprovisionTargetPrincipal({ principal: a.id, lifecycleUid: a.lifecycleUid });
    try {
      const r = await this.ep.requestDeliveryAdmin("lifecycleMemberships", { principal: principalKey(t.owner, t.actor).key, lifecycleUid: t.lifecycleUid }, 5_000);
      const data = r.data as { complete?: unknown; channels?: unknown } | undefined;
      if (!r.ok || data?.complete !== true || !Array.isArray(data.channels) || !data.channels.every((c) => typeof c === "string" && (isConcreteChannel(c) || isChannelFamily(c))))
        return { complete: false, channels: [], reason: r.ok ? "malformed inventory reply" : (r.error ?? "refused") };
      return { complete: true, channels: data.channels as string[] };
    } catch (e) {
      return { complete: false, channels: [], reason: rejectionText(e) };
    }
  }

  /** Reap a parent's children on its exit (P4b). Every descendant remains managed until the runtime's
   * authoritative wait proves exit; the wait participates in the lifecycle drain, so preservation can
   * never omit a child that may still be alive. Recursive descendants are scheduled before their parent
   * slot can disappear. */
  private reapChildrenOf(parentId: string): void {
    for (const child of [...this.agents.values()]) {
      if (child.spawner !== parentId) continue;
      this.reapChildrenOf(this.managedPrincipal(child));
      const cause = { kind: "stopped-reap", parent: parentId } as const;
      this.stopHandle(child, false, cause);
      this.trackStoppedHandle(child, true, cause, true);
    }
  }

  private readManagedSessionState(a: ManagedAgent): | { sessionId: string; status: "running" | "quit" }
    | { connector: string; status: "prompt"; prompt: string; cwd: string } {
    return this.sessionRecovery.readManagedSessionState(a);
  }

  private retainedSessionId(entry: ManagerResumeAgent, connector: Connector): string | undefined {
    return this.sessionRecovery.retainedSessionId(entry, connector);
  }

  private forkProvenance(a: ManagedAgent): ForkProvenance | undefined {
    return this.sessionRecovery.forkProvenance(a);
  }

  private refuseCarriedFork(a: ManagedAgent, timeoutMs: number): Promise<string | undefined> {
    return this.sessionRecovery.refuseCarriedFork(a, timeoutMs);
  }

  private refuseLateCarriedFork(a: ManagedAgent, timeoutMs: number): Promise<void> {
    return this.sessionRecovery.refuseLateCarriedFork(a, timeoutMs);
  }

  private readManagedSession(a: ManagedAgent): string {
    return this.sessionRecovery.readManagedSession(a);
  }

  private recordContinuity(a: ManagedAgent, sessionId: string): void {
    return this.sessionRecovery.recordContinuity(a, sessionId);
  }

  private recordContinuityAtStop(a: ManagedAgent, boundary: string): void {
    return this.sessionRecovery.recordContinuityAtStop(a, boundary);
  }

  private armSessionRecovery(a: ManagedAgent): Promise<void> {
    return this.sessionRecovery.armSessionRecovery(a);
  }

  /** Why an inline seat's snapshot no longer matches its launch, or `undefined` when it does or the
   *  seat is not inline. The recorded path and the relaunch's path must both be this lifecycle's
   *  snapshot path, as the resume cut requires, and the file there must still be a private regular
   *  file with the recorded digest. */
  private inlineSnapshotChange(a: ManagedAgent): string | undefined {
    const source = a.launch.source;
    if (source.kind !== "inline") return undefined;
    const path = resolve(inlineSnapshotPath(this.workspaceRoot, a.lifecycleUid));
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

  private recoverManagedSession(a: ManagedAgent): void {
    return this.sessionRecovery.recoverManagedSession(a);
  }

  /** A managed agent's process exited: on its own (crash, /exit, finished), or after a stop this
   *  manager started, whose recorded cause then frees the slot. Continuation-capable Pi seats
   *  restart in place after readiness; a spawn carrying `supervise` restarts any connector the same
   *  way, without classifying a session-state file. Every other exit follows the existing terminal
   *  path. */
  private onAgentExit(a: ManagedAgent): void {
    // Preservation owns the child-stop snapshot. Exit watchers must neither delete that snapshot nor
    // trigger normal deprovision/reap while the cut is being formed.
    if (this.maintenanceState !== "active") return;
    // A Windows stop owns the exit proof and its truthful reap cause. The raw
    // terminal event must not release a slot while cohort verification is pending.
    if (process.platform === "win32" && a.handle.kind === "pty" && a.terminalizing) return;
    // A replacement is proving readiness under this row. Its own wait owns a failed
    // relaunch; treating that exit as a seat death would free the slot mid-recovery.
    if (a.restart?.recovering && !a.terminalizing) return;
    if (a.restart?.armed && !a.terminalizing) {
      if (a.restart.policy !== undefined) {
        this.recoverManagedSession(a);
        return;
      }
      try {
        if (this.readManagedSessionState(a).status === "running") {
          this.recoverManagedSession(a);
          return;
        }
      } catch (error) {
        console.error(`! ${a.name}: cannot classify Pi process exit for recovery: ${rejectionText(error)} - retiring the seat`);
      }
    }
    this.freeSlot(a, true, a.stopCause ?? "process-exit");
    this.reapChildrenOf(this.managedPrincipal(a));
  }
  private nameError(name: string): string | undefined { return this.namesCapacity.nameError(name); }
  private nameInUse(name: string, live?: Set<string>): boolean { return this.namesCapacity.nameInUse(name, live); }
  private uniqueName(base: string, unavailable: ReadonlySet<string> = new Set()): string { return this.namesCapacity.uniqueName(base, unavailable); }

  /** Spawn a teammate by persona ref (`name` loads `.cotal/agents/<name>.md`; the peer presents
   *  under that file's own `name:`), as if a peer asked via the control plane. Used to pre-spawn the
   *  demo's experts at startup so the manager owns them. */
  async startByName(name: string): Promise<ControlReply> {
    return this.startAgent({ name });
  }

  /** Resolve once `name` shows up on the mesh roster (presence registered), or after `timeoutMs`.
   *  Lets the pre-spawn loop stagger heavy agent cold-starts so they don't all boot at once.
   *  Best-effort, keyed on the manager-owned (auto-numbered, unique) spawn name — NOT identity
   *  resolution: a same-named *unmanaged* peer already present could satisfy this early. That's
   *  acceptable for cold-start staggering; it never routes anything. */
  async waitForPresence(name: string, timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.ep.getRoster().some((p) => p.card.name === name)) return true;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return false;
  }

  /** Parse a served `spawn` request into {@link StartAgentOpts}. The compiled spawn input contract
   *  is the shape check: it already refused a non-mapping `launchOptions`, a `supervise` that is not
   *  the closed `{ restarts, windowMs }` pair, and a list on `subscribe`, `allowSubscribe`,
   *  `allowPublish`, `shareTools`, `join` or `callerAcl` that is not an array of strings. This reads
   *  those fields as admitted, the way it reads the string fields. The connector still validates the
   *  launch-option keys, and `startAgent` still refuses a supervise budget the seat record would not
   *  take. `once` is shape-checked by that same contract. Its omitted `deadlineMs` takes the default
   *  here, and a deadline past the scheduler's last instant is refused here, which the schema does
   *  not express. */
  private opStart(args: Record<string, unknown>, caller: string, admin: boolean, hooks?: SpawnHooks, route: "one" | "all" | "inst" = "inst", authenticatedCaller?: EpCaller, served?: string): Promise<ControlReply> {
    const supervise = args.supervise as { restarts: number; windowMs: number } | undefined;
    let once: StartAgentOpts["once"];
    if (args.once !== undefined) {
      const rec = args.once as { deadlineMs?: number };
      // The default is applied here, so every caller of the wire gets the same one.
      const d = rec.deadlineMs ?? ONCE_DEFAULT_DEADLINE_MS;
      if (d !== -1 && (typeof d !== "number" || !Number.isSafeInteger(d) || d < 1 || Date.now() + d > MAX_SCHEDULE_MS))
        return Promise.resolve({ ok: false, error: "once.deadlineMs: expected -1 (no deadline) or a positive whole number of milliseconds that ends by the deadline scheduler's last instant (the end of year 9999)" });
      once = { deadlineMs: d === -1 ? undefined : d };
    }
    const callerAcl = args.callerAcl as StartAgentOpts["callerAcl"];
    // #373: the event-plane admission gate. `startAgent` resolves `eventsRequired || opts.events
    // !== false`, so omission ARMS the plane — a gate on the explicit bit alone is bypassed by
    // omitting it. The gate is on the DECISION, and it runs before connector resolution and
    // before `startAgent` (which mints credentials), so a refusal provisions nothing.
    if (args.eventPayloads !== undefined && typeof args.eventPayloads !== "boolean")
      return Promise.resolve({ ok: false, error: "eventPayloads must be a boolean" });
    const requestedEvents = typeof args.events === "boolean" ? args.events : undefined;
    let eventsNotice: string | undefined;
    let events: boolean | undefined = requestedEvents;
    // Imperative spawns have no payload-selected owner. Local provisioning derives it from
    // the authenticated u_-owner caller; hosted enrollment fixes it to the manager's owner.
    // Match the same owner-domain boundary as authorizeNamed, without treating the spawn's
    // spawner relation as authority over a different owner's session.
    const callerOwner = parsePrincipalKey(caller)?.owner;
    const childOwner = this.remoteAuthority?.owner ?? (callerOwner?.startsWith("u_") ? callerOwner : undefined);
    const ownsChild = this.userMode && callerOwner !== undefined && callerOwner === childOwner;
    if (!admin && !ownsChild) {
      if (requestedEvents === true)
        return Promise.resolve({
          ok: false,
          error: `spawn is operator reach; the caller's current ledger grant does not carry "admin" (SPEC 13.2): events: arming the event plane needs the admin tier`,
        });
      if (this.eventsRequired)
        return Promise.resolve({
          ok: false,
          error: `spawn is operator reach; the caller's current ledger grant does not carry "admin" (SPEC 13.2): space "${this.space}" requires the event plane by registration policy, which cannot be met without the admin tier`,
        });
      // Omission arms by default in startAgent; serve it DISARMED and say so (never a silent
      // downgrade). An explicit `false` is already the opt-out — served as-is, no notice.
      if (requestedEvents === undefined) {
        events = false;
        eventsNotice = `event plane not armed: arming it on spawn needs the admin tier; the spawn was served with events: false`;
      }
    }
    return this.startAgent(
      {
        name: String(args.name ?? "").trim(),
        agent: args.agent as string | undefined,
        defaultAgent: args.defaultAgent as string | undefined,
        role: args.role as string | undefined,
        config: args.config as string | undefined,
        identity: args.identity as string | undefined,
        // Passed as sent: spawnPersona validates the record, the one place every door reads it.
        persona: args.persona as InlinePersona | undefined,
        ...(typeof args.runId === "string" ? { runId: args.runId } : {}),
        model: args.model as string | undefined,
        variant: args.variant as string | undefined,
        launchOptions: args.launchOptions as Record<string, unknown> | undefined,
        resume: args.resume as string | undefined,
        resumeClaim: args.resumeClaim as string | undefined,
        resumeAgent: args.resumeAgent as string | undefined,
        events,
        eventPayloads: args.eventPayloads as boolean | undefined,
        eventsNotice,
        cwd: args.cwd as string | undefined,
        prompt: args.prompt as string | undefined,
        subscribe: args.subscribe as string[] | undefined,
        allowSubscribe: args.allowSubscribe as string[] | undefined,
        allowPublish: args.allowPublish as string[] | undefined,
        join: args.join as string[] | undefined,
        callerAcl,
        shareTools: args.shareTools as string[] | undefined,
        ...(supervise !== undefined ? { supervise } : {}),
        ...(once !== undefined ? { once } : {}),
        ...(typeof args.runtime === "string" ? { runtime: args.runtime.trim() } : {}),
        route,
        ...(served !== undefined ? { served } : {}),
      },
      caller,
      hooks,
      authenticatedCaller,
    );
  }

  /** The realpath + directory checks a placed spawn directory must pass on this manager's host,
   * shared by the served `resolve-cwd` command and the `spawn` admission check (#385 item 2): one
   * function, so the two doors never drift. Creates nothing and never substitutes the workspace root. */
  private checkSpawnCwd(resolved: string): { cwd: string; host: string } | { refusal: string } {
    let cwd = resolved;
    try {
      cwd = realpathSync(resolved);
    } catch (error) {
      return { refusal: `path cannot be resolved: ${rejectionText(error)}` };
    }
    try {
      if (!statSync(cwd).isDirectory()) return { refusal: "path is not a directory" };
    } catch (error) {
      return { refusal: rejectionText(error) };
    }
    return { cwd, host: hostname() };
  }

  /** Refuse host directory reads before lookup when seats cannot use this host. */
  private assertHostDirectoryExecution(): void {
    if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    if (this.execution === "runtime" && this.requiredRuntime.spawnDelegated)
      throw new EpEnvelopeError("failed-precondition", `runtime "${this.requiredRuntime.kind}" starts seats outside this host, so it cannot resolve a directory on this host's filesystem (cwd); the seat runs in its runtime resource's own directory`);
  }

  private async listSpawnDirectory(args: Record<string, unknown>) {
    this.assertHostDirectoryExecution();
    const { cwd } = this.resolveSpawnCwd(args.path ?? homedir());
    try {
      return await listDirectory(cwd, args.includeHidden === true, typeof args.limit === "number" ? args.limit : 200);
    } catch (error) {
      throw new EpEnvelopeError("failed-precondition", `directory cannot be listed on this host: ${JSON.stringify(cwd)} (${rejectionText(error)})`);
    }
  }

  /** Resolve a placed spawn directory without creating or substituting a workspace. */
  private resolveSpawnCwd(value: unknown): { cwd: string; host: string } {
    this.assertHostDirectoryExecution();
    const asked = typeof value === "string" ? value : String(value ?? "");
    const refuse = (reason: string): never => {
      throw new EpEnvelopeError("failed-precondition", `cwd does not resolve on this host: ${JSON.stringify(asked)} (${reason})`);
    };
    if (!isAbsolute(asked)) refuse("expected an absolute path");
    const result = this.checkSpawnCwd(asked);
    if ("refusal" in result) return refuse(result.refusal);
    return result;
  }

  /** Resolve a connector by agent type. Library composition (installedExtensions off) → a registry
   *  hit, exactly as before (the composition root imported what it wants). The published binary gates
   *  on MANIFEST membership FIRST — so a live `cotal ext remove` is honored even though the registry
   *  still holds a connector imported earlier this session — then returns the registry hit or lazily
   *  imports the providing package (transactional + single-flight, via the workspace primitive).
   *  The captured Manager generation is checked for first-party providers under that lock,
   *  including providers already present in the registry.
   *  Fail-loud with an install hint; no fallback. */
  private async resolveConnector(name: string): Promise<Connector> {
    if (!this.installedExtensions) return registry.resolve<Connector>("connector", name);
    if (!manifestExtensionNames("connector").includes(name)) throw new Error(connectorInstallHint(name));
    return materializeFromManifest<Connector>({ kind: "connector", name }, { hint: (ref) => connectorInstallHint(ref.name), expectedGeneration: this.expectedConnectorGeneration });
  }

  /** Connector names the manager can spawn WITHOUT importing: the manifest on the published binary,
   *  else whatever a composition root registered. Drives the `models` catalog enumeration. */
  private connectorNames(): string[] {
    return this.installedExtensions ? manifestExtensionNames("connector") : registry.all<Connector>("connector").map((c) => c.name);
  }

  /** Resolve every installed/registered connector's declared harness binaries before the manager
   * reports ready. A missing harness degrades only that connector, never unrelated lifecycle work:
   * boot continues, names it once start completes and records it on both manager status surfaces. */
  private async inspectConnectorsAtBoot(): Promise<void> {
    this.bootNotes = [];
    if (this.execution === "none") { this.connectorStatuses = []; return; }
    const rows: ManagerConnectorStatus[] = [];
    let declared: Array<{ name: string; requires: readonly string[]; eventPlane: boolean; pkg?: string }>;
    if (this.installedExtensions) {
      try {
        declared = loadExtensionsManifest().extensions.flatMap((ext) => extensionConnectors(ext).map((connector) => ({ ...connector, pkg: ext.pkg })));
      } catch (error) {
        const reason = rejectionText(error);
        this.bootNotes.push(`! manager boot: connector inventory unavailable - ${reason}`);
        this.connectorStatuses = [{ agent: "(inventory)", state: "unavailable", binaries: {}, eventPlane: false, reason }];
        this.bootNotes.push("! manager: no agent application is available here, so a spawn without --on goes to another manager in this space");
        return;
      }
    } else {
      declared = registry.all<Connector>("connector").map((connector) => ({
        name: connector.name,
        requires: connector.requires ?? [],
        eventPlane: connector.eventChannel !== undefined,
      }));
    }
    this.connectorRequirements = new Map(declared.map(({ name, requires }) => [name, requires]));
    for (const { name, requires, eventPlane, pkg } of declared) {
      const { binaries, reason: missing } = resolveHarness(name, requires);
      let reason = missing;
      if (!reason && this.machineSetupCommand && name === "claude" && pkg === OFFICIAL_CONNECTORS.claude) {
        try {
          const connector = await this.resolveConnector(name);
          if (!connector.setup) throw new Error("Claude connector has no setup provider");
          const provider = await materializeFromManifest<ConnectorSetupProvider>(connector.setup, { expectedGeneration: this.expectedConnectorGeneration });
          if (!provider.connector) throw new Error("Claude connector has no install action");
          const cotal = bearerEntryArgv();
          cotal[cotal.length - 1] = logicalExecutionEntry() ?? cotal.at(-1)!;
          await provider.connector.run({ cotal, machineHost: true });
        } catch (error) {
          const detail = oneLine(rejectionText(error).replace(/eyJ[A-Za-z0-9_.-]*/g, "<redacted>").slice(0, 800));
          reason = `Claude wake channel setup failed: ${detail}. Correct the cause and run \`${this.machineSetupCommand}\` on this computer.`;
        }
      }
      if (reason) {
        rows.push({ agent: name, state: "unavailable", binaries, eventPlane, reason });
        this.bootNotes.push(`! manager boot: connector ${name} unavailable - ${reason}`);
      } else {
        rows.push({ agent: name, state: "available", binaries, eventPlane });
      }
    }
    this.connectorStatuses = rows.sort((a, b) => a.agent.localeCompare(b.agent));
    if (!this.classSpawnEnabled())
      this.bootNotes.push("! manager: no agent application is available here, so a spawn without --on goes to another manager in this space");
  }

  /** Retry missing applications on the Manager's PATH without changing resolved available rows. */
  private refreshUnavailableConnectors(name?: string): void {
    const wasEnabled = this.classSpawnEnabled();
    for (const row of this.connectorStatuses) {
      if (row.state !== "unavailable" || (name !== undefined && row.agent !== name)) continue;
      const requires = this.connectorRequirements.get(row.agent);
      if (!requires) continue;
      const { binaries, reason } = resolveHarness(row.agent, requires);
      row.binaries = binaries;
      if (reason) row.reason = reason;
      else {
        row.state = "available";
        delete row.reason;
      }
    }
    if (!wasEnabled && this.classSpawnEnabled()) this.servePlane.enableClassSpawn();
  }

  /** True when at least one declared connector is available. Empty inventory (or a failed
   *  inventory load) skips the class `one` subscribe for spawn/launch so this member cannot
   *  consume an unpinned request a sibling could serve. */
  private classSpawnEnabled(): boolean {
    if (this.execution === "none") return false;
    return this.connectorStatuses.some((row) => row.state === "available");
  }

  private omitClassCommands(): readonly string[] | undefined {
    return this.classSpawnEnabled() ? undefined : ["spawn", "launch"];
  }

  /** Named harness-unavailable refusal. On the class rail a partial inventory must not look
   *  like the space cannot launch: name `--on` so the caller can pin a sibling. The standing
   *  serve credential cannot enumerate sibling `svc.*.status` inventories, so the residual
   *  is the flag, not a list of capable instance ids. Instance-pinned calls keep the local
   *  reason only. */
  private harnessUnavailableError(reason: string, route: "one" | "all" | "inst"): string {
    if (route !== "one") return reason;
    return `${reason}. This manager cannot launch that harness. The space may have other managers; pin one with --on <instance> (the whole id, as ps prints it)`;
  }

  /** The harness binaries a managed launch runs, as boot resolved them, or the refusal naming what is
   *  missing. Spawn, resume and the model catalog all take it, so a seat launches from the same files
   *  whichever path starts it and the catalog never disagrees with a launch about whether the harness
   *  is there. Unavailable rows are checked again on PATH; available rows retain their resolved files.
   *  A connector registered after boot has no inventory row and is checked on PATH now. */
  private launchHarness(connector: Connector): { binaries?: Readonly<Record<string, string>> } | { refusal: string } {
    this.refreshUnavailableConnectors(connector.name);
    const row = this.connectorStatuses.find((status) => status.agent === connector.name);
    if (row?.state === "unavailable") return { refusal: row.reason ?? `${connector.name} harness is unavailable` };
    if (row) return { binaries: row.binaries };
    const { reason } = resolveHarness(connector.name, connector.requires ?? []);
    return reason ? { refusal: reason } : {};
  }

  /** The launch fields the host supplies rather than the seat. Spawn and resume both take them from
   *  here, so a resumed seat launches under the same host policy, `eventsRequired` included, as the
   *  same seat spawned fresh. The caller passes the cotal config it judged the launch by, so the
   *  servers and env allowlist come from the contents its checks read. */
  private hostLaunchFields(
    cotalConfig: CotalConfig,
    agent: string,
    shareTools: readonly string[] | undefined,
    harness: { binaries?: Readonly<Record<string, string>> },
  ): Pick<LaunchOpts, "space" | "servers" | "mcpServers" | "mcpServersExclusive" | "envAllow" | "resolvedBinaries" | "eventsRequired" | "eventPayloads" | "workspaceRoot"> {
    return {
      space: this.space,
      servers: this.servers,
      // Declared overrides plus the connector's native default, unless this spawn explicitly
      // restricts sharing. An empty selection is deliberate isolation, not the default.
      mcpServers: connectorServers(cotalConfig, agent, shareTools),
      mcpServersExclusive: shareTools !== undefined,
      // The operator's spawn-env policy travels the same route: absent means no extras (the OS
      // allow-list + operator knobs + connector-declared inputs), present means those names too.
      // A connector never reads the config itself.
      envAllow: spawnEnvAllow(cotalConfig),
      resolvedBinaries: harness.binaries,
      eventsRequired: this.eventsRequired,
      ...(this.eventPayloadsWithheld ? { eventPayloads: false } : {}),
      // So a connector that keeps per-agent local state can root it at the workspace, not the
      // (possibly per-agent) launch cwd.
      workspaceRoot: this.workspaceRoot,
    };
  }

  /** The refusal for a launch choice the connector cannot honour. Spawn and resume both ask before
   *  a seat's launch is built, so a rule changed here holds on both paths. */
  private capabilityRefusal(connector: Connector, launch: { variant?: string; prompt?: string; exact: boolean }): string | undefined {
    if (launch.variant && !connector.supportsModelVariant)
      return `${connector.name} connector does not support model variants (variant)`;
    if (launch.prompt !== undefined && !connector.supportsPrompt)
      return `${connector.name} connector does not support an initial prompt (prompt)`;
    if (launch.exact && (!connector.supportsSessionReopen || !connector.supportsSessionContinuation))
      return `${connector.name} connector does not support exact session continuity (continuity: exact)`;
    return undefined;
  }

  /** The refusal for a `once` spawn this manager cannot run as one task: every check is made before
   *  anything is allocated, so a refused spawn leaves nothing behind. */
  private onceRefusal(connector: Connector, runtime: Runtime, launch: Pick<StartAgentOpts, "once" | "supervise" | "launchOptions" | "prompt">, spawner: string | undefined, hooks: SpawnHooks | undefined): string | undefined {
    if (!hooks?.onOnce) return "once: a once task rides the spawn action, which this launch door is not";
    if (launch.prompt === undefined || launch.prompt.trim() === "") return "once: needs a prompt, which is the task";
    if (launch.supervise !== undefined) return "once: a once seat is never restarted, so it cannot carry supervise";
    if (!connector.supportsTurnRelay)
      return `once: the ${connector.name} connector cannot take a once task${connector.turnRelayRefusal ? `: ${connector.turnRelayRefusal}` : ""}`;
    if (connector.onceNeedsConfirmed !== undefined && !runtime.reportsStartupOutcome)
      return `once: runtime "${runtime.kind}" does not report how a seat's startup ended, which a once seat on the ${connector.name} connector needs`;
    if (runtime.spawnDelegated) return `once: runtime "${runtime.kind}" starts seats outside this host, where this manager cannot prove the seat's exit`;
    const operator = connector.waitsForOperator?.(launch.launchOptions);
    if (operator !== undefined) return `once: these launch options make the seat wait at ${operator} before it starts, so nothing could take its task`;
    // The task's relay record, measured with the widest deadline it could carry.
    const { note, payload } = onceTurnNote({
      prompt: launch.prompt, spawner: this.spawnerName(spawner),
      ...(launch.once!.deadlineMs !== undefined ? { deadlineAt: MAX_SCHEDULE_MS, holdToken: turnHoldToken("") } : {}),
      holdEpoch: this.serviceServe?.grant.epoch ?? 0,
      ...(connector.retireAfterExit ? { retire: connector.name } : {}),
      // The longest id token core accepts (endpoint-subjects `assertIdToken`).
      spawn: "x".repeat(64),
    });
    if (note.length > TURN_NOTE_MAX) return `once: the prompt is too long for one task (its relay record is ${note.length} characters, over ${TURN_NOTE_MAX})`;
    if (connector.turnFrameLimit !== undefined) {
      // The text the seat shows, rendered by the seat's own function with the widest values it could
      // carry: the task's goal id is a digest token, and a deadline renders as one ISO instant.
      const text = renderOnceTask({ goalId: digestIdToken("once"), payload, spawner: this.spawnerName(spawner), ...(launch.once!.deadlineMs !== undefined ? { deadlineAt: MAX_SCHEDULE_MS } : {}) });
      if (text.length > connector.turnFrameLimit)
        return `once: the prompt is too long for one ${connector.name} turn (the task renders to ${text.length} characters, over ${connector.turnFrameLimit})`;
    }
    return undefined;
  }

  /** How a once task names who sent it: the spawner's roster name, or its principal when that name is missing or only whitespace. */
  private spawnerName(spawner: string | undefined): string {
    const id = spawner ?? this.ep.ref().id;
    return shownSpawner(this.ep.getRoster().find((p) => p.card.id === id)?.card.name, id);
  }

  /** The refusal for an event-plane choice the registration policy or the connector cannot meet.
   *  Spawn and resume both ask before a seat's launch is built, so a seat retained without the
   *  plane cannot come back on a space that now requires it. An absent choice arms supported planes. */
  private eventsRefusal(connector: Connector, events: boolean | undefined): string | undefined {
    if (this.eventsRequired && events === false)
      return `space "${this.space}" requires the event plane by registration policy; --no-events (events: false on the start op) is not allowed`;
    if ((this.eventsRequired || events === true) && !connector.eventChannel)
      return this.eventsRequired
        ? `space "${this.space}" requires the event plane by registration policy, but connector "${connector.name}" does not publish one`
        : `connector "${connector.name}" does not publish an AG-UI event plane; omit --events to launch it without one`;
    return undefined;
  }

  /** Return connector-provided model catalogs for selector UIs. Optional by connector: a host with no
   *  local model-list API reports `supported:false` rather than blocking the manager. A connector that
   *  fails to import shows an `error:` row (from manifest enumeration) and never blocks the others. */
  private async opModels(args: Record<string, unknown>): Promise<ControlReply> {
    if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    const requested = String(args.agent ?? "").trim();
    const refresh = args.refresh === true;
    const one = async (connector: Connector): Promise<ConnectorModelCatalog> => {
      const harness = this.launchHarness(connector);
      if (!connector.listModels) return { agent: connector.name, supported: false, models: [] };
      if ("refusal" in harness) return { agent: connector.name, supported: true, models: [], error: harness.refusal };
      try {
        const catalog = await connector.listModels({ refresh, resolvedBinaries: harness.binaries });
        return { agent: connector.name, supported: catalog.unavailable === undefined, ...catalog };
      } catch (e) {
        return { agent: connector.name, supported: true, models: [], error: rejectionText(e) };
      }
    };

    if (requested) {
      let connector: Connector;
      try {
        connector = await this.resolveConnector(requested);
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
      const result = await one(connector);
      return result.error ? { ok: false, error: result.error } : { ok: true, data: result };
    }

    // Enumerate from the manifest (published binary) so a connector that fails to import still gets
    // a row — `registry.all` can't list one that never registered. Each resolves lazily; an import
    // failure becomes an `error:` catalog row and never blocks the healthy ones.
    const catalogs = await Promise.all(
      this.connectorNames().map(async (name): Promise<ConnectorModelCatalog> => {
        let connector: Connector;
        try {
          connector = await this.resolveConnector(name);
        } catch (e) {
          return { agent: name, supported: false, models: [], error: rejectionText(e) };
        }
        return one(connector);
      }),
    );
    return { ok: true, data: catalogs };
  }

  /** The owner-domain bound on `ps`/`status` metadata: on a USER mesh, a privileged-tier caller
   *  sees only agents under its OWN subject-pinned owner. Two ways to see ALL owners: the admin
   *  TIER (operator), or a fresh ledger `admin` SCOPE on the caller's row — the SAME authority that
   *  lets `stop`/`attach` reach cross-owner agents ({@link authorizeNamedControl}). Without this the
   *  two surfaces disagree: an admin operator could cross-owner stop an agent it could not list.
   *  Read fresh so a revoked admin loses visibility on its next call; a read failure and an
   *  unparseable caller both fall closed (own-owner / matches-nothing). Static meshes are unbounded. */
  private async psOwnerFilter(caller: EpCaller, admin: boolean): Promise<string | undefined> {
    if (!this.userMode || admin) return undefined;
    if (this.remoteAuthority) return (await this.epAdminReach(caller)) ? undefined : caller.owner;
    try {
      const scope = await resolveAuthProvider().actorScope({
        dir: userAuthStateDir(this.workspaceRoot, this.space),
        owner: caller.owner,
        actor: caller.actor,
      });
      if (scope?.includes("admin")) return undefined;
    } catch {
      /* unreadable ledger authorizes nothing extra: fall through to the own-owner bound */
    }
    return caller.owner;
  }

  /** Boot one resolved agent from a mesh-manifest launch spec, for `cotal spawn -f` onto a RUNNING
   *  manager. The request carries `{ runId, name }` — plus, for a deploy from another checkout or
   *  host, the resolved `spec` itself inline (validated as untrusted input and persisted under THIS
   *  manager's `.cotal/run/` first) — NEVER a path: the manager derives + validates
   *  `.cotal/run/<runId>.json` itself ({@link launchSpecForRun} — token-safe id, no-follow,
   *  `loadLaunchSpec`'s untrusted-input + `validateLaunchPolicy` contract), materializes the named
   *  agent's transient persona, and spawns via the same `startAgent({ resolved })` path as
   *  `supervise --launch`. The reply is enriched for the ownership ledger: the SPAWNED
   *  (collision-numbered) name + nkey id creds are filed under, plus the manifest `requested` name,
   *  `runId`, and resolved `hash`. USER mesh: a privileged-tier launch is owner-equality-authorized
   *  (spec owner === caller owner) before any side effect; the admin tier keeps operator behavior. */
  private async opLaunch(args: Record<string, unknown>, caller: string, admin: boolean, hooks?: SpawnHooks, route: "one" | "all" | "inst" = "inst"): Promise<ControlReply> {
    if (this.execution === "none") return { ok: false, error: this.executionRefusal() };
    const runId = String(args.runId ?? "").trim();
    const name = String(args.name ?? "").trim();
    if (!runId || !name) return { ok: false, error: "launch requires runId + name" };
    let spec;
    if (args.spec !== undefined) {
      // REMOTE deploy: the caller pushes the resolved spec inline over the control plane instead of
      // sharing this checkout's disk. Same untrusted-input contract as the file path (strict schema,
      // safe names, policy re-validation), then persisted under OUR `.cotal/run/<runId>.json` so
      // stale-restart and retained resume read the same on-disk source either way. Still never a
      // path: the payload is the spec itself, and where it lands is derived here.
      try {
        spec = parseLaunchSpec(args.spec, `inline launch spec (run ${runId})`);
        if (spec.runId !== runId)
          return { ok: false, error: `inline launch spec runId "${spec.runId}" does not match requested "${runId}"` };
        hooks?.onEffect?.();
        persistLaunchSpec(this.workspaceRoot, spec);
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
    } else {
      try {
        spec = launchSpecForRun(this.workspaceRoot, runId);
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
    }
    const la = spec.agents.find((a) => a.name === name);
    if (!la) return { ok: false, error: `no agent "${name}" in launch spec for run ${runId}` };
    // USER mesh: a manifest launch runs under the spec's apply-time owner, never the ctl caller —
    // fail loud on a spec without one rather than guess (core `MeshLaunchSpec.owner`).
    if (this.userMode && !spec.owner)
      return { ok: false, error: `user-auth space "${this.space}": launch spec for run ${runId} carries no owner - re-apply the manifest as a logged-in operator` };
    if (this.userMode) {
      // Privileged-tier user-mode launch: owner-equality (spec owner === caller owner), decided by
      // the pure policy BEFORE materializePersona or any other side effect, so a denied
      // cross-owner launch writes nothing. Admin tier passes through it unchanged.
      const denied = authorizeLaunch({ specOwner: spec.owner, caller, admin, runId });
      if (denied) return { ok: false, error: denied };
    }
    let configPath: string;
    try {
      hooks?.onEffect?.();
      configPath = materializePersona(this.workspaceRoot, runId, la);
    } catch (e) {
      return { ok: false, error: rejectionText(e) };
    }
    const reply = await this.startAgent({ ...launchAgentToStartOpts(la, configPath, spec.owner, runId), route }, caller, hooks);
    if (reply.ok)
      // `data.name` stays the spawned (numbered) identity — what creds are filed under and the ledger
      // keys on; `requested`/`runId`/`hash` give the CLI the manifest name + drift hash for the ledger.
      reply.data = { ...(reply.data as object), requested: la.name, runId, hash: la.hash, newlyStarted: true };
    return reply;
  }

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
      return await this.startAgentActive(opts, spawner, hooks, authenticatedCaller);
    } finally {
      release();
    }
  }

  /** The persona file a spawn loads and the harness it resolves, shared by `spawn` and the served
   *  `resolve-agent` read: a detached resume locates the session it carries with the connector this
   *  names, so the two doors must not drift (#2899). */
  private async spawnPersona(
    opts: Pick<StartAgentOpts, "name" | "config" | "identity" | "agent" | "defaultAgent" | "resolved" | "persona">,
    spawner: string | undefined,
    authenticatedCaller: EpCaller | undefined,
  ): Promise<
    | { ref: string; configPath: string; def: AgentDef | undefined; agent: string; inline?: undefined }
    | { ref: string; configPath?: undefined; def: AgentDef; agent: string; inline: { save: boolean } }
    | { error: string; code?: "bad-request" }
  > {
    // Both config-taking wire commands and direct/roster starts enter here before interpreting
    // a path. A resolved manifest is host-built authority over its own materialized resource,
    // never a wire-supplied config override (the public schemas accept no `resolved` field).
    if (this.execution === "runtime" && this.requiredRuntime.spawnDelegated && opts.config !== undefined && !opts.resolved)
      return { error: "delegated execution cannot use a manager-host persona config path; select a named persona" };
    // The spawn argument is a persona REF — a filename in `.cotal/agents` (the unique spawn KEY), or
    // a path via `--config`. It is NOT the mesh identity: the identity comes from inside the file
    // (`name:`), so a persona can be filed descriptively (review-critic.md) yet present under a
    // free-form name (socrates) — the same model `cotal spawn` already uses. You always spawn by
    // filename (unique on disk); two files can't collide on the key.
    const ref = opts.name.trim();
    if (!ref) return { error: "name required" };
    // An inline persona is its own definition, read here like a file so every later check sees a
    // def. It has no file until its snapshot is written, once the seat's lifecycle uid is final.
    if (opts.persona !== undefined) {
      if (opts.resolved || opts.config !== undefined || opts.identity !== undefined)
        return { error: "persona: an inline persona names the helper itself, so it takes no config, identity or manifest launch", code: "bad-request" };
      const refErr = this.nameError(ref);
      if (refErr) return { error: refErr };
      let inline: { def: AgentDef; save: boolean };
      try {
        inline = inlinePersonaDef(ref, opts.persona);
      } catch (e) {
        return { error: rejectionText(e), code: "bad-request" };
      }
      // A save under a name the catalog already holds is refused here, before anything is allocated,
      // so the refusal starts nothing. The create-only write after the grant settles a race.
      if (inline.save) {
        const target = agentFilePath(this.workspaceRoot, ref);
        let taken = true;
        try {
          lstatSync(target);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") return { error: `persona.save: ${rejectionText(e)}` };
          taken = false;
        }
        if (taken)
          return { error: `persona.save: the catalog already holds a persona named "${ref}" (${target}). Spawn that persona by name, or pick another name to save this one under` };
      }
      return { ref, def: inline.def, agent: resolveAgentType({ flag: opts.agent, pin: undefined, callerDefault: opts.defaultAgent }), inline: { save: inline.save } };
    }
    // A bare ref maps to `.cotal/agents/<ref>.md`, so it must be a safe token (no path traversal); a
    // `--config` path is validated by existsSync below instead.
    if (!opts.config) {
      const refErr = this.nameError(ref);
      if (refErr) return { error: refErr };
    }

    // Resolve the persona file (fail loud — NO silent default-ACL fallback). A missing persona used
    // to mint DEFAULT creds (read `general` only, default-deny publish, no capabilities), so a
    // typo'd / renamed / spawned-by-display-name agent became live with silently-wrong ACLs — a
    // behavioral/security bug. Fail loud instead, matching `cotal spawn` (loadAgentFile throws).
    // This runs BEFORE the spawn path resolves its connector: the file's `agent:` pin participates in
    // the harness choice (flag > file > COTAL_DEFAULT_AGENT > default, #869), which is impossible if
    // the connector is materialized first.
    let configPath: string;
    if (opts.config) {
      configPath = agentFilePath(this.workspaceRoot, opts.config);
      if (!existsSync(configPath)) return { error: `agent file not found: ${configPath}` };
    } else {
      configPath = agentFilePath(this.workspaceRoot, ref);
      if (!existsSync(configPath))
        return { error: `no persona "${ref}" in the catalog of manager ${this.managerInstanceId} on host ${hostname()}: ${configPath} not found; create it there` };
    }
    // An inline snapshot belongs to its own seat's lifecycle, which removes it at retirement and
    // refuses a restart once it changed, so no other launch may read it. Compared after symlinks
    // resolve, for a config path and a catalog entry alike.
    if (!opts.resolved && this.insideInlineDir(configPath))
      return { error: `${configPath} is an inline persona's snapshot, which belongs to the seat it was written for; spawn a saved persona by name, or pass the persona inline` };

    // Load the persona ONCE, here, ahead of the connector choice. The file's `agent:` pin feeds the
    // harness resolution below; the spawn path's identity/ACL profile block consumes the SAME def (no
    // second load). A manifest launch (`resolved`) materializes its own transient persona and the
    // file is NOT its authority, so its def (and its agent pin) is deliberately not consulted here —
    // the manifest's own `agent:` field drove the launch object already.
    let def: AgentDef | undefined;
    if (!opts.resolved) {
      try {
        def = loadLaunchPersonaFile(configPath);
      } catch (e) {
        return { error: rejectionText(e), ...(e instanceof PersonaSourceError ? { code: "bad-request" as const } : {}) };
      }
      // Shared operator files remain launchable. Owned content follows the catalog's visibility
      // decision before connector loading or any allocation. A hosted run acts for its admission;
      // only a complete authenticated caller can request the current ledger's admin decision.
      if (this.userMode && def.owner !== undefined) {
        const acting = authenticatedCaller === undefined ? undefined
          : this.runHosting?.admittedCaller(authenticatedCaller) ?? authenticatedCaller;
        const personaCaller = acting === undefined ? spawner ?? "" : principalKey(acting.owner, acting.actor).key;
        const admin = authenticatedCaller !== undefined && await this.epAdminReach(authenticatedCaller);
        if (!this.canReadPersona(def.owner, personaCaller, admin))
          return { error: `no persona "${ref}"` };
      }
    }
    return { ref, configPath, def, agent: resolveAgentType({ flag: opts.agent, pin: def?.agent, callerDefault: opts.defaultAgent }) };
  }

  /** Whether a persona path resolves into the inline snapshot directory, the directory itself
   *  included. A directory that does not exist holds nothing. */
  private insideInlineDir(path: string): boolean {
    const dir = inlinePersonaDir(this.workspaceRoot);
    if (!existsSync(dir)) return false;
    const real = realpathSync(path);
    const realDir = realpathSync(dir);
    return real === realDir || real.startsWith(realDir + sep);
  }

  /** The run a spawn acts for (SPEC 14.8). The run this manager drives under `caller` answers from
   *  memory. On a static mesh, a spawn from a run hosted elsewhere names its run, whether the program
   *  placed it here or the class queue delivered it, and its caller must be that run's driver, whose
   *  triple derives from the run id; the run's admission and revocation marker are then read
   *  leader-served, so the helper is bounded as the hosting manager bounds it. Elsewhere the run id
   *  is not read: a user-auth run's issuing host bounds the helper, and an open mesh bounds none.
   *  `undefined` for a spawn that acts for no run. */
  private async spawnRun(caller: EpCaller | undefined, runId: string | undefined): Promise<SpawnRun | undefined> {
    const hosted = caller !== undefined ? this.runHosting?.runAdmission(caller) : undefined;
    if (hosted !== undefined) {
      if (runId !== undefined && runId !== hosted.runId) return { refused: `it names run ${runId}, but its caller drives run ${hosted.runId}` };
      return { admission: hosted, hosted: true };
    }
    if (runId === undefined || this.meshMode !== "static") return undefined;
    let driver: EpCaller | undefined;
    try {
      driver = caller !== undefined ? runDriverCaller(runId, caller.owner) : undefined;
    } catch (e) {
      return { refused: `runId ${JSON.stringify(runId)} is not a run id (${rejectionText(e)})` };
    }
    if (driver === undefined || driver.actor !== caller!.actor || driver.uid !== caller!.uid)
      return { refused: `it names run ${runId}, but its caller is not that run's driver` };
    if (this.runHosting === undefined) return { refused: `run ${runId} asked this manager for a helper, but this manager hosts no runs, so it cannot read the run's admission` };
    let view: { admission: RunAdmission; revoked: RunRevocation | undefined };
    try {
      view = await this.runHosting.admission(runId);
    } catch (e) {
      return { refused: `run ${runId}'s admission and revocation marker could not be read (${rejectionText(e)}), so it starts no helper (SPEC 14.8)` };
    }
    if (view.revoked !== undefined) return { refused: revokedRunRefusal(runId, view.revoked) };
    return { admission: view.admission, hosted: false };
  }

  /**
   * Resolve what bounds a spawn's grant on a STATIC mesh: the caller's issued evidence, read the way
   * keyed runs read it. A user-auth mesh bounds the mint on its ledger instead, and an open mesh
   * mints no grant, so both return `exempt`. So does a call with no authenticated caller, which is
   * the manager's own composition root (roster boot, a manifest `launch`, which a static mesh mints
   * only into operator instruments). A workflow run's spawn, whether this manager hosts the run or
   * its spawn reached this manager from another host ({@link spawnRun}), is bounded by the run's admission (SPEC 14.8):
   * the ceiling it recorded, at the starter's coordinate, unless the starter was exempt then. That
   * ceiling is the starter's evidence as resolved at admission, or for a local run the channels the
   * operator named. Any other caller with no issued generation, or whose evidence does not resolve,
   * hands on no grant. The evidence's own standing decides the rest.
   */
  private async staticSpawnBound(caller: EpCaller | undefined, run: Extract<SpawnRun, { admission: RunAdmission }> | undefined): Promise<StaticSpawnBound> {
    if (this.meshMode !== "static" || caller === undefined) return { kind: "exempt" };
    // The driver's own credential is not the run's authority, and the starter's evidence may have
    // expired or changed since: the admission recorded both the ceiling and the verdict.
    if (run !== undefined) {
      const admission = run.admission;
      // Read leader-served before each of the run's spawns, so a run revoked mid-step starts no
      // helper, and a marker this manager cannot read refuses the spawn too. The marker of a run
      // hosted elsewhere was read with its admission.
      let refusal: string | undefined;
      if (run.hosted)
        try {
          const revoked = (await this.runHosting!.admission(admission.runId)).revoked;
          if (revoked !== undefined) refusal = revokedRunRefusal(admission.runId, revoked);
        } catch (e) {
          refusal = `run ${admission.runId}'s revocation marker could not be read (${rejectionText(e)}), so it starts no helper (SPEC 14.8)`;
        }
      if (refusal !== undefined) return { kind: "refused", reason: refusal };
      if (admission.spawnExempt) return { kind: "exempt" };
      // The helper is projected at the admitted coordinate, which needs a lifecycle token. A local
      // admission written before its uid was one records the CLI's own holder id, and bounds nothing.
      try {
        assertLifecycleToken(admission.caller.uid);
      } catch {
        return { kind: "refused", reason: `run ${admission.runId}'s admission records caller uid ${JSON.stringify(admission.caller.uid)}, which is not a lifecycle token, so its helpers cannot be measured and it starts none. Start the run again (SPEC 14.8)` };
      }
      return { kind: "bounded", caller: admission.caller, ceiling: admission.ceiling, run: admission.runId };
    }
    if (!isIssuedCaller(caller))
      return { kind: "none", reason: "its credential carries no issued generation (an unissued mint or a legacy rail)" };
    const ref = { space: this.space, owner: caller.owner, actor: caller.actor, uid: caller.uid, generation: caller.generation };
    try {
      const { evidence } = await withIssuerSession({ servers: this.servers ?? DEFAULT_SERVER, space: this.space, auth: this.auth!, tls: false }, (s) =>
        s.store.resolve(ref, s.sourceIsLive));
      return issuedSpawnerStanding(evidence) === "bounded" ? { kind: "bounded", caller, ceiling: evidence.permissions } : { kind: "exempt" };
    } catch (e) {
      return { kind: "none", reason: `its issued evidence does not resolve: ${rejectionText(e)}` };
    }
  }

  /** The refusal for a grant its static spawner does not hold, or `undefined` when it holds all of
   *  it. Each part is named, so the caller can drop exactly what overreached. `armsEvents` is whether
   *  the helper's own event plane will be minted: that row is keyed on a principal allocated later,
   *  so it is measured as the spawner's own, the rule the ledger applies. `door` names the command
   *  being bounded: a persona definition is bounded against its definer as a spawn is. */
  private spawnBoundRefusal(bound: StaticSpawnBound, grant: DelegatedGrant, armsEvents: boolean, door: "spawn" | "define-persona" = "spawn"): string | undefined {
    if (bound.kind === "exempt") return undefined;
    if (bound.kind === "refused") return `${door}: ${bound.reason}`;
    let over: GrantOverreach[];
    let eventsOver: boolean;
    try {
      over = bound.kind === "none" ? grantParts(grant) : grantOverreach(this.space, bound.caller, bound.ceiling, grant);
      eventsOver = armsEvents && (bound.kind === "none"
        || grantOverreach(this.space, bound.caller, bound.ceiling, { allowPublish: [eventChannel({ owner: bound.caller.owner, actor: bound.caller.actor })] }).length > 0);
    } catch (e) {
      return `${door}: ${rejectionText(e)}`;
    }
    if (!over.length && !eventsOver) return undefined;
    const named = [
      // A role is handed on by a spawner whose credential binds that role's task queue: its own
      // role, or a `role:<r>` token in its capabilities.
      ...over.map((o) => o.field === "role" ? `role ${o.value} (a spawner hands on a role it was given as its own or as the \`role:${o.value}\` capability)` : `${o.field} ${o.value}`),
      ...(eventsOver ? ["events (the helper's own event plane; pass events: false to spawn without it)"] : []),
    ].join(", ");
    if (door === "define-persona")
      return bound.kind === "none"
        ? `define-persona: the definer holds no issued evidence (SPEC 13.15), so its persona can grant nothing: ${bound.reason}. This persona asks for ${named}. ` +
            `Define it without these, or start the definer under a manager (\`cotal spawn --detach\`), whose seats carry issued evidence.`
        : `define-persona: this persona grants more than the definer holds: ${named}. A definer hands on only what its own issued credential carries (SPEC 13.15). ` +
            `Drop these from the persona, or have the operator widen the definer's own persona.`;
    if (bound.kind === "bounded" && bound.run !== undefined)
      return `spawn: this spawn hands its helper more than run ${bound.run}'s starter held when the run was admitted: ${named}. ` +
        `A run hands on only what its admission recorded: its starter's issued credential, or for a \`--local\` run the channels named by \`--admit-read\` and \`--admit-publish\` (SPEC 14.8). ` +
        `Drop these from the persona or the spawn, or start the run from a caller that holds them.`;
    return bound.kind === "none"
      ? `spawn: the spawner holds no issued evidence (SPEC 13.15), so it hands on no grant: ${bound.reason}. This spawn asks for ${named}. ` +
          `Spawn a persona that names none of these, or start the spawner under a manager (\`cotal spawn --detach\`), whose seats carry issued evidence.`
      : `spawn: this spawn hands its helper more than the spawner holds: ${named}. A spawner hands on only what its own issued credential carries (SPEC 13.15). ` +
          `Drop these from the persona or the spawn, or have the operator widen the spawner's own persona.`;
  }

  /** Ordinary static control seats can read their holding instance. A run's recorded ceiling is
   *  authoritative, so its helpers receive no additional instance reads. */
  private managedStaticInstanceReads(capabilities: readonly string[] | undefined): EpCapability[] {
    if (this.meshMode !== "static" || !this.managerInstanceId || !capabilities?.some(c => c === "spawn" || c === "run" || c === "admin")) return [];
    return ["describe", "inspect"].map(command => ({
      endpoint: MANAGER_ENDPOINT, command, instanceId: this.managerInstanceId, instanceOnly: true,
    }));
  }

  private async startAgentActive(opts: StartAgentOpts, spawner?: string, hooks?: SpawnHooks, authenticatedCaller?: EpCaller): Promise<ControlReply> {
    // Before the first await, so the grant, the launch, the retained form and the restart slot all read
    // the lists and the restart policy as admitted.
    opts = ownLists(opts);
    if (opts.resolved) opts.resolved = ownLists(opts.resolved);
    if (opts.persona !== undefined) opts.persona = ownPersona(opts.persona);
    if (opts.supervise) {
      opts.supervise = { restarts: opts.supervise.restarts, windowMs: opts.supervise.windowMs };
      // The budget is checked here, where it is held, not only at the wire: an in-process caller of
      // this export is refused before anything launches, rather than getting a seat that joins and is
      // torn down when its seat record will not take the policy (#3298).
      const policy = supervisePolicy.safeParse(opts.supervise);
      if (!policy.success) return { ok: false, error: `supervise.${policy.error.issues[0]?.path.join(".")}: expected a positive integer` };
    }
    if (opts.once) opts.once = { deadlineMs: opts.once.deadlineMs };
    let runtime: Runtime;
    try {
      await this.loadSeatRuntime(opts.runtime);
      runtime = this.runtimeFor(opts.runtime);
    } catch (e) {
      return { ok: false, error: rejectionText(e) };
    }
    if (opts.delegatedIntent) {
      if (!this.remoteAuthority?.executeDelegatedUserIntent)
        return { ok: false, error: `"${opts.name}" names a delegated user intent, and this manager has no host execution for one` };
      if (opts.supervise) return { ok: false, error: `"${opts.name}" names a delegated user intent, and a delegated agent is never restarted (SPEC 13.16)` };
      // A delegated launch's spawner is the user's principal, never the composition root's call.
      spawner = opts.delegatedIntent.parent;
    }
    const persona = await this.spawnPersona(opts, spawner, authenticatedCaller);
    if ("error" in persona) return { ok: false, error: persona.error, ...(persona.code ? { code: persona.code } : {}) };
    const { ref, def, agent, inline } = persona;
    // An inline persona's file is its snapshot, written once the lifecycle uid is final; until then
    // a refusal names the persona instead of a path.
    let configPath = persona.configPath;
    const where = configPath ?? `inline persona "${ref}"`;

    // Materialize the requested connector before the capacity/reserve span so its lazy import
    // cannot interleave that synchronous allocation. On the manifest binary this also honors a
    // live `cotal ext remove`: a removed connector is rejected here even if an earlier spawn already
    // imported it. A broken/missing connector fails loud here with a clear name + install hint.
    let connector: Connector;
    try {
      connector = await this.resolveConnector(agent);
    } catch (e) {
      const error = rejectionText(e);
      // An action refusal here precedes capacity, allocation and onAccepted. Preserve that proof
      // through serveSpawnGoal without changing the direct startAgent ControlReply contract.
      if (hooks?.onAccepted) throw new EpEnvelopeError("failed-precondition", error, undefined, "not-executed");
      return { ok: false, error };
    }
    // Read here, beside the connector, so the capacity check and the reserve below take no new await.
    const run = await this.spawnRun(authenticatedCaller, opts.runId);
    if (run !== undefined && "refused" in run) return { ok: false, error: `spawn: ${run.refused}` };
    const bound = await this.staticSpawnBound(authenticatedCaller, run);

    const readinessTimeoutMs = connector.readinessTimeoutMs ?? this.readinessTimeoutMs;
    if (!Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs <= 0)
      return { ok: false, error: `connector ${connector.name} declares invalid readinessTimeoutMs ${JSON.stringify(connector.readinessTimeoutMs)}; expected a positive safe integer` };

    // Capacity check first (cheap, fail-fast). Everything from here to the reserve below is
    // SYNCHRONOUS (existsSync / registry / accessSync / readFileSync — no await), so the gate stays
    // atomic: the capacity snapshot and the reserve land in one tick (P4a/P4c), and two concurrent
    // spawns can't overshoot the ceiling or pick the same name.
    const occupancy = this.occupancy(); // prunes expired cooling stamps; counts each name once
    if (occupancy.used >= MAX_AGENTS) return { ok: false, error: this.capacityRefusal(occupancy) };

    // Harness preflight before reserving a slot or minting — a missing `claude`/`opencode` binary
    // fails here with a clear name, not obscurely at process spawn. No fallback. All synchronous, so
    // the reserve gate stays atomic. (The connector itself was resolved up top, before the capacity gate.)
    const harness = this.launchHarness(connector);
    if ("refusal" in harness) return { ok: false, error: this.harnessUnavailableError(harness.refusal, opts.route ?? "inst") };
    // Resume is a connector capability: reject an unsupported resume HERE, before the reserve/mint, so
    // it can never provision creds + durables and then throw at buildLaunch (mint-then-orphan). Same
    // reject-before-side-effects window as the harness preflight above; buildLaunch stays the backstop.
    if (opts.resume && !connector.supportsResume)
      return { ok: false, error: `${agent} connector does not support resuming an existing session (resume)` };
    // A carried resume (#1499) is checked here too, before anything is minted. The claim is only
    // looked at: the connector may still refuse the launch, and a refused launch leaves it unspent.
    let carried: TranscriptClaim | undefined;
    if (opts.resumeClaim !== undefined) {
      if (opts.resume === undefined) return { ok: false, error: "resumeClaim: names carried bytes of a resume; the launch carries no resume" };
      if (!connector.resumeTranscript) return { ok: false, error: `${agent} connector does not take a carried transcript (resumeClaim)` };
      if (opts.resumeAgent !== agent)
        return { ok: false, error: `resumeClaim: the session was carried for agent "${opts.resumeAgent ?? "<none>"}", and this launch resolves agent "${agent}"` };
      if (!this.transcripts) return { ok: false, error: "resumeClaim: this manager does not receive carried transcripts" };
      try {
        carried = this.transcripts.peek(opts.resumeClaim, opts.resume);
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
    }
    // A restart policy this host cannot honour is refused at accept, never accepted and ignored.
    // External runtimes (tmux/cmux/orca/herdr) attach to a process they do not own and stream no
    // exit, so a name cannot be respawned in place. User-mode seats have no static slot that
    // keeps the incarnation owned across a process death, so the same refusal applies there.
    if (opts.supervise !== undefined) {
      if (runtime.kind !== "pty")
        return { ok: false, error: `supervise is a restart policy this host cannot enforce: runtime "${runtime.kind}" cannot respawn a name in place` };
      if (this.userMode)
        return { ok: false, error: "supervise is a restart policy this host cannot enforce: a user-mode seat has no static slot to keep the incarnation owned across a process death" };
      if (runtime.supportsWorkClosure !== true)
        return { ok: false, error: `supervise is a restart policy this host cannot enforce: runtime "${runtime.kind}" cannot prove prior local work ended` };
    }
    // One read of the cotal config per spawn: the delegated refusal, the model policy and the launch
    // fields below all take this value, so the awaits between the policy check and the launch cannot
    // admit the seat under one file and launch it with another's servers and env allowlist. Read per
    // spawn, so a policy edit reaches the next spawn without a restart. The launch fields are resolved
    // here too, before the spawn is accepted, so a sharing selection that names an undeclared server
    // is refused while there is nothing to roll back.
    let cotalConfig: CotalConfig;
    let hostFields: ReturnType<Manager["hostLaunchFields"]>;
    try {
      cotalConfig = loadCotalConfig(this.workspaceRoot);
      hostFields = this.hostLaunchFields(cotalConfig, agent, opts.shareTools, harness);
    } catch (e) {
      const error = rejectionText(e);
      // An input refusal here precedes allocation and onAccepted, like a connector refusal above:
      // a hosted run proves it not-executed instead of binding a goal to a spawn that never starts.
      if (hooks?.onAccepted) throw new EpEnvelopeError("failed-precondition", error, undefined, "not-executed");
      return { ok: false, error };
    }
    // A delegated seat starts outside this host from values alone, so a choice only this host can
    // honour is refused here, before enrollment, and named rather than dropped.
    if (runtime.spawnDelegated) {
      const delegatedBy = `runtime "${runtime.kind}" starts seats outside this host`;
      if (!this.remoteAuthority?.enrollManagedAgent)
        return { ok: false, error: `${delegatedBy}, which needs a host that enrolls managed agents (remoteAuthority.enrollManagedAgent); a delegated seat has no local grant path` };
      try {
        this.delegatedMeshRecord();
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
      if (opts.resume)
        return { ok: false, error: `${delegatedBy}, so it cannot resume a session held on this host (resume)` };
      if (opts.resolved?.continuity === "exact")
        return { ok: false, error: `${delegatedBy}, so it cannot reopen a session held on this host (continuity: exact)` };
      if (typeof opts.cwd === "string" && opts.cwd !== "")
        return { ok: false, error: `${delegatedBy}, so it cannot run in a directory on this host's filesystem (cwd); the seat runs in its runtime resource's own directory` };
      const shared = Object.keys(hostFields.mcpServers!);
      if (shared.length)
        return { ok: false, error: `${delegatedBy}, so it cannot share MCP servers that run on this host (${shared.join(", ")}); pass --share-tools none` };
    }

    // A placed spawn's cwd is checked on this host BEFORE anything is minted or reserved: an absolute
    // path this manager cannot realpath, or one that is not a directory, is refused here with the
    // asked path, the reason and this host, so a misplaced spawn in a multi-manager space is
    // diagnosable at the moment it happens (#385 item 2) instead of failing inside the pty launch.
    // The resolved realpath is threaded to the launch cwd below (`resolvedCwd`) so it is computed once.
    let resolvedCwd: string | undefined;
    if (typeof opts.cwd === "string" && opts.cwd !== "") {
      const asked = opts.cwd;
      const target = resolve(this.workspaceRoot, asked);
      const checked = this.checkSpawnCwd(target);
      if ("refusal" in checked)
        return { ok: false, error: `spawn: cwd does not resolve on this host (${hostname()}): ${JSON.stringify(asked)} (${checked.refusal}); the seat was not launched` };
      resolvedCwd = checked.cwd;
    }

    // Resolve the launch profile: IDENTITY (free-form `name:`) + role + read/post ACL + capabilities
    // + model/variant. Either from a fully-resolved manifest launch object (`opts.resolved`, whose `config`
    // is a materialized transient persona — the file is NOT the access authority), or from the
    // persona file. The number rides the IDENTITY (socrates → socrates_2), not the file ref — a
    // redelivered identical spawn yields a fresh numbered agent (MAX_AGENTS bounds the blast radius).
    let identityName: string;
    let role: string | undefined;
    let subscribe: string[] | undefined;
    let allowSubscribe: string[];
    let allowPublish: string[] | undefined;
    let capabilities: string[] | undefined;
    // The endpoint commands the persona hands on (SPEC 13.15), as the persona names them and as the
    // mint grants them. A manifest launch carries none: its schema has no slot for them.
    let personaEndpoints: PersonaEndpoint[] | undefined;
    let endpoints: EpCapability[] = [];
    let model = opts.model;
    let variant = opts.variant;
    let launchOptions = opts.launchOptions;
    let prompt = opts.prompt;
    // The read set the persona and the overrides name, before `join` adds to it: what a saved copy keeps.
    let ownSubscribe: string[] | undefined;
    if (opts.resolved) {
      // A manifest launch is the access + identity authority: imperative overrides arriving
      // alongside `resolved` are a caller contract error, not something to merge (no fallbacks).
      if (opts.subscribe || opts.allowSubscribe || opts.allowPublish || opts.join || opts.callerAcl || opts.prompt || opts.shareTools || opts.identity)
        return { ok: false, error: "a manifest launch (resolved) rejects imperative overrides (identity/subscribe/allow*/join/callerAcl/prompt/shareTools)" };
      const r = opts.resolved;
      identityName = r.name;
      role = opts.role ?? r.role;
      subscribe = r.subscribe;
      allowSubscribe = r.allowSubscribe;
      allowPublish = r.allowPublish;
      capabilities = r.capabilities;
      model = opts.model ?? r.model;
      variant = opts.variant ?? r.variant;
      launchOptions = mergeLaunchOptions(r.launchOptions, opts.launchOptions);
      prompt = r.prompt; // the guard above rejected an imperative prompt — one source

    } else {
      // `def` was loaded once above the connector resolution (#869 ordering); consume it here.
      // `resolved` is the only path that skips the load, and this is its opposite branch.
      if (!def) return { ok: false, error: "internal: persona definition missing at launch profile" };
      // Identity: the `--name` override wins over the file's `name:` — foreground parity (there,
      // `requested = values.name ?? def.name`). The override is minted into the creds and rides
      // COTAL_NAME below, so the presence identity and its credential can't diverge.
      identityName = opts.identity ?? def.name;
      role = opts.role ?? def.role;
      // Flags > persona file — the same precedence as foreground `cotal spawn`, so the two launch
      // paths of the merged grammar can't diverge. One source feeds BOTH the minted creds and the
      // connector env below.
      // A persona that names no channel field at all is scoped to its spawner's ACL (`callerAcl`,
      // when the door sent one). The spawner's own event channel is dropped from it: that plane is
      // foreign to the child, and the guard below refuses any spawn that asks for one. The joined
      // set is never copied from the spawner: a helper starts on what its persona lists plus what
      // the caller passes in `join`, and nothing else. The ACL is the caller's own report, so on a
      // static mesh it is clamped to what the caller's evidence shows it holds, and a caller with
      // no evidence gets no default at all.
      const personaNamesChannels = def.subscribe !== undefined || def.allowSubscribe !== undefined || def.allowPublish !== undefined;
      const heldChannels = (field: "allowSubscribe" | "allowPublish", channels: string[]) => {
        const own = channels.filter((ch) => eventChannelPrincipal(ch) === null);
        return bound.kind === "bounded" ? own.filter((ch) => grantOverreach(this.space, bound.caller, bound.ceiling, { [field]: [ch] }).length === 0) : own;
      };
      let scoped: { allowSubscribe: string[]; allowPublish: string[] } | undefined;
      try {
        scoped = !personaNamesChannels && opts.callerAcl && bound.kind !== "none" ? {
          allowSubscribe: heldChannels("allowSubscribe", opts.callerAcl.allowSubscribe),
          allowPublish: heldChannels("allowPublish", opts.callerAcl.allowPublish),
        } : undefined;
      } catch (e) {
        return { ok: false, error: `callerAcl: ${rejectionText(e)}` };
      }
      const base = opts.subscribe ?? def.subscribe;
      ownSubscribe = base;
      subscribe = opts.join?.length ? [...new Set([...(base ?? []), ...opts.join])] : base;
      allowSubscribe = opts.allowSubscribe ?? def.allowSubscribe ?? scoped?.allowSubscribe ?? [];
      allowPublish = opts.allowPublish ?? def.allowPublish ?? scoped?.allowPublish;
      capabilities = def.capabilities;
      personaEndpoints = copyPersonaEndpoints(def.endpoints);
      // A user-auth mesh grants endpoint access through the service owner's records, which a spawn
      // cannot write (SPEC 13.15), so a persona that names the field is refused there, `[]` included,
      // before any bound or exemption reads it.
      if (personaEndpoints !== undefined && this.meshMode === "user")
        return { ok: false, error: userMeshEndpointsRefusal("spawn") };
      endpoints = lowerPersonaEndpoints(personaEndpoints);
      // #651: fold the persona's model into the launch record, mirroring the variant line below
      // and the manifest branch above. Without this, a persona-file model (the common pin source)
      // never reaches `launch.model`, so the connector runs the seat on it while `ps --wide`/`--json`
      // reports the model ABSENT - a false "no model pinned" for a seat that has one.
      model = opts.model ?? def.model;
      variant = opts.variant ?? def.variant;
      launchOptions = mergeLaunchOptions(def.launchOptions, opts.launchOptions);
    }
    // Resolved once for both branches, because this one list is granted, minted, recorded on the
    // launch and forwarded to the session, and each of those must read the list the provisioner does.
    try {
      allowSubscribe = resolveReadAcl(subscribe ?? [], allowSubscribe);
    } catch (e) {
      return { ok: false, error: opts.resolved ? `launch agent: ${rejectionText(e)}` : `persona ${where}: ${rejectionText(e)}` };
    }
    // Default events on where the connector supports them, unless the launch explicitly opts out.
    const events = this.eventsRequired || opts.events === true || (opts.events !== false && !!connector.eventChannel);
    if (this.eventPayloadsWithheld && opts.eventPayloads === true)
      return { ok: false, error: "space policy withholds event payloads" };
    const eventPayloads = !this.eventPayloadsWithheld && (opts.eventPayloads ?? def?.eventPayloads) !== false;
    if (run === undefined) {
      const reads = this.managedStaticInstanceReads(capabilities);
      if (bound.kind === "exempt" || (bound.kind === "bounded" && !grantOverreach(this.space, bound.caller, bound.ceiling, { endpoints: reads }).length))
        endpoints.push(...reads);
    }
    // THE DELEGATION BOUND, on the grant as it will be minted: every channel and capability the
    // helper gets, from the persona, the raw overrides and the `callerAcl` default alike, and its own
    // event plane, so no door reaches the mint around it. Before any reserve or mint, so a refusal
    // leaves nothing.
    const boundRefusal = this.spawnBoundRefusal(bound, {
      allowSubscribe,
      ...(allowPublish !== undefined ? { allowPublish } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(capabilities !== undefined ? { capabilities } : {}),
      ...(endpoints.length ? { endpoints } : {}),
    }, events);
    if (boundRefusal) return { ok: false, error: boundRefusal };
    // A run saves for the caller it was admitted for, whose catalog reads then find the copy.
    const savedBy = authenticatedCaller === undefined ? undefined : this.runHosting?.admittedCaller(authenticatedCaller);
    // What a saved copy keeps: the grant just checked, without the helper's own event row, which each
    // later spawn derives for its own helper. The file names every channel field, so no later caller's
    // default fills one, and each later spawn of it is still bounded against that caller.
    const catalogCopy: AgentDef | undefined = inline?.save
      ? {
          name: ref,
          owner: savedBy !== undefined ? this.personaOwner(principalKey(savedBy.owner, savedBy.actor).key) : spawner === undefined ? undefined : this.personaOwner(spawner),
          role,
          model,
          variant,
          description: def?.description,
          persona: def?.persona,
          subscribe: [...(ownSubscribe ?? [])],
          allowSubscribe: [...allowSubscribe],
          allowPublish: [...(allowPublish ?? [])],
          capabilities: capabilities?.length ? [...capabilities] : undefined,
          endpoints: copyPersonaEndpoints(personaEndpoints?.length ? personaEndpoints : undefined),
        }
      : undefined;
    // Checked after every path has resolved its selectors: a direct `startAgent` call skips the
    // `start` op's checks, and no connector may receive a blank one (#2862).
    if (model !== undefined && !model.trim()) return { ok: false, error: "model: must not be empty" };
    if (variant !== undefined && !variant.trim()) return { ok: false, error: "variant: must not be empty" };
    const idErr = this.nameError(identityName);
    if (idErr) return { ok: false, error: opts.resolved ? `launch agent: ${idErr}` : `persona ${where}: ${idErr}` };
    // #966: a seat labelled `manager` that cannot spawn is a worker wearing a label, and the label
    // is what other agents ROUTE on (role is the anycast address). The gap is silent today because
    // the mismatch is only discovered minutes in, when the seat first reaches for a worker. Refuse
    // at accept, before any reserve/mint, naming the remediation for each author: an operator edits
    // the file to add the grant, and the persona's owner may redefine it with the grant only if the
    // owner holds spawn, because define-persona bounds capabilities against the definer. The
    // check keys on the EFFECTIVE role (a spawn-time role: override wins
    // over the file, mirroring the resolution above), not the file's, so the label other agents
    // will actually see is the label that is held to account. `manager` is the label that MEANS
    // spawn-holding: naming it literally keeps this the narrow guard for the observed harm, not a
    // vocabulary any caller can trigger with a synonym (roles are free-form and mostly
    // non-manager: this workspace's own catalog carries worker/reviewer/orchestrator seats with no
    // spawn grant, all legitimate).
    if (role === "manager" && !capabilities?.includes("spawn") && inline)
      return {
        ok: false,
        error:
          `inline persona "${ref}" would join with role "manager" but no spawn capability: it presents as a manager ` +
          `while being unable to seat workers. Add \`capabilities: [spawn]\` to the inline persona (a spawner hands on only what it holds), or give it another role.`,
      };
    if (role === "manager" && !capabilities?.includes("spawn"))
      return {
        ok: false,
        error:
          `persona "${ref}" would join with role "manager" but no spawn capability: it presents as a manager ` +
          `while being unable to seat workers, and it would discover that only on first use. ` +
          `An operator adds \`capabilities: [spawn]\` to ${configPath}, or the persona's owner redefines it ` +
          `with \`capabilities: [spawn]\` (cotal_persona) if the owner holds spawn.`,
      };
    // #581: the operator's per-role model allowlist, judged on the EFFECTIVE role and model resolved
    // above, before any reserve or mint. This is where the launch is performed, so no caller can
    // skip it, and a definition pinned to a stale model (or to none) is refused here instead of
    // serving on it.
    const policyRefusal = modelPolicyRefusal(cotalConfig, {
      persona: opts.resolved ? `manifest agent "${ref}"` : configPath ? `persona "${ref}" (${configPath})` : where,
      role, model, variant,
      // A manifest launch carries its own declared model/variant in these options
      // (launchAgentToStartOpts), so there they are the definition's field, never a flag.
      modelFlag: !opts.resolved && opts.model !== undefined,
      variantFlag: !opts.resolved && opts.variant !== undefined,
      launchOptions,
    });
    if (policyRefusal) return { ok: false, error: policyRefusal };
    // The alias-reuse gate: a name whose previous agent is still retiring REFUSES
    // legibly (never a silent suffix), and the refusal re-drives the FULL durable teardown so
    // "retry the spawn" is also the nudge. It routes through `deprovision` (not `requestRetirement`
    // alone) so a retry re-drives the standing-authority revoke (INT-2) AND the broker cleanup before
    // any hold-clear (C): the alias must not free while the durable teardown or the revoke is still
    // outstanding. All the teardown ops are idempotent, and the rail request is single-flighted.
    if (this.staticLifecycle.isReconciling(identityName))
      return { ok: false, error: `the name "${identityName}" is still reconciling at manager startup; its prior lifecycle terminal owns this alias until it completes. Retry shortly.` };
    const held = this.retirement.held(identityName);
    if (held !== undefined) {
      hooks?.onEffect?.();
      void this.deprovision(held.target).catch(() => {});
      const err = lifecycleBlocked("failed-precondition",
        `the name "${identityName}" is reserved pending retirement: its previous agent's despawn started that lifecycle's teardown (footprint + standing-authority revoke + auth-side retirement), and the name frees only when all of it completes${held.lastError !== undefined ? ` (last attempt: ${held.lastError})` : ""}. NEXT: wait a moment and retry this spawn (retrying re-drives the whole teardown), or pick another name.`,
        { blockedOp: "retirement", opId: held.opId, remedy: "retry" });
      return { ok: false, error: renderLifecycleBlocked(err.message, err), details: err.details };
    }
    // A manifest `continuity: exact` agent reopens the session this manager last bound to its
    // declared name. Refused before any reserve or mint when the connector cannot reopen an exact
    // session or the recorded assignment does not match this declaration.
    const exact = opts.resolved?.continuity === "exact";
    const unsupported = this.capabilityRefusal(connector, { variant, prompt, exact });
    if (unsupported) return { ok: false, error: unsupported };
    const onceRefused = opts.once && this.onceRefusal(connector, runtime, { ...opts, launchOptions, prompt }, spawner, hooks);
    if (onceRefused) return { ok: false, error: onceRefused };
    let reopenSession: string | undefined;
    if (exact) {
      try {
        reopenSession = readContinuityAssignment(this.workspaceRoot, { space: this.space, name: identityName, connector: agent, cwd: resolvedCwd ?? this.workspaceRoot });
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
    }
    // The child takes launch options as `--opt k=v`, so only string values can cross to it.
    const unportable = runtime.spawnDelegated ? Object.keys(launchOptions ?? {}).filter((k) => typeof launchOptions![k] !== "string") : [];
    if (unportable.length)
      return { ok: false, error: `runtime "${runtime.kind}" starts seats outside this host, so it cannot pass non-string launch options (${unportable.join(", ")})` };
    // An event plane the connector cannot emit is refused HERE, before anything is minted: a
    // connector that cannot emit must fail before provisioning rather than after, as an
    // unsupported `resume` does.
    // The GRANT itself cannot be derived yet. It is keyed on the agent's PRINCIPAL, and in user mode
    // the principal's owner is resolved further down, so deriving it from anything in scope here
    // would mean guessing at the identity the child will actually connect as. It is added at the
    // accept seam below, where the allocated triple exists.
    const eventsRefused = this.eventsRefusal(connector, opts.events);
    if (eventsRefused) return { ok: false, error: eventsRefused };

    // The roster the allocation consults must reflect the initial presence snapshot,
    // or a spawn immediately after manager boot races an already-live unmanaged peer and re-opens the
    // very collision black-hole this closes. Await the snapshot (bounded internally, fail-safe on an
    // empty mesh) before allocating; the broker/auth remain the authority downstream. Deliberately
    // unconditional: a half-wired endpoint without the seam must fail loud here, not silently
    // allocate off a pre-snapshot roster.
    await this.ep.waitForPresenceSnapshot();
    // Spawn-as-action: a HARD-PINNED name — an imperative `--name`/identity override
    // or a manifest-declared name (opts.resolved) — that collides with a LIVE/provisioning/reserved
    // incarnation REFUSES loud at accept, BEFORE any reserve/mint/bind, never a silent `_2`
    // suffix (so an address-by-triple caller's pinned name can't be re-pointed). A PERSONA-DERIVED
    // base name (no pin) keeps uniqueName's collision numbering, so multi-peer `spawn reviewer` twice
    // still yields reviewer + reviewer_2. The alias-reuse gate above is orthogonal and already fired.
    const hardPinned = opts.identity !== undefined || opts.resolved !== undefined;
    const owner = this.launchOwner(opts, spawner);
    const unavailable = new Set<string>();
    let name: string;
    for (;;) {
      if (hardPinned) {
        if (this.nameInUse(identityName))
          return { ok: false, code: "already-exists", error: `the name "${identityName}" is hard-pinned (${opts.resolved ? "manifest-declared" : "--name/identity override"}) but is already held by a live incarnation (managed here, an unmanaged foreground/connector session, or another manager's agent); a pinned same-name collision refuses at accept - pick another name or despawn the existing one` };
        name = identityName;
      } else {
        try {
          name = this.uniqueName(identityName, unavailable);
        } catch (e) {
          return { ok: false, error: rejectionText(e) };
        }
      }
      // In user mode the name is the principal's actor. A fresh nkey in static/open mode
      // cannot collide with an earlier transcript. Use the connector's own startup proof.
      const eventOwner = opts.owner ?? (spawner === undefined ? undefined : parsePrincipalKey(spawner)?.owner);
      if (events && this.userMode && !runtime.spawnDelegated && eventOwner?.startsWith("u_")) {
        try {
          await checkEventStartup({
            workspaceRoot: this.workspaceRoot,
            space: this.space,
            principal: { owner: eventOwner, actor: name },
            retainedMessages: async () => {
              try {
                return (await this.ep.chatRetention()).senders;
              } catch (e) {
                // Older hosts do not issue this metadata grant. Do not infer that the name is
                // free or renumber it: preserve the requested candidate and let the launched
                // agent's existing startup check decide. Every other read failure stays loud.
                if (!isPermissionDenied(e)) throw e;
                console.error(`! event startup name check: missing $JS.API.STREAM.INFO.${chatStream(this.space)} permission; launching "${name}" unchanged so the agent checks its transcript state`);
                throw new LegacyEventCountPermissionError();
              }
            },
          });
        } catch (e) {
          if (e instanceof EventStateConflictError && !hardPinned) {
            unavailable.add(name);
            continue;
          }
          if (!(e instanceof LegacyEventCountPermissionError))
            return { ok: false, code: "failed-precondition", error: `cannot check event startup for ${eventOwner}.${name}: ${rejectionText(e)}` };
        }
        // Another spawn may have reserved the candidate while the disk/broker proof awaited.
        // Recheck in the same synchronous window as the cap and reservation below.
        if (this.nameInUse(name) || (!hardPinned && name !== identityName && this.namesCapacity.numberedIssued(name))) {
          if (!hardPinned) continue;
          return { ok: false, code: "already-exists", error: `the hard-pinned name "${name}" became occupied while checking event startup; pick another name` };
        }
      }
      break;
    }
    // The `chat_` prefix belongs to static chat sessions, whose aliases only `chat-session-open`
    // draws. Checked once the name is fixed by either branch above, so a persona name, a numbered
    // collision, a manifest name and a `--name` override all meet it, and before the reservation.
    if (name.startsWith(CHAT_ALIAS_PREFIX))
      return { ok: false, error: `the name "${name}" starts with "${CHAT_ALIAS_PREFIX}", which is reserved for chat sessions; pick another name` };
    // THE PER-OWNER CEILING, read in the same synchronous window as the reserve below rather than
    // beside the host capacity gate higher up: the count it takes must be the one the reservation
    // lands against, or a burst of concurrent launches for one owner each reads a count taken
    // before any of the others reserved, and they all pass. Nothing between here and the reserve
    // awaits. It refuses BEFORE `onEffect`, so the launch states `not-executed` and leaves no
    // name, no mint and no footprint behind.
    const overCap = this.seatCapRefusal(owner);
    if (overCap) return { ok: false, code: overCap.code, error: overCap.message, ...(overCap.details ? { details: overCap.details } : {}) };
    // Set once the agent's footprint (durables + creds, or the user-mode grant + secret files)
    // exists; cleared when a live slot takes ownership. If it survives to `finally`, the spawn threw
    // AFTER provisioning (buildLaunch / runtime.spawn) — the orphan-rollback tears it down. Carries
    // `userOwner` for a user-mode spawn so that rollback runs the revoke+shred branch, not just the
    // static durable teardown, which would leak the managed grant + files.
    // The RESERVED custody reference rides the rollback object: a spawn that launched the seat and
    // then threw (the activation CAS refuses a slot that is not this spawn's intent) reaches the
    // `finally` with the handle only in a local, so without this the terminal has nothing to reap
    // and retires over a live process. The slot row holds the same reference; this is the copy the
    // in-process rollback can actually read.
    let provisioned: TeardownTarget | undefined;
    // A carried resume's seat-private home, removed by the finally unless a live seat took it.
    let seatHome: string | undefined;
    // The lifecycle whose inline snapshot this spawn wrote: removed by the finally unless a live seat
    // took it. A write that failed sets nothing, so the finally never removes a file it did not make.
    let snapshotUid: string | undefined;
    // Taken right before the try so its finally is the only release; a refusal belongs above the
    // allocation, where there is no name to give back.
    hooks?.onEffect?.();
    if (!hardPinned && name !== identityName) this.namesCapacity.rememberNumbered(name);
    this.namesCapacity.reserve(name, owner);
    try {
      // A stable nkey identity assigned at spawn: the public key is the agent's card.id (threaded via
      // COTAL_ID); the seed is retained to mint matching creds later.
      const identity = newIdentity();
      // The incarnation's lifecycle UID (SPEC 13.1), minted ONCE per spawn: every lifecycle-keyed
      // broker resource (dm_/dlv_/chathist_ durables, ACL row, memberships) and the teardown
      // credential carry it, so a same-name successor's footprint is name-disjoint by construction.
      //
      // On the HOSTED enrollment arm (#1972) this value is PROVISIONAL. The host selects the
      // authoritative uid, because it alone reads the retirement tombstones that make a uid
      // permanently unusable, and the enrollment below rebinds this binding to what the host
      // returned before anything durable is keyed by it.
      let lifecycleUid = mintLifecycleUid();
      // Reserve the seat's custody reference NOW, before any durable row and long before the
      // launch. Minting it inside `runtime.spawn` (as it used to be) put the processes on disk
      // before anything recorded how to address them, so a crash in that window left a live seat
      // outside every manager and the successor retired the slot over it.
      const custody = this.reserveCustody(runtime);
      // ACCEPT SEAM (spawn-as-action): the incarnation identity is minted and NOTHING has
      // been provisioned yet — the action serve path binds the goal + replies the acceptance HERE. A
      // throw (bind conflict / duplicate goalId) aborts the spawn before provisioning: the catch below
      // returns the failure and the finally releases the reserve, so a refused accept leaves zero
      // footprint. The hosted enrollment arm is the exception, below. Blocking callers
      // (roster boot) pass no hooks and this is a no-op.
      // The ALLOCATED agent's addressing triple (the acceptance floor names what was actually
      // allocated, never the requested-but-unallocated name). Static/open key on DEV_OWNER + the
      // freshly-minted nkey; user mode keys on the derived owner (opts.owner, else a u_-owner spawner)
      // + the alias — derived HERE where the mode and owner source are in scope.
      const agentTriple = this.userMode
        ? { owner, actor: name, uid: lifecycleUid }
        : { owner, actor: identity.id, uid: lifecycleUid };
      // THE EVENT GRANT, derived from the principal that was actually ALLOCATED and never from the
      // display name. A display name is UI convenience: this mesh permits two live agents to carry
      // one, so a name-keyed channel fuses two principals onto one subject and, in auth mode,
      // authorizes both onto it from the same name-only value. `agentTriple` is the triple the child
      // will connect as in both modes, so the grant and the subject the session derives from its own
      // endpoint are the same derivation. Placed here rather than beside the refusal above
      // because this is the first point at which that triple exists, and still before every
      // provisioning call that consumes `allowPublish`.
      // THE OWN-CHANNEL RULE FOR THE EVENT PLANE, and it is the first thing this seam does.
      //
      // An event channel carries a session's tool inputs and outputs, which makes it the most
      // valuable read on the mesh, and `subscribe` / `allowSubscribe` / `allowPublish` are
      // caller-supplied on every spawn door. On a per-user-auth mesh the ledger's spawner envelope
      // already refuses a delegation wider than the spawner's own grant. On a STATIC mesh there is
      // no ledger, so nothing attenuates a caller-supplied ACL at all, and a caller that may spawn
      // may mint its child a read on any subject.
      //
      // What this rule asks is NOT who the caller is. That question has no answer on a static mesh:
      // an untargeted spawn carries no authorization mode, and the admin reach a static caller
      // holds is true by construction for everyone who can reach the handler. It asks whether the
      // event channel being minted BELONGS TO THE AGENT BEING CREATED, which the manager knows
      // because it has just allocated the principal.
      //
      // STATED LIMIT, because a fence whose gap is discovered later is worse than one whose gap is
      // written down. `eventChannelPrincipal` decodes a principal and refuses anything that is not exactly
      // two principal tokens, so a WILDCARD is not an event channel to it: `events.<owner>.>` and
      // `events.>` pass this rule untouched and are governed by ordinary ACL authority, which on a
      // user mesh is the envelope and on a static mesh is the spawn credential itself. So this
      // closes the concrete form and not the wildcard form. It is worth having anyway: it is the
      // form a caller writes when it knows which agent it wants to read, and the wildcard form is
      // the one an operator writes deliberately for an observer.
      const foreign = foreignEventChannels([...allowSubscribe, ...(allowPublish ?? [])], agentTriple.owner, agentTriple.actor);
      if (foreign.length) {
        // Throws rather than returning, because this seam is inside the accept body: the throw
        // unwinds before `onAccepted`, so no goal is bound and no identity is minted, and the
        // enclosing `finally` releases the reserved name. Returning here would be a value nobody
        // reads.
        throw new Error(
          `this spawn asks for another agent's event channel: ${foreign.join(", ")}. An ` +
            `agent may be granted its OWN event plane and no other, because that plane carries the ` +
            `session's tool inputs and outputs. Grant a reader out of band rather than through a ` +
            `spawn: ${this.readerRemedy(agentTriple.owner, foreign[0]!)}`,
        );
      }
      if (events) allowPublish = [...(allowPublish ?? []), connector.eventChannel!({ owner: agentTriple.owner, actor: agentTriple.actor })];
      await hooks?.onReadinessWindow?.(readinessTimeoutMs);
      // The hosted enrollment arm accepts only once the host has answered: the floor names the uid
      // the agent runs at, and before the host picks it there is no such uid to name.
      const hostedEnrollment = this.userMode && (opts.delegatedIntent !== undefined || this.remoteAuthority?.enrollManagedAgent !== undefined);
      // A once spawn's task is accepted with the spawn, before anything launches.
      let onceTask: { ref: GoalRef; deadlineAt?: number } | undefined;
      const acceptOnce = async (seat: { owner: string; actor: string; uid: string }): Promise<void> => {
        if (opts.once === undefined) return;
        onceTask = await hooks!.onOnce!({
          seat: { name, ...seat }, prompt: prompt!, spawner: this.spawnerName(spawner), deadlineMs: opts.once.deadlineMs, readinessDeadlineMs: readinessTimeoutMs,
          ...(connector.retireAfterExit ? { retire: connector.name } : {}),
        });
      };
      if (!hostedEnrollment) {
        await hooks?.onAccepted?.({ name, identity, lifecycleUid, agentTriple });
        await acceptOnce(agentTriple);
      }
      // In auth mode, mint the agent's creds from the space signing key and write them where the
      // spawned session reads them (COTAL_CREDS path). Open mesh → no creds. Scope = the resolved
      // subscribe/allowSubscribe (read) + allowPublish (post, default-deny).
      let credsPath: string | undefined;
      let issued: ManagedAgent["issued"];
      let userLaunch: UserAuthLaunch | undefined;
      let userOwner: string | undefined;
      let enrolled: ProvisionedUserAgent["enrolled"];
      if (this.userMode) {
        const prep = await this.provisionUserAgent(name, {
          eventPayloads,
          spawner,
          specOwner: opts.owner,
          subscribe,
          allowSubscribe,
          allowPublish,
          role,
          capabilities,
          label: ref,
          lifecycleUid,
          enrollmentCaller: authenticatedCaller ? { owner: authenticatedCaller.owner, actor: authenticatedCaller.actor } : undefined,
          delegatedIntent: opts.delegatedIntent,
          ...(opts.served !== undefined ? { spawnRequest: this.servedSpawnRequest(opts.served, authenticatedCaller) } : {}),
          // Hold the name at the UID the host enrolled for the intent's user before any later local
          // step runs, so no later failure, its refusal included, releases a lifecycle that only that
          // user's retirement intent retires.
          onEnrolled: opts.delegatedIntent
            ? (enrolled) => {
                provisioned = { id: principalKey(enrolled.owner, name).key, name, lifecycleUid: enrolled.lifecycleUid, userOwner: enrolled.owner, delegated: true, secretPaths: enrolled.files };
              }
            : undefined,
        });
        if ("error" in prep) {
          if (prep.refused !== undefined) hooks?.onUndone?.(prep.refused);
          return { ok: false, error: prep.error, ...(prep.refused !== undefined ? { code: prep.refused } : {}), ...(prep.details ? { details: prep.details } : {}) };
        }
        // THE HOST'S UID WINS (#1972). On the local arm this is the value passed in, unchanged. On
        // the hosted enrollment arm the host selected it, and from here every lifecycle-keyed thing
        // this spawn records — the slot, the launch, the managed row, the teardown credential — must
        // carry that value and not the provisional one, or the manager would address a footprint the
        // host never created.
        lifecycleUid = prep.lifecycleUid;
        userLaunch = prep.launch;
        userOwner = prep.owner;
        enrolled = prep.enrolled;
        provisioned = { id: principalKey(prep.owner, name).key, name, lifecycleUid, userOwner: prep.owner, ...(opts.delegatedIntent ? { delegated: true as const } : {}), secretPaths: prep.files, ...(custody ? { runtime: custody } : {}) };
        if (hostedEnrollment) {
          try {
            await hooks?.onAccepted?.({ name, identity, lifecycleUid, agentTriple: { owner: prep.owner, actor: name, uid: lifecycleUid } });
            await acceptOnce({ owner: prep.owner, actor: name, uid: lifecycleUid });
          } catch (e) {
            // A refused accept rolls the enrollment back: the host's grant through `provisioned`, and
            // this participant's secret family here, before the refusal returns. The hosted retirement
            // removes it too, but only once the host's release completes.
            const unshredded: CleanupFailure[] = [];
            await this.shredUserSecrets(unshredded, prep.files);
            if (unshredded.length) throw new Error(`${rejectionText(e)}; cleanup failed: ${describeCleanupFailures(unshredded)}`, { cause: e });
            throw e;
          }
        }
      } else if (this.auth) {
        // §13.1: reserve + activate this incarnation's DURABLE identity BEFORE any
        // broker footprint — the outer spawn intent first (slot row, phase `provisioning`),
        // then the SHARED core activation saga (reserve uid -> gate frozen -> head CAS -> reopen
        // LAST) over the key-pinned executor. The wire AUTHORITY principal is the incarnation-
        // unique nkey; the alias is protected by the name-keyed slot + freeSlot hold.
        await this.withLifecycleExecutor({ owner: DEV_OWNER, actor: identity.id, lifecycleUid, alias: name }, (t) =>
          activateStaticLifecycle(t, { owner: DEV_OWNER, alias: name, actor: identity.id, lifecycleUid, managerInstance: this.managerLifecycleUid, ownerInstanceId: this.managerInstanceId, runtime: custody }),
        );
        // From here the DURABLE registration exists: arm the rollback BEFORE minting, so a throw
        // between activation and provisioning still drives the exact-op static terminal (the
        // finally's deprovision tolerates absent files; the broker teardown is idempotent).
        provisioned = { id: identity.id, name, lifecycleUid, ...(custody ? { runtime: custody } : {}) };
        // Pre-create the agent's bind-only chat (+ DM + role TASK) durables and mint its scoped creds
        // — the shared onboarding step (provisionAgent). It runs on a short-lived PROVISIONER connection
        // (NOT the supervisor's long-lived endpoint), so the DM/DLV consumer-create surface exists only
        // for the provisioning window, never as a standing grant on the always-on daemon (residual 2).
        // The credential is BOUNDED (`expiresAt`) — the manager push-renews it ahead of expiry.
        const now = Math.floor(Date.now() / 1000);
        const exp = now + MANAGED_STATIC_TTL_SEC;
        // The credential is an ISSUANCE (SPEC 13.15): its caller rails carry a fresh generation
        // and its ceiling is recorded as evidence bound to this incarnation's ledger family. The
        // §13.1 ledger append (ledger BEFORE materialization) is the release's finalizer, so the
        // evidence activates only once the row exists, and the row exists only after the evidence
        // was staged. The agent learns the generation by reading the accepted row under its token.
        // The generation's horizon bounds every renewal of this incarnation's credential.
        issued = { generation: mintGeneration(now + STATIC_GENERATION_HORIZON_SEC), acceptedToken: mintAcceptedToken(), listing: true };
        const issuedAgent = { name, id: identity.id, lifecycleUid };
        const creds = await this.withIssuer((i) =>
          this.withProvisioner((prov) =>
            provisionAgent(prov, this.auth!, identity, {
              eventPayloads,
              subscribe,
              allowSubscribe,
              allowPublish,
              role,
              capabilities,
              ...(endpoints.length ? { endpointCapabilities: endpoints } : {}),
              lifecycleUid,
              expiresAt: exp,
              issued,
              issuance: this.issuanceSeam(i, "issue", issuedAgent, exp),
            }),
          ),
        );
        // Store first (the source of truth), then materialize: `buildLaunch` hands the CHILD this
        // file path, so the cred must exist as a file regardless of the store behind the seam. The
        // manager's ONE store (injected for hosted, workstation FS locally).
        const secrets = this.secrets;
        // LIFECYCLE-KEYED (SPEC 13.1 on the FS): the incarnation's cred file embeds its uid, so a
        // replayed/stale teardown can never address a same-name successor's credential.
        credsPath = agentLifecycleSecretFilePaths(this.workspaceRoot, this.space, name, lifecycleUid).creds;
        await secrets.put(agentSecretKeyForFile(credsPath, this.space), creds);
        await materializeSecretToFile(secrets, agentSecretKeyForFile(credsPath, this.space), credsPath);
        provisioned = { id: identity.id, name, lifecycleUid, secretPaths: { creds: credsPath }, ...(custody ? { runtime: custody } : {}) }; // footprint now exists — the finally rolls it back if the spawn throws
      }
      // Per-agent cwd overrides the manager's shared workspace root, so agents can be rooted at
      // arbitrary folders/repos. A relative path resolves against the workspace root; omitted → the
      // agent shares the workspace root (the prior, unchanged behavior).
      // The realpath the admission check above already resolved (#385 item 2) — never re-resolved here,
      // so the admission refusal and the launch cwd can never disagree on the same request.
      const cwd = resolvedCwd ?? this.workspaceRoot;
      // An inline persona's snapshot, and its catalog copy when saved, are written here: after the
      // grant (the static issuance, the user-auth ledger, a hosted enrollment that may replace the
      // uid) and before launch, so a refused grant leaves neither file and the snapshot carries the
      // final uid. A copy that loses a create race throws, and the finally rolls the grant back.
      if (inline) {
        configPath = writeInlineSnapshot(this.workspaceRoot, lifecycleUid, { name, role, model, variant, description: def.description, body: def.persona });
        snapshotUid = lifecycleUid;
        if (catalogCopy) saveAgentFile(agentFilePath(this.workspaceRoot, ref), catalogCopy, { createOnly: true });
      }
      if (configPath === undefined) throw new Error("internal: the persona file is missing at launch");
      const configSha256 = this.fileDigest(configPath);
      const manifestPath = opts.launchRef
        ? join(this.workspaceRoot, ".cotal", "run", `${opts.launchRef.runId}.json`)
        : undefined;
      const manifestSha256 = manifestPath ? this.fileDigest(manifestPath) : undefined;
      const launchOpts: LaunchOpts = {
        ...hostFields,
        name,
        role,
        // User mode: the principal IS the identity (the endpoint derives card.id from owner+actor);
        // no nkey id, no static creds.
        id: userLaunch ? undefined : identity.id,
        creds: credsPath,
        userAuth: userLaunch,
        // The incarnation's lifecycle UID: the agent endpoint binds its lifecycle-keyed dm/dlv/
        // chathist durables by this exact value (its creds pin the same names, so a mismatch fails
        // at the broker, never silently).
        lifecycleUid,
        acceptedToken: issued?.acceptedToken,
        configPath,
        model,
        variant,
        launchOptions,
        // Fork an existing session into the mesh. Taken straight from `opts.resume` (the imperative
        // control arg), never from `opts.resolved` — so the manifest launch path carries no resume by
        // construction. An unsupported connector throws here before any process is spawned.
        resume: opts.resume,
        reopenSession,
        // Initial prompt: the `--prompt` flag, or the manifest entry's `prompt:` on a resolved launch.
        // A reopened session already had its kickoff turn, so it is not submitted again. A once
        // seat gets its prompt as its one relayed task instead.
        prompt: reopenSession === undefined && opts.once === undefined ? prompt : undefined,
        ...(opts.once !== undefined ? { once: true } : {}),
        // The SAME access set the creds were minted from (above) — forwarded so the session's
        // runtime read/post set matches its credentials. Without this a manifest-spawned agent
        // (materialized persona has no access frontmatter) has no channel set to read and joins
        // nothing, even though its creds authorize the manifest's channels.
        subscribe,
        allowSubscribe,
        allowPublish,
        capabilities,
        // Always the list the launch resolved, `[]` included, so the session never reads a persona
        // file that may have changed since.
        endpoints: copyPersonaEndpoints(personaEndpoints) ?? [],
        events,
        eventPayloads,
        cwd,
      };
      // A delegated seat gets no local launch at all: no launch-material file, control token or
      // manager path is produced for it, only the handoff its runtime writes into the child.
      let spec: LaunchSpec | undefined;
      let handle: AgentHandle;
      if (runtime.spawnDelegated) {
        const handoff = this.composeManagedHandoff(enrolled!.material, enrolled!.actorToken);
        if (this.delegatedLaunched.has(lifecycleUid))
          throw new Error(`lifecycle ${lifecycleUid} was already handed to runtime "${runtime.kind}"; a lifecycle is handed off at most once`);
        this.delegatedLaunched.add(lifecycleUid);
        const holder = retainConnectorSeat(this.managerInstanceId, name);
        handle = runtime.spawnDelegated(
          { agent, persona: readFileSync(configPath, "utf8"), managerInstanceId: this.managerInstanceId, role, model, variant, prompt, launchOptions: launchOptions as Record<string, string> | undefined, events, eventPayloads },
          handoff,
        );
        this.watchConnectorHolder(handle, holder);
      } else {
        if (carried) {
          seatHome = join(this.workspaceRoot, ".cotal", "seat-homes", lifecycleUid);
          mkdirSync(seatHome, { recursive: true, mode: 0o700 });
          launchOpts.carried = { home: seatHome, transcript: carried.path, cwd };
        }
        spec = connector.buildLaunch(launchOpts);
        if (carried) this.transcripts!.consume(opts.resumeClaim!, opts.resume!);
        spec.env = { ...spec.env, COTAL_MANAGER_INSTANCE: this.managerInstanceId };
        handle = await this.spawnCustodied(runtime, name, spec, cwd, custody);
      }
      if (onceTask && !handle.waitForExit)
        throw new Error(`once: runtime "${handle.kind}" cannot prove the seat's exit, which is what ends its task when the seat goes first`);
      const launchedAt = Date.now();
      hooks?.onLaunched?.(); // The "launched" progress edge (process spawned, pre-presence)
      const managed: ManagedAgent = {
        name,
        role,
        agent,
        ...(seatHome ? { seatHome } : {}),
        id: userLaunch ? principalKey(userLaunch.owner, name).key : identity.id,
        lifecycleUid,
        // The lifecycle-keyed family this spawn just materialized (absent on an open mesh) — the
        // recorded truth teardown/preservation/health consume, never re-derived by name.
        secretPaths: provisioned?.secretPaths,
        ...(userLaunch ? { userOwner } : { seed: identity.seed }),
        ...(opts.delegatedIntent ? { delegated: true as const } : {}),
        ...(issued ? { issued } : {}),
        spawner: spawner ?? this.ep.ref().id,
        authorityParent: userLaunch && spawner && parsePrincipalKey(spawner) ? spawner : undefined,
        startedAt: Date.now(),
        handle,
        control: spec?.control,
        ...(spec ? {} : { handedOff: true as const }),
        launch: {
          runtime: runtime.kind,
          source: opts.resolved
            ? {
                kind: "manifest",
                runId: opts.launchRef?.runId,
                requested: opts.launchRef?.requested ?? opts.resolved.name,
                hash: opts.launchRef?.hash ?? opts.resolved.hash,
                configPath,
                configSha256,
                manifestSha256,
              }
            : inline
              ? { kind: "inline", ref, configPath, configSha256 }
              : { kind: "persona", ref: opts.config ? identityName : ref, configPath, configSha256 },
          cwd,
          model,
          variant,
          // The kickoff prompt is part of the launch form: a stale-restart re-submits it, so the
          // recorded launch must carry it for the restart gate (and preserve) to see it. A once
          // seat's prompt is its task, which no relaunch may submit again.
          prompt: onceTask ? undefined : prompt,
          subscribe,
          allowSubscribe,
          allowPublish,
          capabilities,
          ...(personaEndpoints?.length ? { endpoints: copyPersonaEndpoints(personaEndpoints) } : {}),
          events,
          eventPayloads,
          shareTools: opts.shareTools,
          forkSource: opts.resume,
          ...(opts.resume !== undefined && spec?.resumeRecordPath ? { resumeRecordPath: spec.resumeRecordPath } : {}),
          ...(carried ? { carried: { transcriptSha256: carried.sha256, host: carried.sourceHost, transferredAt: carried.stagedAt } } : {}),
          // Opaque values may contain secrets. Preserve only their keys and require the referenced
          // persona/manifest to resolve the values again; imperative overrides have no safe payload.
          unresolvedLaunchOptionKeys:
            opts.launchOptions && Object.keys(opts.launchOptions).length
              ? Object.keys(opts.launchOptions).sort()
              : undefined,
        },
        // A delegated agent is never restarted (SPEC 13.16), and a once seat never runs its task
        // twice, so neither slot arms recovery.
        ...(onceTask ? { once: { ref: onceTask.ref, ...(connector.retireAfterExit ? { retire: connector.name } : {}) } } : {}),
        ...(spec && (connector.supportsSessionContinuation || opts.supervise !== undefined) && !opts.delegatedIntent && !onceTask
          ? {
              restart: {
                opts: launchOpts,
                sessionStatePath: spec.sessionStatePath,
                crashes: [],
                recovering: false,
                armed: false,
                ...(opts.supervise !== undefined ? { policy: opts.supervise } : {}),
              },
            }
          : {}),
      };
      // The DURABLE slot takes the `active` phase before the in-memory row takes the
      // name — a crash between the two leaves an active-but-unadopted slot the boot sweep
      // terminalizes (never an untracked orphan). Static auth only; a failed CAS fails the spawn
      // (the finally's rollback then drives the exact-op terminal).
      if (this.auth && !this.userMode) {
        await this.withLifecycleExecutor({ owner: DEV_OWNER, actor: managed.id, lifecycleUid, alias: name }, async (t) => {
          const slot = await readStaticSlot(t, DEV_OWNER, name);
          if (slot === undefined || slot.row.lifecycleUid !== lifecycleUid || slot.row.phase !== "provisioning")
            throw new Error(`the static slot for "${name}" is ${slot === undefined ? "absent" : `${slot.row.phase} at uid ${slot.row.lifecycleUid}`}, not this spawn's provisioning intent; refusing to take the slot`);
          // The custody reference rides the SAME CAS as activation: a crash after this write leaves
          // an active slot a successor can reap by reference, never a live seat nobody addresses.
          await casStaticSlot(t, { ...slot.row, phase: "active", ...(handle.reference ? { runtime: handle.reference } : {}) }, slot.revision);
        });
      }
      this.agents.set(name, managed);
      this.namesCapacity.placed(name);
      if (managed.once) this.watchOnceExit(managed);
      // The live slot now owns teardown — freeSlot deprovisions this identity on exit — so the
      // orphan-rollback in `finally` no longer applies to it.
      provisioned = undefined;
      seatHome = undefined;
      snapshotUid = undefined;
      // #159 B1: reply on a REAL outcome, not a timer. Wait for the agent to actually join the mesh
      // (presence) → started, the child to exit → failed (with its last output; already reaped), or
      // neither in time → uncertain. `✓ started` therefore means "it joined", never just "a process
      // launched", except for a launch whose options make the harness wait for the operator first: that
      // one is ready once its process runs, and its reply names the screen it waits at.
      const operator = connector.waitsForOperator?.(launchOptions);
      const readiness = await this.awaitReadiness(managed, readinessTimeoutMs, operator === undefined ? {} : { operator });
      // Deliberately stopped mid-launch: reaped by onExit, and the despawn/stop path owns the
      // goal terminal. Return BEFORE the failed/uncertain arms so this emits no competing
      // outcome and does not re-arm an exit watcher on an agent already gone.
      if (!readiness.ok && readiness.deliberate) { hooks?.onTerminalDeferred?.(); return { ok: false, error: readiness.detail }; }
      if (!readiness.ok && !readiness.uncertain) { // failed → already reaped
        // A reopen fails before readiness when the host no longer has the recorded session, which
        // is refused rather than replaced by an empty one; name the record that pins it.
        const error = reopenSession === undefined ? readiness.detail
          : `${readiness.detail} (continuity: exact was reopening recorded session ${reopenSession}; if the harness no longer has it, ` +
            `remove ${join(this.workspaceRoot, ".cotal", "continuity", `${name}.json`)} to start a new session)`;
        if (managed.once) managed.once.stopReason ??= "launch-failed";
        await hooks?.onOutcome?.({ kind: "failed", data: { error } });
        return { ok: false, error };
      }
      // Started OR uncertain: the agent stays managed, so wire the ongoing exit reaper (it reaps a later
      // death — including one that follows an `uncertain` verdict, which deliberately does NOT deprovision).
      if (!readiness.ok) {
        this.watchExit(managed);
        if (managed.launch.carried) void this.refuseLateCarriedFork(managed, readinessTimeoutMs);
        // A once seat is never left running with nothing to do, and its stop does not wait on the
        // spawn's terminal, whose write can stall. The spawn keeps that terminal: the stop lets go
        // of the spawn goal first. Its task was never served and is cancelled with the verdict.
        if (managed.once) {
          this.agentGoals.delete(managed.name);
          this.stopOnceSeat(managed, "readiness-timeout");
        }
        await hooks?.onOutcome?.({ kind: "uncertain", data: { reason: readiness.detail, ...(readiness.running ? { running: true } : {}) } });
        return { ok: false, error: readiness.detail };
      }
      // A once seat whose connector needs a confirmed startup is served only on that outcome. Any
      // other ends it like a seat that never joined: stopped before the failed terminal, and its
      // task, never served, cancelled with the verdict.
      if (onceTask && connector.onceNeedsConfirmed !== undefined) {
        const startup = await this.awaitStartupOutcome(managed, launchedAt, readinessTimeoutMs);
        if (managed.terminalizing || this.leaseStopping) { hooks?.onTerminalDeferred?.(); return { ok: false, error: `${name} was stopped before its startup ended` }; }
        if (startup !== "confirmed") {
          const watch = { ready: "opened its input screen without the prompt", failed: "failed", exited: "saw the seat exit", pending: "had not ended" }[startup];
          const error = `${name} joined, but ${connector.onceNeedsConfirmed}: its startup watch ${watch}, so it cannot take a once task`;
          this.watchExit(managed);
          this.agentGoals.delete(managed.name);
          managed.once!.stopReason ??= "launch-failed";
          this.stopOnceSeat(managed, "launch-failed");
          await hooks?.onOutcome?.({ kind: "failed", data: { error } });
          return { ok: false, error };
        }
      }
      // A plain seat on such a connector starts whatever its startup showed. One whose watch opened the
      // input screen without the prompt is not woken by mesh traffic, and the spawn says so instead of
      // starting it silently without push (#5737).
      if (!onceTask && connector.idleWakeNeedsConfirmed !== undefined && runtime.reportsStartupOutcome) {
        const startup = await this.awaitStartupOutcome(managed, launchedAt, readinessTimeoutMs);
        if (managed.terminalizing || this.leaseStopping) { hooks?.onTerminalDeferred?.(); return { ok: false, error: `${name} was stopped before its startup ended` }; }
        if (startup === "ready") {
          managed.startupNotice = connector.idleWakeNeedsConfirmed;
          console.error(`! ${name}: ${connector.idleWakeNeedsConfirmed}`);
        }
      }
      if (managed.launch.carried) {
        const refused = await this.refuseCarriedFork(managed, readinessTimeoutMs);
        if (refused !== undefined && managed.terminalizing) { hooks?.onTerminalDeferred?.(); return { ok: false, error: refused }; }
        if (refused !== undefined) {
          this.stopHandle(managed, false, "carried-fork-refused");
          this.trackStoppedHandle(managed, true, "carried-fork-refused");
          await hooks?.onOutcome?.({ kind: "failed", data: { error: refused } });
          return { ok: false, error: refused };
        }
      }
      if (managed.restart) {
        if (connector.supportsSessionContinuation) {
          try {
            await this.armSessionRecovery(managed);
            // The capability flags are only a claim. An exact seat is recorded once the connector
            // has proved its session over its authenticated control endpoint, never before.
            if (exact && !managed.restart.armed)
              throw new Error("continuity: exact needs the connector to prove its session over an authenticated control endpoint, and it supplied none");
            managed.launch.sessionId = this.readManagedSession(managed);
            if (reopenSession !== undefined && managed.launch.sessionId !== reopenSession)
              throw new Error(`continuity: exact asked for session ${reopenSession}, the connector bound ${managed.launch.sessionId}`);
            if (exact) {
              managed.continuity = { space: this.space, name, connector: agent, cwd };
              this.recordContinuity(managed, managed.launch.sessionId);
            }
          } catch (error) {
            const detail = `${managed.name} joined, but its exact host session could not be bound for supervised recovery: ${rejectionText(error)}`;
            this.stopHandle(managed, false, "session-bind-failed");
            this.trackStoppedHandle(managed, true, "session-bind-failed");
            await hooks?.onOutcome?.({ kind: "failed", data: { error: detail } });
            return { ok: false, error: detail };
          }
        } else {
          managed.restart.armed = true;
        }
        if (managed.restart.policy) {
          try {
            this.recordSeat(managed);
          } catch (error) {
            const detail = `${managed.name} joined, but supervise cannot cover a manager restart for it: ${rejectionText(error)}`;
            this.stopHandle(managed, false, "supervise-record-failed");
            this.trackStoppedHandle(managed, true, "supervise-record-failed");
            await hooks?.onOutcome?.({ kind: "failed", data: { error: detail } });
            return { ok: false, error: detail };
          }
        }
      }
      // An unsupervised seat a successor could adopt keeps a record too; one that cannot be written
      // costs only that adoption, so the spawn stands and the line says so.
      if (!managed.restart?.policy) this.refreshSeatRecord(managed);
      this.watchExit(managed);
      // Reply with the id the slot actually carries (user-mode: the owner.actor principal —
      // presence, ps, and the manifest ownership ledger all key on it; the throwaway static nkey
      // would never match and down -f would treat the agent as foreign).
      // `lifecycleUid` rides the reply so callers that record this spawn (the manifest ledger) can
      // later address the incarnation's lifecycle-keyed artifacts without re-deriving by name.
      // OMIT an absent role: the goal terminal commits this data through the strict
      // canonicalJson (undefined never coerces to null, SPEC 13.6), so a role-less spawn would
      // otherwise fail its succeeded terminal. The CLI/connector already render an absent role as
      // "no role", so dropping the key preserves the reply (surfaced by readiness:live).
      // A host that granted other channels than this spawn asked for: the receipt carries both.
      const acl = enrolled ? enrolledAcl({ allowSubscribe, allowPublish }, enrolled.material) : undefined;
      const okData = { name, agent, id: managed.id, mode: handle.kind, streamsTerminal: runtime.streamsTerminal, lifecycleUid, ...(role !== undefined ? { role } : {}), ...(opts.eventsNotice !== undefined ? { eventsNotice: opts.eventsNotice } : {}), ...(managed.startupNotice !== undefined ? { startupNotice: managed.startupNotice } : {}), ...(acl ? { acl } : {}), ...(readiness.operator !== undefined ? { waitingFor: readiness.operator } : {}), ...(onceTask ? { once: { goalId: onceTask.ref.goalId, ...(onceTask.deadlineAt !== undefined ? { deadlineAt: onceTask.deadlineAt } : {}) } } : {}) };
      // The task is served once the succeeded terminal is written, so a served task always has it
      // and a successor reads it as the readiness verdict. Every failure arm above ran before it. A
      // terminal this call did not commit never served the task: the seat is stopped, which cancels it.
      const committed = await hooks?.onOutcome?.({ kind: "succeeded", data: okData });
      if (onceTask && committed === true) this.openOnceDelivery(onceTask.ref);
      else if (onceTask) {
        this.agentGoals.delete(managed.name);
        managed.once!.stopReason ??= "launch-failed";
        this.stopOnceSeat(managed, "launch-failed");
      }
      return { ok: true, data: okData };
    } catch (e) {
      // Failure after reserve (provision / launch threw): the slot was never live, so no cold-start
      // was paid — the reserved rollback (finally) is enough, no cooling stamp.
      // Keep the envelope's code and lifecycle details on the ControlReply so the serve boundary
      // can carry the refusal's classification and barrier to the caller. An extension can throw
      // any value, and an envelope's `message` is only typed as a string, so the refusal text always
      // comes from rejectionText; telling an envelope apart is guarded because a thrown Proxy can
      // throw from `instanceof` or from its own fields.
      const error = rejectionText(e);
      try {
        if (e instanceof EpEnvelopeError)
          return controlReplyFromThrown(e, error);
      } catch { /* not a readable envelope */ }
      return { ok: false, error };
    } finally {
      this.namesCapacity.release(name);
      if (seatHome) rmSync(seatHome, { recursive: true, force: true });
      // A failed removal is logged, never thrown, so the grant's teardown below is still scheduled.
      const snapshotGone = snapshotUid === undefined || this.dropInlineSnapshot(name, snapshotUid);
      // Minted but never handed to a live slot (buildLaunch / runtime.spawn threw after mint) → tear the
      // orphan down (detached, fail-loud) so a failed spawn leaves no creds/durables behind (#159 B).
      if (provisioned) {
        // Settled when this spawn wrote no snapshot or removed the one it wrote. A file its write
        // refused is not this lifecycle's, so the terminal leaves the uid's path alone; a removal
        // that failed is the terminal's to retry and report.
        const orphan: TeardownTarget = { ...provisioned, ...(snapshotGone ? { snapshotSettled: true as const } : {}) };
        // The host enrolled this UID for the intent's user, so only that user's retirement intent
        // retires it, and its name stays held for retireDelegatedAgent.
        const p = orphan.delegated ? parsePrincipalKey(orphan.id) : null;
        if (p) this.retirement.hold(orphan.name, { opId: managedRetirementOpId(orphan.lifecycleUid), owner: p.owner, actor: p.actor, target: orphan, startedAt: Date.now() });
        this.trackDeprovision(orphan, "(orphaned spawn)");
      }
    }
  }

  /** Preflight the whole inventory before launching its first process, then adopt each exact retained
   * principal without provisioning. A later runtime launch failure is reported per-agent, but malformed
   * or missing inventory material can never produce a partially resumed set. */
  async resumePreserved(
    inventory: ManagerResumeInventory,
  ): Promise<ManagerResumeResult> {
    if (this.execution === "none")
      return { ok: false, agents: [], error: this.executionRefusal() };
    const release = this.beginLifecycle(true);
    if (!release) return { ok: false, agents: [], error: this.maintenanceError() };
    const batchReservations: string[] = [];
    const prepared = new Map<string, PreparedResume>();
    try {
      if (inventory.version !== "cotal-manager-resume/v2")
        return { ok: false, agents: [], error: `unsupported manager resume inventory version ${String(inventory.version)}` };
      if (inventory.space !== this.space)
        return { ok: false, agents: [], error: `resume inventory belongs to space "${inventory.space}", not "${this.space}"` };
      // The caller keeps its inventory, so it is copied before the first await: a later write to it
      // cannot change what a resumed seat launches with or what the next preservation retains.
      const entries = structuredClone(inventory.agents);
      const seen = new Set<string>();
      const principals = new Set<string>();
      const orphans: Array<{ principal: string; reference: RuntimeReference }> = [];
      await this.ep.waitForPresenceSnapshot();
      const liveRoster = this.ep.getRoster().filter((presence) => presence.status !== "offline");
      const occupancy = this.occupancy();
      if (occupancy.used + entries.length > MAX_AGENTS)
        return { ok: false, agents: [], error: `resume inventory of ${entries.length} would exceed manager capacity (${this.occupancyText(occupancy)})` };
      for (const entry of entries) {
        if (seen.has(entry.name))
          return { ok: false, agents: [], error: `resume inventory contains duplicate agent name "${entry.name}"` };
        seen.add(entry.name);
        // A manager-local retirement hold is stronger and more precise than presence. The stopped
        // predecessor can remain roster-live until its TTL/offline update lands, but that stale row
        // must not hide the durable teardown state the manager already owns. Refuse and re-drive the
        // exact held lifecycle before consulting generic principal liveness. A confirmed terminal has
        // already removed the hold, so fresh-lifecycle resume still reaches the fail-closed roster gate.
        const held = this.retirement.held(entry.name);
        if (held) {
          void this.deprovision(held.target).catch(() => {});
          return {
            ok: false,
            agents: [],
            error: `retained agent "${entry.name}" is reserved pending retirement: its previous lifecycle ${held.target.lifecycleUid} still owns the alias${held.lastError ? ` (last attempt: ${held.lastError})` : ""}; retrying re-drives that exact teardown`,
          };
        }
        let principal: string;
        try {
          principal = entry.identity.mode === "user"
            ? principalKey(entry.identity.owner, entry.identity.actor).key
            : principalKey(DEV_OWNER, entry.identity.id).key;
        } catch (e) {
          return { ok: false, agents: [], error: `invalid retained principal for ${entry.name}: ${rejectionText(e)}` };
        }
        if (principals.has(principal))
          return { ok: false, agents: [], error: `resume inventory contains duplicate principal "${principal}"` };
        principals.add(principal);
        const confirmedPredecessor = this.retirement.predecessor(entry.name);
        const principalIsLive = liveRoster.some((presence) => {
          if (presence.card.id !== principal) return false;
          return confirmedPredecessor === undefined ||
            confirmedPredecessor.principal !== principal ||
            confirmedPredecessor.lifecycleUid !== presence.lifecycleUid ||
            presence.card.name !== entry.name ||
            entry.identity.lifecycleUid === confirmedPredecessor.lifecycleUid;
        });
        if (principalIsLive) {
          const orphan = await this.orphanedResumeSeat(entry, principal, liveRoster);
          if (!orphan)
            return { ok: false, agents: [], error: `retained principal "${principal}" is already live and this runtime cannot authoritatively adopt it` };
          orphans.push({ principal, reference: orphan });
        }
        if (this.agents.has(entry.name) || this.namesCapacity.isReserved(entry.name))
          return { ok: false, agents: [], error: `retained agent "${entry.name}" is already managed or reserved` };
      }
      for (const entry of entries) {
        this.namesCapacity.reserve(entry.name, resumeOwner(entry));
        batchReservations.push(entry.name);
      }
      const preflight: Array<{ name: string; reply: ControlReply }> = [];
      for (const entry of entries) {
        const reply = await this.resumePreservedAgent(entry, true, true, prepared);
        preflight.push({ name: entry.name, reply });
      }
      const preflightFailures = preflight.filter(({ reply }) => !reply.ok);
      if (preflightFailures.length)
        return {
          ok: false,
          agents: preflight,
          error: `${preflightFailures.length} retained agent${preflightFailures.length === 1 ? "" : "s"} failed preflight`,
        };
      // Only now, with the whole inventory through preflight, is an orphan reaped: a refused batch
      // leaves every seat as it found it.
      for (const { principal, reference } of orphans) {
        const refusal = await this.reapOrphanedResumeSeat(principal, reference);
        if (refusal) return { ok: false, agents: [], error: refusal };
      }
      const agents: Array<{ name: string; reply: ControlReply }> = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const reply = await this.resumePreservedAgent(entry, false, true, prepared);
        agents.push({ name: entry.name, reply });
        if (!reply.ok) {
          for (const skipped of entries.slice(i + 1))
            agents.push({ name: skipped.name, reply: { ok: false, error: `not launched because ${entry.name} failed` } });
          return { ok: false, agents, error: reply.error };
        }
      }
      if (this.resumeAttemptId) this.resumeAwaitingCommit = true;
      return { ok: true, agents };
    } finally {
      for (const name of batchReservations) {
        this.namesCapacity.release(name);
      }
      // Preflight builds every launch before any child starts, so a refused batch, a failed launch,
      // or the agents skipped after it leave built specs no runtime ever received.
      for (const { spec, spawned } of prepared.values()) {
        if (spawned) continue;
        try {
          discardLaunchArtifacts(spec.artifacts);
        } catch (e) {
          console.error(`! resume: ${rejectionText(e)}`);
        }
      }
      release();
    }
  }

  /** Re-read every retained identity input and its current authority without provisioning. This runs
   * during whole-inventory preflight, immediately before each individual spawn, and at commit. */
  private async validateRetainedAuthority(
    entry: ManagerResumeAgent,
  ): Promise<Pick<PreparedResume, "id" | "creds" | "userAuth">> {
    const referenceError = this.inventoryReferenceError(entry);
    if (referenceError) throw new Error(`retained agent ${entry.name}: ${referenceError}`);
    // THE OWN-CHANNEL RULE, ON THE RESUME DOOR, and it belongs here rather than beside the launch
    // because BOTH resume paths funnel through this function and neither may skip it.
    //
    // A resume document is admin-supplied JSON. It carries the ACLs the managed row is re-armed
    // from, and `renewManagedStaticCred` re-mints the credential out of that row at half TTL, so a
    // foreign event channel written into an inventory becomes a minted read on another agent's tool
    // inputs and outputs one renewal later. In static mode nothing else stops it: the checks below
    // pin the credential's PATH, its IDENTITY and the broker's acceptance of it, and say nothing at
    // all about its ACL. User mode compares the adopted authority's ACL against the inventory's, so
    // it refuses a divergence on both fields already, but it refuses it as DRIFT rather than as this
    // rule, and an inventory whose record and credential agree with each other and disagree with
    // this rule is exactly the document an operator would not notice.
    //
    // Refuses rather than strips. Silently narrowing an admin document would leave the operator
    // holding a record that says one thing and a mesh that does another, and the whole reason this
    // is reachable is that nobody reads the record.
    {
      const owner = entry.identity.mode === "user" ? entry.identity.owner : DEV_OWNER;
      // The ACTOR HALF IS THE PRINCIPAL, never the display name. In user mode the row this
      // document re-arms is keyed by `identity.actor` (it is what the provider adopts below and
      // what every liveness check reads), and an inventory supplies `name` and `identity.actor`
      // independently, so judging the channel against `name` would judge it against the half that
      // does not own the plane.
      const actor = entry.identity.mode === "user" ? entry.identity.actor : entry.identity.id;
      const foreign = foreignEventChannels(
        [...(entry.launch.allowSubscribe ?? []), ...(entry.launch.allowPublish ?? [])],
        owner,
        actor,
      );
      if (foreign.length)
        throw new Error(
          `retained agent ${entry.name}: its record claims another agent's event channel ` +
            `(${foreign.join(", ")}). An agent may hold its OWN event plane and no other, because that ` +
            `plane carries the session's tool inputs and outputs. Remove it from the inventory and ` +
            `grant the reader out of band instead: ` +
            `${this.readerRemedy(owner, foreign[0]!)}`,
        );
    }
    if (entry.identity.mode === "open") {
      if (this.auth || this.userMode)
        throw new Error(`retained agent ${entry.name} is open-mode but the current manager is authenticated`);
      return { id: entry.identity.id };
    }
    if (entry.identity.mode === "static") {
      if (!this.auth || this.userMode)
        throw new Error(`retained agent ${entry.name} is static-auth but the current manager is not`);
      // CLOSED candidate set, not an open path: the lifecycle-keyed derivation (this generation's
      // layout) or the name-keyed one (a pre-split inventory being carried across the upgrade).
      // Anything else is a foreign path and refused exactly as before.
      const candidates = [
        resolve(agentLifecycleSecretFilePaths(this.workspaceRoot, this.space, entry.name, entry.identity.lifecycleUid).creds),
        resolve(agentSecretFilePaths(this.workspaceRoot, this.space, entry.name).creds),
      ];
      const expected = resolve(entry.identity.credential.path);
      if (!candidates.includes(expected))
        throw new Error(`retained credential reference for ${entry.name} is not a manager-owned path (expected ${candidates.join(" or ")})`);
      let credentialText: string;
      try {
        // The lstat guards the FS MATERIALIZATION the child will read at launch; the identity check
        // runs on the store's value — the source of truth (byte-identical here, the local FS
        // composition resolves the key to this same path).
        const st = lstatSync(expected);
        if (!st.isFile() || st.isSymbolicLink()) throw new Error("not a regular non-symlink file");
        const stored = await this.secrets.get(agentSecretKeyForFile(expected, this.space));
        if (stored === undefined) throw new Error("the credential is not in the secret store");
        credentialText = stored;
        const actual = idFromCreds(credentialText);
        if (actual !== entry.identity.id)
          throw new Error(`retained credential identity ${actual} does not match inventory principal ${entry.identity.id}`);
      } catch (e) {
        throw new Error(`retained credential for ${entry.name} is unusable: ${rejectionText(e)}`);
      }
      const accepted = await this.probeStaticCredential(credentialText);
      if (!accepted.ok)
        throw new Error(`retained credential for ${entry.name} is not accepted by the current broker (${accepted.reason})`);
      return { id: entry.identity.id, creds: expected };
    }
    if (!this.userMode)
      throw new Error(`retained agent ${entry.name} is user-auth but the current manager is not`);
    try {
      const provider = resolveAuthProvider();
      // Mirror the static branch's expected-path discipline, but pin the WHOLE secret FAMILY as ONE
      // unit: all three of {actorToken, sentinelCreds, health} must equal the lifecycle-keyed triple
      // (this generation) OR the name-keyed triple (a pre-split inventory carried across the upgrade).
      // A per-file OR-pin let a corrupt inventory MIX families (lifecycle token + legacy sentinel)
      // and, worse, left `health` UNPINNED entirely — an arbitrary recorded health path flowed into
      // the bearer argv and was `rmSync`'d at terminal teardown (inventory-as-delete-gadget). Pinning
      // the atomic family closes both: `health` is pinned by PATH EQUALITY (never by file existence,
      // so a transiently-absent health file still validates), and the store reads below key off the
      // RECORDED path, so a foreign path can neither pass the pin nor address a different row.
      // Both triples are derived under THIS manager's space, and the key builder is given
      // `this.space` rather than reading the segment out of the recorded path: an inventory row is
      // caller data, and a recorded path may not choose which tenant's material is addressed.
      const lifecycleFiles = agentLifecycleSecretFilePaths(this.workspaceRoot, this.space, entry.name, entry.identity.lifecycleUid);
      const legacyFiles = agentSecretFilePaths(this.workspaceRoot, this.space, entry.name);
      const recordedToken = resolve(entry.identity.actorToken.path);
      const recordedSentinel = resolve(entry.identity.sentinelCredential.path);
      const recordedHealth = resolve(entry.identity.health.path);
      const matchesFamily = (f: { actorToken: string; sentinelCreds: string; health: string }): boolean =>
        recordedToken === resolve(f.actorToken) && recordedSentinel === resolve(f.sentinelCreds) && recordedHealth === resolve(f.health);
      if (!matchesFamily(lifecycleFiles) && !matchesFamily(legacyFiles))
        throw new Error(`retained identity references for ${entry.name} are not one manager-owned secret family: all of actor-token, sentinel, and health must be the lifecycle-<uid> triple or the legacy name-keyed triple under ${agentCredsDir(this.workspaceRoot, this.space)} (no mixed families, no foreign health path)`);
      const secrets = this.secrets;
      const actorToken = await secrets.get(agentSecretKeyForFile(recordedToken, this.space));
      const sentinelCreds = await secrets.get(agentSecretKeyForFile(recordedSentinel, this.space));
      if (actorToken === undefined || sentinelCreds === undefined)
        throw new Error("the retained actor token / sentinel credential is not in the secret store");
      const adopted = this.remoteAuthority
        ? await this.remoteAuthority.validateRetainedAgent({
            owner: entry.identity.owner,
            actor: entry.identity.actor,
            lifecycleUid: entry.identity.lifecycleUid,
            actorToken,
            sentinelCreds,
          })
        : await provider.validateRetainedAgent({
            store: secrets,
            dir: userAuthStateDir(this.workspaceRoot, this.space),
            space: this.space,
            owner: entry.identity.owner,
            actor: entry.identity.actor,
            actorToken,
            sentinelCreds,
          });
      if (adopted.owner !== entry.identity.owner || adopted.actor !== entry.identity.actor)
        throw new Error(`auth provider returned a replacement principal; expected ${entry.identity.owner}.${entry.identity.actor}`);
      // Bind the inventory's uid to the CURRENT authority row BEFORE any spawn: a corrupt or
      // admin-supplied inventory naming a different incarnation is refused at pre-effect validation,
      // never left to broker-fail after the child is already running (SPEC §13.1).
      if (adopted.lifecycleUid !== entry.identity.lifecycleUid)
        throw new Error(`retained user authority for ${entry.identity.owner}.${entry.identity.actor} is incarnation ${adopted.lifecycleUid}, not the inventory's ${entry.identity.lifecycleUid}; a resume binds the exact recovered uid before any spawn (SPEC 13.1)`);
      if (!sameStrings(adopted.allowSubscribe, entry.launch.allowSubscribe) ||
          !sameStrings(adopted.allowPublish, entry.launch.allowPublish) ||
          !sameStrings(adopted.scope, entry.launch.capabilities) ||
          adopted.role !== entry.role || adopted.parent !== entry.authorityParent)
        throw new Error(`retained user authority for ${entry.identity.owner}.${entry.identity.actor} no longer matches the inventory`);
      return {
        userAuth: {
          owner: entry.identity.owner,
          actor: entry.identity.actor,
          sentinelCredsPath: entry.identity.sentinelCredential.path,
          bearerCmd: [
            ...bearerEntryArgv(),
            provider.agentBearerCommand,
            ...(this.remoteAuthority
              ? ["--exchange-url", this.remoteAuthority.agentBearerExchangeUrl]
              : ["--dir", userAuthStateDir(this.workspaceRoot, this.space)]),
            "--space", this.space,
            "--owner", entry.identity.owner,
            "--actor", entry.identity.actor,
            "--token-file", entry.identity.actorToken.path,
            "--health-file", entry.identity.health.path,
          ],
        },
      };
    } catch (e) {
      throw new Error(`retained user principal ${entry.identity.owner}.${entry.identity.actor} could not be reused: ${rejectionText(e)}`);
    }
  }

  /** The seat reference behind a live retained principal, when that seat is provably one a lost
   *  manager of this logical instance launched for this exact incarnation. The resume binds the
   *  launched handle's reference to the incarnation's active slot before it waits for readiness, and
   *  the coordinator journals `resume-active` only after that wait, so a coordinator crash between the
   *  two leaves `resume-intent` behind a live seat. Undefined for everything else, which stays refused:
   *  another incarnation's presence, a slot another instance owns, a runtime that cannot reap the
   *  reference, and user or open meshes, which keep no slot. */
  private async orphanedResumeSeat(entry: ManagerResumeAgent, principal: string, liveRoster: Presence[]): Promise<RuntimeReference | undefined> {
    if (!this.auth || this.userMode || entry.identity.mode !== "static") return undefined;
    const runtime = this.runtimeFor(entry.launch.runtime);
    if (typeof (runtime as Partial<CustodialRuntime>).reap !== "function") return undefined;
    if (liveRoster.some((p) => p.card.id === principal && p.lifecycleUid !== entry.identity.lifecycleUid)) return undefined;
    const slot = await this.readStaticReconcileSlot(entry.name);
    if (slot?.phase !== "active" || slot.actor !== entry.identity.id || slot.lifecycleUid !== entry.identity.lifecycleUid) return undefined;
    if (ownedBySibling(slot, this.managerInstanceId)) return undefined;
    return slot.runtime?.kind === runtime.kind ? slot.runtime : undefined;
  }

  /** Reap a seat {@link orphanedResumeSeat} found, then wait for its principal to leave presence so
   *  the relaunch's readiness cannot match the dead seat's row. Returns the refusal when the reap
   *  proves nothing or the principal stays live, which means another process holds it. */
  private async reapOrphanedResumeSeat(principal: string, reference: RuntimeReference): Promise<string | undefined> {
    try {
      const evidence = await requireRuntimeReap(this.runtimeFor(reference.kind), reference);
      console.error(`resume: reaped orphaned seat ${reference.kind}:${reference.id} of retained principal "${principal}" (${evidence.detail})`);
    } catch (e) {
      return `retained principal "${principal}" is already live and its recorded seat ${reference.kind}:${reference.id} could not be reaped: ${rejectionText(e)}`;
    }
    const deadline = Date.now() + ORPHAN_PRESENCE_CLEAR_MS;
    while (this.ep.getRoster().some((p) => p.card.id === principal && p.status !== "offline")) {
      if (Date.now() >= deadline)
        return `retained principal "${principal}" is still live after its recorded seat ${reference.kind}:${reference.id} was reaped, so another process holds it and this runtime cannot authoritatively adopt it`;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    return undefined;
  }

  /** Validate/relaunch one retained inventory entry. Called through resumePreserved so all records
   * pass the same preflight before the first child is exposed, and through restartSupervisedSeat
   * with the one record a crashed manager left (`supervised`). */
  private async resumePreservedAgent(
    entry: ManagerResumeAgent,
    preflightOnly = false,
    batchReserved = false,
    prepared?: Map<string, PreparedResume>,
    supervised?: SupervisedRestart,
  ): Promise<ControlReply> {
    if (this.execution === "none") return { ok: false, error: this.executionRefusal() };
    const release = this.beginLifecycle(batchReserved);
    if (!release) return { ok: false, error: this.maintenanceError() };
    try {
      if (entry.space !== this.space)
        return { ok: false, error: `retained agent ${entry.name} belongs to space "${entry.space}", not "${this.space}"` };
      try {
        await this.loadSeatRuntime(entry.launch.runtime);
      } catch (e) {
        return { ok: false, error: `retained agent ${entry.name} requires runtime "${entry.launch.runtime}", which this manager cannot resolve: ${rejectionText(e)}` };
      }
      if (entry.launch.runtime !== this.runtimeFor(entry.launch.runtime).kind)
        return { ok: false, error: `retained agent ${entry.name} requires runtime "${entry.launch.runtime}", which this manager cannot resolve` };
      const nameErr = this.nameError(entry.name);
      if (nameErr) return { ok: false, error: nameErr };
      if (this.agents.has(entry.name) || (!batchReserved && this.namesCapacity.isReserved(entry.name)))
        return { ok: false, error: `retained agent "${entry.name}" is already managed or reserved; same-principal resume never auto-numbers` };
      const occupancy = batchReserved ? undefined : this.occupancy();
      if (occupancy && occupancy.used >= MAX_AGENTS)
        return { ok: false, error: `${this.capacityRefusal(occupancy)}; same-principal resume refused` };
      const cached = prepared?.get(entry.name);
      if (!preflightOnly && cached) {
        try {
          // Do not trust the earlier batch preflight across another agent's sequential readiness wait.
          await this.validateRetainedAuthority(entry);
        } catch (e) {
          return { ok: false, error: rejectionText(e) };
        }
        return this.launchPreparedResume(entry, cached, batchReserved, supervised);
      }
      try {
        const cwd = lstatSync(entry.launch.cwd);
        if (!cwd.isDirectory() || cwd.isSymbolicLink())
          return { ok: false, error: `retained cwd is not a real directory: ${entry.launch.cwd}` };
      } catch (e) {
        return { ok: false, error: `retained cwd unavailable: ${entry.launch.cwd} (${rejectionText(e)})` };
      }

      let connector: Connector;
      try {
        // The SAME resolver the spawn path uses. A bare `registry.resolve` here made preserve→resume
        // fail for EVERY retained agent on the published binary: the resuming manager is a fresh
        // process whose registry is empty (its supervise child runs with the connector seed
        // skipped), so nothing is registered until something materializes it from the ext manifest.
        // That is precisely what `resolveConnector` does and what every spawn path already calls.
        // Resolving bare meant a preserved mesh could never come back — first-party connectors
        // included, since the asymmetry is about materialization, not about which connector it is.
        connector = await this.resolveConnector(entry.launch.connector);
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
      const harness = this.launchHarness(connector);
      if ("refusal" in harness) return { ok: false, error: harness.refusal };
      let retainedSession: string | undefined;
      try {
        retainedSession = this.retainedSessionId(entry, connector);
      } catch (error) {
        return { ok: false, error: rejectionText(error) };
      }
      if (entry.launch.forkSource && !retainedSession && !connector.supportsResume)
        return { ok: false, error: `${connector.name} connector does not support session fork (resume)` };
      if (retainedSession && !connector.supportsSessionContinuation)
        return { ok: false, error: `${connector.name} connector does not support exact-session continuation` };

      let launchOptions: Record<string, unknown> | undefined;
      let exact = false;
      if (entry.launch.source.kind === "manifest") {
        const launchSource = entry.launch.source;
        if (!launchSource.runId)
          return { ok: false, error: `retained manifest launch for ${entry.name} has no runId; refusing to guess a .cotal/run source` };
        let spec: MeshLaunchAgent | undefined;
        try {
          const source = launchSpecForRun(this.workspaceRoot, launchSource.runId);
          if (source.space !== this.space)
            return { ok: false, error: `retained launch spec space "${source.space}" does not match manager space "${this.space}"` };
          spec = source.agents.find((a) => a.name === launchSource.requested);
        } catch (e) {
          return { ok: false, error: rejectionText(e) };
        }
        if (!spec || spec.hash !== launchSource.hash)
          return { ok: false, error: `retained manifest agent ${launchSource.requested} is missing or its hash changed; refusing same-principal resume` };
        launchOptions = spec.launchOptions;
        exact = spec.continuity === "exact";
      } else {
        try {
          launchOptions = loadAgentFile(entry.launch.source.configPath).launchOptions;
        } catch (e) {
          return { ok: false, error: rejectionText(e) };
        }
      }
      // Asked once `exact` is known: an exact seat reopens its retained session or fails, like its
      // manifest launch, so the connector must honor reopenSession before the batch starts any child.
      const unsupported = this.capabilityRefusal(connector, { variant: entry.launch.variant, prompt: entry.launch.prompt, exact });
      if (unsupported) return { ok: false, error: unsupported };
      const eventsRefused = this.eventsRefusal(connector, entry.launch.events);
      if (eventsRefused) return { ok: false, error: eventsRefused };

      let authority: Pick<PreparedResume, "id" | "creds" | "userAuth">;
      try {
        authority = await this.validateRetainedAuthority(entry);
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }

      try {
        const launchOpts: LaunchOpts = {
          ...this.hostLaunchFields(loadCotalConfig(this.workspaceRoot), entry.launch.connector, entry.launch.shareTools, harness),
          name: entry.name,
          role: entry.role,
          id: authority.id,
          creds: authority.creds,
          userAuth: authority.userAuth,
          // Recover the ORIGINAL incarnation uid (never a fresh mint on resume): the child endpoint
          // binds its lifecycle-keyed dm/dlv/chathist durables by this exact value, and its creds pin
          // the same names. Omitting it here (as the pre-fix resume path did) leaves the resumed child
          // with no COTAL_LIFECYCLE_UID: static/user fail the connector auth gate and open self-mints a
          // fresh uid that orphans the preserved durables and never matches the readiness fence.
          lifecycleUid: entry.identity.lifecycleUid,
          backfillFloor: entry.backfillFloor,
          acceptedToken: entry.identity.mode === "static" ? entry.identity.issued?.acceptedToken : undefined,
          configPath: entry.launch.source.configPath,
          model: entry.launch.model,
          variant: entry.launch.variant,
          launchOptions,
          resume: retainedSession ? undefined : entry.launch.forkSource,
          continueSession: exact ? undefined : retainedSession,
          reopenSession: exact ? retainedSession : undefined,
          subscribe: entry.launch.subscribe,
          allowSubscribe: entry.launch.allowSubscribe,
          allowPublish: entry.launch.allowPublish,
          capabilities: entry.launch.capabilities,
          endpoints: copyPersonaEndpoints(entry.launch.endpoints) ?? [],
          events: entry.launch.events,
          eventPayloads: this.eventPayloadsWithheld ? false : entry.launch.eventPayloads,
          cwd: entry.launch.cwd,
        };
        const spec = connector.buildLaunch(launchOpts);
        spec.env = { ...spec.env, COTAL_MANAGER_INSTANCE: this.managerInstanceId };
        const value = { spec, launchOpts, ...authority, exact } satisfies PreparedResume;
        prepared?.set(entry.name, value);
        if (preflightOnly) return { ok: true, data: { name: entry.name, preflight: true } };
        return this.launchPreparedResume(entry, value, batchReserved, supervised);
      } catch (e) {
        return { ok: false, error: rejectionText(e) };
      }
    } finally {
      release();
    }
  }

  private async launchPreparedResume(
    entry: ManagerResumeAgent,
    prepared: PreparedResume,
    batchReserved: boolean,
    supervised?: SupervisedRestart,
  ): Promise<ControlReply> {
    if (!batchReserved) this.namesCapacity.reserve(entry.name, resumeOwner(entry));
    try {
      // Recover the STATIC identity's nkey seed from the adopted credential (the
      // creds file embeds it) so the manager stays this incarnation's RENEWAL OWNER across a
      // preserve/resume — without it the adopted cred would die loud at its TTL with no remint.
      let adoptedSeed: string | undefined;
      if (entry.identity.mode === "static") {
        const stored = await this.secrets.get(agentSecretKeyForFile(resolve(entry.identity.credential.path), this.space));
        // The core parser, which reads the creds format's six-dash END marker. A local pattern that
        // expected five matched no real file, so every resumed seat lost its renewal.
        try {
          adoptedSeed = stored === undefined ? undefined : identityFromCreds(stored).seed;
        } catch {
          adoptedSeed = undefined;
        }
        if (adoptedSeed === undefined)
          console.error(`! resume ${entry.name}: the adopted credential carries no readable nkey seed - the manager cannot renew it (it dies loud at its exp)`);
      }
      const connector = await this.resolveConnector(entry.launch.connector);
      const readinessTimeoutMs = connector.readinessTimeoutMs ?? this.readinessTimeoutMs;
      if (!Number.isSafeInteger(readinessTimeoutMs) || readinessTimeoutMs <= 0)
        return { ok: false, error: `connector ${connector.name} declares invalid readinessTimeoutMs ${JSON.stringify(connector.readinessTimeoutMs)}; expected a positive safe integer` };
      const resumeId = entry.identity.mode === "user" ? principalKey(entry.identity.owner, entry.identity.actor).key : entry.identity.id;
      const runtime = this.runtimeFor(entry.launch.runtime);
      const custody = this.reserveCustody(runtime);
      if (custody) await this.recordSlotCustody({ name: entry.name, id: resumeId, lifecycleUid: entry.identity.lifecycleUid }, custody);
      prepared.spawned = true;
      const handle = await this.spawnCustodied(runtime, entry.name, prepared.spec, entry.launch.cwd, custody);
      const managed: ManagedAgent = {
        name: entry.name,
        role: entry.role,
        agent: entry.launch.connector,
        id: resumeId,
        seed: adoptedSeed,
        ...(entry.identity.mode === "static" && entry.identity.issued ? { issued: entry.identity.issued } : {}),
        // Recover the ORIGINAL incarnation uid the durables are keyed by (never a fresh mint on resume).
        lifecycleUid: entry.identity.lifecycleUid,
        // Adopt the INVENTORY's recorded family (possibly a pre-split name-keyed layout) — the
        // validated paths above, so this incarnation's later teardown addresses exactly what its
        // spawn materialized, never a re-derivation.
        secretPaths: entry.identity.mode === "user"
          ? { actorToken: entry.identity.actorToken.path, sentinelCreds: entry.identity.sentinelCredential.path, health: entry.identity.health.path }
          : entry.identity.mode === "static"
            ? { creds: entry.identity.credential.path }
            : undefined,
        userOwner: entry.identity.mode === "user" ? entry.identity.owner : undefined,
        spawner: entry.spawner,
        authorityParent: entry.authorityParent,
        startedAt: Date.now(),
        handle,
        control: prepared.spec.control,
        launch: {
          runtime: entry.launch.runtime,
          source: entry.launch.source,
          cwd: entry.launch.cwd,
          model: entry.launch.model,
          variant: entry.launch.variant,
          subscribe: entry.launch.subscribe,
          allowSubscribe: entry.launch.allowSubscribe,
          allowPublish: entry.launch.allowPublish,
          capabilities: entry.launch.capabilities,
          ...(entry.launch.endpoints?.length ? { endpoints: copyPersonaEndpoints(entry.launch.endpoints) } : {}),
          events: entry.launch.events,
          eventPayloads: this.eventPayloadsWithheld ? false : entry.launch.eventPayloads,
          shareTools: entry.launch.shareTools,
          forkSource: entry.launch.forkSource,
          ...(entry.launch.resumed ? { resumed: entry.launch.resumed } : {}),
          ...(prepared.launchOpts.resume !== undefined && prepared.spec.resumeRecordPath ? { resumeRecordPath: prepared.spec.resumeRecordPath } : {}),
          sessionId: entry.launch.sessionId,
        },
        ...(supervised
          ? { restart: { opts: prepared.launchOpts, sessionStatePath: prepared.spec.sessionStatePath, crashes: supervised.crashes, recovering: false, armed: false, policy: supervised.policy } }
          : prepared.spec.sessionStatePath
            ? { restart: { opts: prepared.launchOpts, sessionStatePath: prepared.spec.sessionStatePath, crashes: [], recovering: false, armed: false } }
            : {}),
        suppressCleanup: true,
      };
      this.agents.set(entry.name, managed);
      this.namesCapacity.placed(entry.name);
      if (this.resumeAttemptId) this.resumedAgentNames.add(entry.name);
      try {
        await this.recordSlotRuntime(managed);
      } catch (error) {
        return await this.stopFailedResume(managed, "resume-custody-unrecorded", `${managed.name} resumed, but ${rejectionText(error)}`);
      }
      const readiness = await this.awaitReadiness(managed, readinessTimeoutMs, supervised ? { joinedAfter: supervised.joinedAfter } : {});
      if (!readiness.ok && !readiness.uncertain) return { ok: false, error: readiness.detail };
      if (!readiness.ok) {
        this.watchExit(managed);
        // The restart was counted when it launched, so the record carries that crash whether or not
        // the seat ever joins: a successor reads the record to decide whether another fits the budget.
        if (supervised) this.refreshSeatRecord(managed);
        this.watchResumeAdoption(managed, supervised?.joinedAfter, () => this.armLateResume(managed, connector, prepared, supervised));
        return { ok: false, error: readiness.detail };
      }
      const unbound = await this.armResumedSeat(managed, connector, prepared, supervised);
      if (unbound !== undefined) return await this.stopFailedResume(managed, "resume-session-rebind-failed", unbound);
      if (!this.resumeAttemptId) managed.suppressCleanup = false;
      if (supervised) this.refreshSeatRecord(managed);
      this.watchExit(managed);
      if (this.agents.get(managed.name) !== managed)
        return { ok: false, error: `${managed.name} exited immediately after same-principal readiness` };
      return {
        ok: true,
        data: { name: managed.name, role: managed.role, agent: managed.agent, id: managed.id, mode: handle.kind, resumed: true },
      };
    } catch (e) {
      return { ok: false, error: rejectionText(e) };
    } finally {
      if (!batchReserved) {
        this.namesCapacity.release(entry.name);
      }
    }
  }

  /** Arm a resumed seat's restart once it is ready, whether it joined inside the readiness window or
   *  after it (#4144). A supervised restart arms the way its spawn did: a connector with no session
   *  continuation is armed at readiness, one with it once its session is proved. Returns why the
   *  session could not be rebound, and the caller stops the seat. */
  private async armResumedSeat(managed: ManagedAgent, connector: Connector, prepared: PreparedResume, supervised: SupervisedRestart | undefined): Promise<string | undefined> {
    if (supervised && managed.restart && !connector.supportsSessionContinuation && !prepared.exact) {
      managed.restart.armed = true;
      return undefined;
    }
    if (!managed.restart && !prepared.exact) return undefined;
    try {
      await this.armSessionRecovery(managed);
      // As on a manifest launch, an exact seat is recorded only at the session it asked for,
      // proved over the connector's authenticated control endpoint.
      if (prepared.exact && !managed.restart?.armed)
        throw new Error("continuity: exact needs the connector to prove its session over an authenticated control endpoint, and it supplied none");
      managed.launch.sessionId = this.readManagedSession(managed);
      const asked = prepared.launchOpts.reopenSession;
      if (asked !== undefined && managed.launch.sessionId !== asked)
        throw new Error(`continuity: exact asked for session ${asked}, the connector bound ${managed.launch.sessionId}`);
      if (prepared.exact) {
        managed.continuity = { space: this.space, name: managed.name, connector: managed.agent, cwd: managed.launch.cwd };
        this.recordContinuity(managed, managed.launch.sessionId);
      }
      return undefined;
    } catch (error) {
      return `${managed.name} resumed, but its exact host session could not be rebound: ${rejectionText(error)}`;
    }
  }

  /** A resumed seat whose readiness was uncertain gets what a ready one gets once it joins: its
   *  restart is armed and its record rewritten. Without this, a supervised seat restarted after a
   *  manager crash that joined late was retired on its next exit instead of restarted. */
  private async armLateResume(managed: ManagedAgent, connector: Connector, prepared: PreparedResume, supervised: SupervisedRestart | undefined): Promise<void> {
    const current = (): boolean => this.agents.get(managed.name) === managed && !managed.terminalizing;
    if (!current()) return;
    const unbound = await this.armResumedSeat(managed, connector, prepared, supervised);
    if (!current()) return;
    if (unbound !== undefined) {
      const stopped = await this.stopFailedResume(managed, "resume-session-rebind-failed", unbound);
      if (!stopped.ok) console.error(`! ${stopped.error}`);
      return;
    }
    if (supervised) this.refreshSeatRecord(managed);
  }

  /** A resumed seat keeps its retained credentials, so freeing it runs no deprovision and nothing
   *  would reap it: it is freed only once its exit is proved, and otherwise stays managed until it
   *  exits or the manager stops it. */
  private async stopFailedResume(managed: ManagedAgent, cause: FreeSlotCause, detail: string): Promise<ControlReply> {
    const refused = this.stopHandle(managed, false, cause);
    const unproven = refused === undefined
      ? await this.awaitHandleExit(managed.handle).then(() => undefined, rejectionText)
      : `stop failed: ${refused}`;
    if (unproven !== undefined) {
      this.watchExit(managed);
      return { ok: false, error: `${detail}; it stays managed because its stop is unproven: ${unproven}` };
    }
    this.freeSlot(managed, true, cause, true);
    return { ok: false, error: detail };
  }

  private probeStaticCredential(creds: string) {
    return probeConnect(this.servers ?? DEFAULT_SERVER, { creds, timeoutMs: 5_000 });
  }

  /** An uncertain resume remains non-destructive until exact-principal AND exact-incarnation presence
   *  arrives later, and then `adopted` runs. Same predicate as the readiness fence: a principal-only
   *  match would let a wrong/absent-uid presence under the reused alias clear cleanup suppression on
   *  another incarnation. A supervised restart keeps its principal and uid, so it also carries the
   *  fence's `joinedAfter` bound: the row the dead seat left must not stand in for the new process.
   *  A heartbeat on that row moves only its time and emits no presence event, so the bound is polled. */
  private watchResumeAdoption(a: ManagedAgent, joinedAfter: number | undefined, adopted: () => Promise<void>): void {
    const wanted = this.managedPrincipal(a);
    let poll: ReturnType<typeof setInterval> | undefined;
    const done = (): void => {
      this.ep.off("presence", onPresence);
      if (poll !== undefined) clearInterval(poll);
    };
    const onPresence = (): void => {
      if (this.agents.get(a.name) !== a) {
        done();
        return;
      }
      if (!this.ep.getRoster().some((p) => p.card.id === wanted && p.status !== "offline" && p.lifecycleUid === a.lifecycleUid && (joinedAfter === undefined || p.ts >= joinedAfter))) return;
      if (!this.resumeRequired) a.suppressCleanup = false;
      done();
      adopted().catch((error) => console.error(`! ${a.name}: joined after its readiness window, but ${rejectionText(error)}`));
    };
    this.ep.on("presence", onPresence);
    if (joinedAfter !== undefined) {
      poll = setInterval(onPresence, LATE_JOIN_POLL_MS);
      poll.unref?.();
    }
    onPresence();
  }

  /** #159 B1: wait for a detached launch to reach a REAL outcome before replying — never a liveness-
   *  inferring timer. Races three:
   *   • the assigned id joins presence (live) → **started** — the honest signal (the manager owns mesh
   *     lifecycle, not app health, so `ok:true` means "it joined the mesh", not "fully healthy");
   *   • the child process exits → **failed** — surface its last output and reap the slot;
   *   • neither within {@link readinessTimeoutMs} → **uncertain** — a non-success diagnostic that does NOT
   *     deprovision (it may still be booting; the caller keeps {@link watchExit} wired so a later death is
   *     still reaped).
   *  Presence is keyed on the EXACT freshly-minted id, never the name — a fresh id has no prior record, so
   *  any live presence for it is from THIS launch (stale/same-name records can't false-start it). The
   *  `"presence"` event is only a wake; the roster is re-read as the source of truth (subscribe-then-check
   *  catches a join/exit that landed before we subscribed). A runtime whose `attach()` throws (an external
   *  surface) streams no output or exit, so its exit leg polls the runtime's exit proof ({@link pollProvedExit}),
   *  reads it once more when the window closes, and its failure carries no last output; one that cannot prove an
   *  exit either races presence-vs-backstop only.
   *  A launch that waits for the operator at `opts.operator`, a screen its connector names, is ready once a
   *  process this runtime owns has run for {@link OPERATOR_READINESS_MS} without exiting. An uncertain verdict
   *  says whether a process this runtime owns is still running. */
  private async awaitReadiness(a: ManagedAgent, readinessTimeoutMs: number, opts: { reapOnExit?: boolean; joinedAfter?: number; operator?: string } = {}): Promise<{ ok: true; operator?: string } | { ok: false; uncertain?: boolean; running?: boolean; deliberate?: boolean; detail: string }> {
    let session: AttachSession | undefined;
    try {
      session = a.handle.attach();
    } catch {
      /* external surfaces stream no output or exit; their exit is polled below */
    }
    const s = session;
    // Presence cards carry the wire PRINCIPAL dot-form (`<owner>.<actor>`), never a raw nkey — match
    // through managedPrincipal or a static launch can never be seen joining (every static spawn would
    // resolve "uncertain"; caught by the lifecycle e2e).
    const wanted = this.managedPrincipal(a);
    // READINESS LIFECYCLE FENCE (SPEC 13.1): match the exact principal AND the exact lifecycle uid
    // the manager minted for THIS spawn (presence carries it, §6). The endpoint's own
    // register-only broker proof is gated on the CLIENT-authored `card.kind`, which a managed child
    // holding a valid agent credential could set to "endpoint" to skip - so it is defense-in-depth,
    // NOT the authority boundary. This equality is: the manager (not the child) owns the expected
    // uid, so a ghost that advertises a wrong/absent uid never reports STARTED, whatever kind it
    // claims. The manager threads the uid into EVERY mode's launch (open included), so the child
    // adopts it over a self-mint and publishes it in presence; the uid is absent only from a peer
    // the manager never launched (a pure operator/daemon connection that never registers).
    // A supervised restart keeps the same principal+uid, so a SIGKILL'd child's still-live
    // presence row would otherwise satisfy this equality. `joinedAfter` is one millisecond
    // past that row's last heartbeat: only a later heartbeat counts as THIS replacement joining.
    const joined = (): boolean =>
      this.ep.getRoster().some((p) =>
        p.card.id === wanted
        && p.status !== "offline"
        && p.lifecycleUid === a.lifecycleUid
        && (opts.joinedAfter === undefined || p.ts >= opts.joinedAfter));

    return await new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      let unsubExit = (): void => {};
      let joinedPoll: ReturnType<typeof setInterval> | undefined;
      let operatorTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (r: { ok: true; operator?: string } | { ok: false; uncertain?: boolean; running?: boolean; deliberate?: boolean; detail: string }): void => {
        if (done) return;
        done = true;
        if (!r.ok && r.uncertain) {
          a.joinIssue = r.detail;
          console.error(`seat join degraded: ${r.detail}`);
        } else if (r.ok) {
          a.joinIssue = undefined;
        }
        clearTimeout(timer);
        clearTimeout(operatorTimer);
        if (joinedPoll !== undefined) clearInterval(joinedPoll);
        this.ep.off("presence", onPresence);
        this.shutdownReadiness.signal.removeEventListener("abort", onShutdown);
        unsubExit();
        resolve(r);
      };
      const onPresence = (): void => {
        if (joined()) finish({ ok: true });
      };
      // Shutdown owns the seat's stop and retirement after the lifecycle ticket drains. Do not
      // keep that ticket waiting on a connector's readiness window while shutdown waits on it.
      const onShutdown = (): void => finish({ ok: false, deliberate: true, detail: `${a.name} was stopped before it reported ready` });
      if (opts.joinedAfter !== undefined) {
        // Heartbeats bump roster.ts without emitting "presence" (same status/uid/activity).
        // A supervised restart needs that bump, so poll joined() rather than waiting on the event.
        joinedPoll = setInterval(onPresence, 50);
      }
      // Process exit → failed. Clear the backstop FIRST (synchronously) so it can't resolve UNCERTAIN while
      // the backlog reads async — the process is known dead, that's a failure, not an unknown. Reap through
      // onAgentExit so a child the launcher spawned in the window is reaped too.
      const onExit = (): void => {
        if (done) return;
        clearTimeout(timer);
        clearTimeout(operatorTimer);
        // `stopHandle` sets `terminalizing` synchronously before it kills, and `onAgentExit` sets it
        // through `freeSlot` when it retires the seat, so only a read before the await and the reap
        // tells a deliberate stop from a launch failure.
        const deliberate = a.terminalizing === true;
        void (async () => {
          // A closed stream or a reader failure must not prevent settlement, or read as empty output.
          let tail = "";
          try {
            if (s) tail = await this.tail(s);
          } catch (error) {
            console.error(`! ${a.name}: last output unavailable: ${rejectionText(error)}`);
          }
          if (opts.reapOnExit !== false) this.onAgentExit(a);
          // The despawn path owns this goal's terminal (`cancel`), and this promise still settles
          // as the `deliberate` variant so the caller commits none: the readiness timer is already
          // cleared, and the spawn's lifecycle ticket is released only on settle.
          if (deliberate) {
            finish({ ok: false, deliberate: true, detail: `${a.name} was stopped before it reported ready` });
            return;
          }
          // The screen's last row can be a dialog footer, so the exit's diagnostic is named beside it:
          // it carries the runtime's own reason when it stopped the seat. A connector that ends on its
          // diagnostic already shows it as the last row, and it is not repeated.
          let exitDetail = "";
          try {
            const diagnostic = a.handle.exitInfo?.()?.diagnostic;
            if (diagnostic && diagnostic !== tail) exitDetail = `; diagnostic: ${diagnostic}`;
          } catch (e) {
            // The backstop is already cleared, so a reader that throws must still let this settle.
            exitDetail = `; exit detail unreadable from runtime "${a.handle.kind}": ${rejectionText(e)}`;
          }
          // A runtime's text can carry a lone surrogate, which is not I-JSON, and the failed terminal
          // this detail becomes is refused with it.
          exitDetail = exitDetail.replace(/\p{Cs}/gu, "\uFFFD");
          finish({ ok: false, detail: `${a.name} exited on launch${tail ? ` - last output: ${tail}` : ""}${exitDetail}` });
        })();
      };
      // A process this runtime owns reports its own exit, so one still running here is running.
      const uncertain = (): void => {
        const running = s !== undefined && a.handle.status() === "running";
        finish({
          ok: false,
          uncertain: true,
          running,
          detail: running
            ? `${a.name} (${a.id}): launch status uncertain - its process is running but did not join the mesh within ${readinessTimeoutMs}ms; it may still be starting or waiting at a prompt. Inspect with \`cotal attach ${a.name}\` / \`cotal ps\`; do not stop it solely because this bounded wait elapsed.`
            : `${a.name} (${a.id}): launch status uncertain - no process exit and no mesh presence within ${readinessTimeoutMs}ms; it may still be booting or stuck before connector startup. Inspect with \`cotal attach ${a.name}\` / \`cotal ps\`; do not stop it solely because this bounded wait elapsed.`,
        });
      };
      if (opts.operator !== undefined && s)
        operatorTimer = setTimeout(() => { if (a.handle.status() === "running") finish({ ok: true, operator: opts.operator }); }, OPERATOR_READINESS_MS);
      // The exit poll read the runtime up to a poll ago, and a window can be shorter than a poll, so
      // the window closes on a fresh read: a child that exited by then is reported as exited. Nothing
      // bounds how long a runtime's proof takes, so it gets one more poll before the launch is uncertain.
      timer = setTimeout(() => {
        const proof = s ? undefined : exitProof(a.handle);
        if (!proof) {
          uncertain();
          return;
        }
        timer = setTimeout(uncertain, READINESS_EXIT_POLL_MS);
        proof.then(onExit, uncertain);
      }, readinessTimeoutMs);
      // The poll stops once the race is done, so it needs no unsubscribe.
      if (s) unsubExit = s.onExit(onExit);
      else pollProvedExit(a.handle, onExit, () => !done, READINESS_EXIT_POLL_MS);
      this.ep.on("presence", onPresence);
      this.shutdownReadiness.signal.addEventListener("abort", onShutdown, { once: true });
      // Subscribe-then-check (TOCTOU): a join or an exit that already landed before we subscribed.
      if (this.shutdownReadiness.signal.aborted) onShutdown();
      else if (s && a.handle.status() === "exited") onExit();
      else onPresence();
    });
  }

  /** Last non-empty line of the session's rendered backlog as a single trimmed snippet (≤160 chars)
   *  — a readable one-line cause for an early-exit diagnostic. The backlog repaints cells a TUI
   *  skipped with cursor moves, so it is rendered and the line is read off the terminal; stripping
   *  its escapes would glue the words those moves separate. */
  private async tail(session: AttachSession): Promise<string> {
    const backlog = await session.backlog();
    // Sized after the snapshot: a custodial seat's snapshot carries the geometry it was taken at.
    // The headless build exposes `buffer` only as proposed API.
    const term = new Headless.Terminal({ cols: session.cols, rows: session.rows, allowProposedApi: true });
    await new Promise<void>((done) => term.write(backlog, done));
    const screen = term.buffer.active;
    let text = "";
    for (let y = screen.length - 1; y >= 0; y--) {
      const row = screen.getLine(y)!;
      // A line wider than the screen continues across wrapped rows, so it is read whole.
      text = row.translateToString(text === "") + text;
      if (row.isWrapped) continue;
      // Blanks a program painted survive the right trim, so a line of only blanks is skipped.
      if (text.trim()) break;
      text = "";
    }
    term.dispose();
    text = text.trim();
    // Cut on code points: half a surrogate pair is not I-JSON, and a launch terminal carrying it is refused.
    const chars = [...text];
    return chars.length > 160 ? `…${chars.slice(-160).join("")}` : text;
  }

  /** Subscribe to a managed agent's process-exit so a self-driven exit frees its slot and reaps
   *  its children (P4b/P4c). The watch is bound to the current handle: a restart swaps in a new one
   *  and watches it, so a late exit proved for the old handle must not retire the row. */
  private watchExit(a: ManagedAgent): void {
    const handle = a.handle;
    const current = (): boolean => this.agents.get(a.name) === a && a.handle === handle;
    const watched = watchProvedExit(handle, () => this.onAgentExit(a), current);
    if (!watched)
      console.error(`! ${a.name}: runtime "${handle.kind}" cannot prove a child exit (AgentHandle.waitForExit is not implemented) - it stays managed after it exits, until it is stopped`);
  }
  private occupancy(): Occupancy { return this.namesCapacity.occupancy(); }
  private occupancyText(o: Occupancy): string { return this.namesCapacity.occupancyText(o); }
  private capacityRefusal(o: Occupancy): string { return this.namesCapacity.capacityRefusal(o); }

  /**
   * The owner a launch belongs to, read ONCE so the per-owner ceiling, the agent's addressing
   * triple and the user-mode provisioner cannot charge three different owners for one seat. A
   * static or open mesh has one owner by construction; a user-auth mesh takes the spec's owner,
   * else the owner of the principal that asked, which is what {@link provisionUserAgent} resolves
   * from the same two values (it refuses outright where this falls back, so the two never disagree
   * on an admitted launch).
   */
  private launchOwner(opts: Pick<StartAgentOpts, "owner">, spawner?: string): string {
    if (!this.userMode) return DEV_OWNER;
    const asked = spawner === undefined ? undefined : parsePrincipalKey(spawner)?.owner;
    return opts.owner ?? (asked?.startsWith("u_") ? asked : DEV_OWNER);
  }

  /** The owner of a seat this manager supervises, by the same rule {@link launchOwner} admitted it
   *  under: a user-mode seat records its derived owner, and every other seat is the mesh's one owner. */
  private seatOwner(a: Pick<ManagedAgent, "userOwner">): string {
    return a.userOwner ?? DEV_OWNER;
  }

  /**
   * Live seats this manager holds for one owner: the seats it supervises, plus the launches it has
   * reserved for that owner and not yet placed. It deliberately does NOT count cooling stamps — a
   * cooling slot is a seat that already freed, and the recycle floor it holds is a global
   * fork-bomb bound (P4c), not one tenant's occupancy. Mirrors {@link occupancy}'s reserved rule,
   * so a reservation stops being counted twice the moment its seat reaches `agents`.
   */
  private ownerSeats(owner: string): number {
    let seats = 0;
    for (const a of this.agents.values()) if (this.seatOwner(a) === owner) seats++;
    seats += this.namesCapacity.ownerReservations(owner);
    return seats;
  }

  /**
   * The per-owner ceiling, consulted at accept: `undefined` admits the launch, and a refusal
   * carries the owner's count and the cap so a caller can render a remedy and a script can decide
   * without re-reading prose. Distinct from {@link capacityRefusal}, which bounds the HOST: that
   * one frees when anyone stops a seat or a cooling slot expires, this one frees only when THIS
   * owner stops one of its own, or the operator raises the cap, so they cannot share a sentence.
   */
  private seatCapRefusal(owner: string): EpEnvelopeError | undefined {
    const cap = this.seatCap;
    if (cap === SEAT_CAP_UNLIMITED) return undefined;
    const seats = this.ownerSeats(owner);
    if (seats < cap) return undefined;
    return seatCapRefused(
      `owner ${owner} holds ${seats} of the ${cap} seat${cap === 1 ? "" : "s"} manager ${this.managerInstanceId} admits per owner; ` +
        `stop one of that owner's seats, or ask the operator who runs this manager for a higher seat cap`,
      { owner, seats, cap },
    );
  }

  // @ts-expect-error TS6133: retained fixtures call this private adapter through structural views.
  private async opStop(args: Record<string, unknown>, caller: string, admin: boolean): Promise<ControlReply> {
    const name = String(args.name ?? "").trim();
    const a = this.agents.get(name);
    if (!a) return { ok: false, error: `no agent "${name}"` };
    try {
      return await this.despawnCore(a, caller, admin, args.graceful !== false);
    } catch (error) {
      return { ok: false, error: rejectionText(error) };
    }
  }

  /** The ONE named-terminal core both doors share: the ctl named `stop`
   *  and the v0.4 targeted `despawn` are the same terminal — authorize by the shared policy
   *  ({@link authorizeNamed}: own-child / owner-domain on privileged, any on admin), stop, track.
   *  The ep door runs the SAME two pieces separately so a policy denial surfaces as the §13.3
   *  `permission-denied` (never a generic failure). */
  private async despawnCore(a: ManagedAgent, caller: string, admin: boolean, graceful: boolean): Promise<ControlReply> {
    const denied = await this.authorizeNamed(a, caller, admin);
    if (denied) return { ok: false, error: denied };
    return this.despawnAuthorized(a, graceful, !admin, caller);
  }

  /** The post-authorization terminal effect (both doors). `trackNonAdmin` mirrors the ctl door's
   *  `trackStoppedHandle(a, !admin)` disposition. The reap line names `caller` — the AUTHENTICATED
   *  wire principal the door already resolved — so an operator reading the log can tell one peer's
   * despawn from another's. */
  private despawnAuthorized(a: ManagedAgent, graceful: boolean, trackNonAdmin: boolean, caller: string): ControlReply | Promise<ControlReply> {
    if (process.platform === "win32" && a.handle.kind === "pty") {
      return this.stopWindowsSeat(a, graceful, trackNonAdmin, { kind: "stopped-requested", requester: caller }).then(() => {
        void this.cancelAgentGoal(a.name, graceful ? "graceful" : "terminate");
        return { ok: true, data: { name: a.name, stopped: true, graceful } };
      });
    }
    const cause = { kind: "stopped-requested", requester: caller } as const;
    this.stopHandle(a, graceful, cause);
    this.trackStoppedHandle(a, trackNonAdmin, cause);
    void this.cancelAgentGoal(a.name, graceful ? "graceful" : "terminate"); // Cancel a live spawn goal
    return { ok: true, data: { name: a.name, stopped: true, graceful } };
  }

  /** Retire one agent this manager launched under a delegated user intent, through the host
   *  (SPEC 13.16). It sends the user's retirement intent for the UID of the running slot or its
   *  retirement hold, and only on `retired: true` for that exact target stops the slot, shreds the
   *  seat's local secret family and frees the name; every other answer leaves the slot running or
   *  the name held, and a failed shred keeps the name held. It never calls the holder's own prepare
   *  or requester. */
  async retireDelegatedAgent(name: string, intentId: string): Promise<ControlReply> {
    const execute = this.remoteAuthority?.executeDelegatedUserIntent;
    if (!execute) return { ok: false, error: `this manager has no host execution for a delegated user intent; "${name}" was not retired` };
    const release = this.beginLifecycle();
    if (!release) return { ok: false, error: this.maintenanceError() };
    try {
      const live = this.agents.get(name);
      const held = live ? undefined : this.retirement.held(name);
      const principal = live?.delegated ? parsePrincipalKey(live.id) : held?.target.delegated ? held : null;
      const lifecycleUid = live?.lifecycleUid ?? held?.target.lifecycleUid;
      if (!principal || !lifecycleUid) return { ok: false, error: `no agent named "${name}" was launched on this manager under a delegated user intent` };
      const target = { owner: principal.owner, actor: principal.actor, lifecycleUid };
      try {
        const result = await execute({ intentId, operation: "retire", target });
        if (result.operation !== "retire" || result.intentId !== intentId || result.opId !== managedRetirementOpId(target.lifecycleUid) ||
            result.target.owner !== target.owner || result.target.actor !== target.actor || result.target.lifecycleUid !== target.lifecycleUid)
          throw new Error(`the host answered delegated intent ${intentId} with another execution`);
        if (result.retired !== true)
          return { ok: false, error: `the host did not confirm the delegated retirement of "${name}" at ${target.lifecycleUid}; "${name}" is unchanged` };
      } catch (e) {
        const error = `the delegated retirement under intent ${intentId} did not complete (${rejectionText(e)})`;
        const hold = this.retirement.held(name);
        if (hold?.target.lifecycleUid === target.lifecycleUid) hold.lastError = error;
        return { ok: false, error: `${error}; "${name}" is unchanged` };
      }
      // The host's retirement closed this UID's provider handle before its barrier, so the stop only
      // reaps the slot, and its hold clears with the confirmation.
      const slot = this.agents.get(name);
      if (slot?.lifecycleUid === target.lifecycleUid) await this.despawnAuthorized(slot, true, false, `delegated retirement ${intentId}`);
      // The host owns the grant and the footprint, but the secret family enrollUserAgent wrote here
      // is this participant's, and no teardown arm of a delegated seat removes it.
      const unshredded: CleanupFailure[] = [];
      await this.shredUserSecrets(unshredded, (live ?? held?.target)?.secretPaths ?? agentLifecycleSecretFilePaths(this.workspaceRoot, this.space, name, target.lifecycleUid));
      if (unshredded.length) {
        const error = `the host retired "${name}" at ${target.lifecycleUid}, but cleanup failed: ${describeCleanupFailures(unshredded)}; the name stays held until a retried retirement intent removes it`;
        const hold = this.retirement.held(name);
        if (hold?.target.lifecycleUid === target.lifecycleUid) hold.lastError = error;
        return { ok: false, error };
      }
      this.confirmRetirement({ id: principalKey(target.owner, target.actor).key, name, lifecycleUid: target.lifecycleUid });
      return { ok: true, data: { name, lifecycleUid: target.lifecycleUid, retired: true } };
    } finally {
      release();
    }
  }

  /** Resolve a v0.4 TARGET triple (owner, actor, lifecycleUid — broker-validated subject/body
   *  agreement, currency re-checked by the serve boundary's resolver) to the live managed agent it
   *  names. Static agents key `(DEV_OWNER, nkey)`; user-mode agents store the principal dot-form
   *  in `id`. A uid mismatch is a superseded incarnation — never resolved to its successor. */
  private findManagedByTarget(t: { owner: string; actor: string; lifecycleUid: string }): ManagedAgent | undefined {
    for (const a of this.agents.values()) {
      const matches = a.userOwner ? a.id === principalKey(t.owner, t.actor).key : t.owner === DEV_OWNER && a.id === t.actor;
      if (matches && a.lifecycleUid === t.lifecycleUid) return a;
    }
    return undefined;
  }

  /** Run one static §13.1 lifecycle OPERATION over an ephemeral, key-pinned `lifecycle-executor`
   *  connection: the credential's grants name exactly ONE incarnation's head/uid/gate/
   *  cred-family/slot keys, so the write authority exists only for this operation's window and
   *  can move nothing else. The transport is the direct-KV binding the shared core saga drives. */
  private async withLifecycleExecutor<T>(
    pin: { owner: string; actor: string; lifecycleUid: string; alias: string },
    fn: (t: LifecycleStateTransport) => Promise<T>,
  ): Promise<T> {
    if (!this.auth) throw new Error("withLifecycleExecutor: no space auth (an open mesh has no lifecycle registry)");
    const identity = newIdentity();
    const creds = await mintCreds(this.auth, identity, "lifecycle-executor", {
      lifecycleExecutor: { owner: pin.owner, actor: pin.actor, lifecycleUid: pin.lifecycleUid, alias: pin.alias },
    });
    const nc = await this.dial({ ...standaloneConnectOpts({ creds, /* not yet wired to a recorded transport */ tls: false }), maxReconnectAttempts: 0 });
    try {
      const kvm = new Kvm(nc);
      const recordsKv = await kvm.open(recordsBucket(this.space));
      const authKv = await kvm.open(epAuthBucket(this.space));
      return await fn(staticLifecycleTransport(recordsKv, authKv));
    } finally {
      await drainAndClose(nc);
    }
  }

  /** Run one SPEC 13.15 issuance operation over an ephemeral `issuer` connection: the evidence
   *  stage/release of one mint, or the retirement walk of one lifecycle's issuances. The store
   *  handle and the accepted-row KV live only for this window; the standing supervisor holds no
   *  grant on either bucket. */
  private async withIssuer<T>(fn: (i: { store: IssuedStore; accepted: KV }) => Promise<T>): Promise<T> {
    if (!this.auth) throw new Error("withIssuer: no space auth (an open mesh issues nothing)");
    const creds = await mintCreds(this.auth, newIdentity(), "issuer");
    const nc = await this.dial({ ...standaloneConnectOpts({ creds, /* not yet wired to a recorded transport */ tls: false }), maxReconnectAttempts: 0 });
    try {
      const kvm = new Kvm(nc);
      return await fn(await bindIssuedStores(kvm, await jetstreamManager(nc), this.space));
    } finally {
      await drainAndClose(nc);
    }
  }

  /** The issuance seam of ONE static credential mint (SPEC 13.15): the evidence is bound to the
   *  incarnation's own `cred.<uid>` ledger family, so the family's revocation (the static
   *  terminal) retires every issuance that named it. The finalizer is the §13.1 ledger append
   *  (slot credentialId + `cred.<uid>.<credId>` row); release runs it, then activates. */
  private issuanceSeam(i: { store: IssuedStore; accepted: KV }, mode: "issue" | "renew", a: { name: string; id: string; lifecycleUid: string }, exp: number): IssuanceSeam {
    return {
      mode,
      store: i.store,
      accepted: i.accepted,
      sources: mode === "issue" ? [{ space: this.space, bucket: epAuthBucket(this.space), key: `cred.${a.lifecycleUid}` }] : [],
      finalize: async (credentialId) => {
        await this.withLifecycleExecutor({ owner: DEV_OWNER, actor: a.id, lifecycleUid: a.lifecycleUid, alias: a.name }, async (t) => {
          await recordSlotCredential(t, DEV_OWNER, a.name, a.lifecycleUid, credentialId);
          await appendStaticCredentialRow(t, { lifecycleUid: a.lifecycleUid, credentialId, holderPrincipal: principalKey(DEV_OWNER, a.id).key, exp });
        });
      },
    };
  }

  /** Run one §13.1 endpoint-instance maintenance operation over an ephemeral,
   *  key-pinned `endpoint-serve-executor` connection: the credential's grants name exactly the
   *  manager instance's `epgate`/`epcred` keys plus its registration's two records keys, so the
   *  gate CAS, mint fence, spec/governance writes, and clean deregistration ride a one-shot scoped
   *  authority. The remote boot goal-index sweep instead uses the authenticated host-owned scan.
   *  This is NEVER the manager's standing seed/supervisor connection. */
  private async withEndpointServeExecutor<T>(fn: (kvs: { recordsKv: KV; authKv: KV; nc: NatsConnection }) => Promise<T>): Promise<T> {
    const identity = this.remoteAuthority?.identities.executor ?? newIdentity();
    if (this.remoteAuthority && (!this.remoteExecutorCreds || inspectCredHealth(this.remoteExecutorCreds).state !== "healthy")) {
      // Shutdown has drained and discarded the standing serve context. Renew only its scoped
      // maintenance executor through the existing host operation; never resurrect standing duties.
      if (this.leaseStopping) await this.renewRemoteExecutor(true);
      else if (this.remoteAuthority.renewStandingBundle) {
        // The renewal drains old handlers after adopting. A handler waiting here must be
        // released at adoption, not after its own completion is required by that drain.
        const renewal = this.renewRemoteStandingBundle(true);
        void renewal.catch((error) => console.error(`! remote manager standing renewal completion: ${rejectionText(error)}`));
        await this.remoteBundleAdoption;
        if (!this.remoteExecutorCreds || inspectCredHealth(this.remoteExecutorCreds).state !== "healthy") {
          await renewal;
          throw new Error("standing renewal did not adopt a healthy scoped executor");
        }
      } else await this.renewRemoteExecutor(true);
    }
    const creds = this.remoteExecutorCreds ?? (this.auth
      ? await mintCreds(this.auth, identity, "endpoint-serve-executor", {
          endpointServeExecutor: { endpoint: MANAGER_ENDPOINT, instanceId: this.managerInstanceId },
          ...(this.endpointServeExecutorExpiresInSeconds !== undefined
            ? { expiresInSeconds: this.endpointServeExecutorExpiresInSeconds }
            : {}),
        })
      : undefined);
    if (!creds) throw new Error("withEndpointServeExecutor: no scoped executor authority (an open mesh must use the bare path)");
    const nc = await this.dial({ ...standaloneConnectOpts({ creds, /* not yet wired to a recorded transport */ tls: false }), maxReconnectAttempts: 0 });
    try {
      const kvm = new Kvm(nc);
      return await fn({ recordsKv: await kvm.open(recordsBucket(this.space)), authKv: await kvm.open(epAuthBucket(this.space)), nc });
    } finally {
      await drainAndClose(nc);
    }
  }

  /** The open-mesh counterpart of {@link withEndpointServeExecutor}: an OPEN mesh has no
   *  credential system, so there is no scoped executor to mint - the same §13.1 gate/records
   *  writes ride a bare one-shot connection (the broker enforces nothing on an open mesh; the
   *  ceremony still produces the real gate, epoch, and registration the serve rails run on). */
  private async withOpenServeConnection<T>(fn: (kvs: { recordsKv: KV; authKv: KV; nc: NatsConnection }) => Promise<T>): Promise<T> {
    if (this.auth || this.remoteAuthority)
      throw new Error("withOpenServeConnection: an authenticated mesh must use the scoped endpoint-serve executor");
    const nc = await this.dial({ maxReconnectAttempts: 0 });
    try {
      const kvm = new Kvm(nc);
      // An open mesh may be a RAW broker (no `cotal up` provisioning ran), and `Kvm.open` binds
      // lazily without checking the stream exists — create-or-verify the §13.12 authority stores
      // first (the same mode-neutral treatment {@link registerManagerService} gives the contract
      // store), or the first gate write dies "stream not found".
      await ensureAuthorityStores(await jetstreamManager(nc), kvm, this.space);
      return await fn({ recordsKv: await kvm.open(recordsBucket(this.space)), authKv: await kvm.open(epAuthBucket(this.space)), nc });
    } finally {
      await drainAndClose(nc);
    }
  }

  /** Parent-local inventory read. It does not enter maintenance or change admission. */
  hostedSeatCount(): number { return this.agents.size; }

  /** Public local-seat facts for the owning machine daemon. No mesh or secret reads. */
  hostedAgents(): { name: string; application: string; model?: string; cwd: string; startedAt: string; state: "running" | "exited" }[] {
    if (this.agents.size > 50) throw new Error("local agent inventory exceeds its bound");
    return [...this.agents.values()].map(a => ({
      name: a.name, application: a.agent, ...(a.launch.model ? { model: a.launch.model } : {}),
      cwd: a.launch.cwd, startedAt: new Date(a.startedAt).toISOString(), state: a.handle.status(),
    }));
  }

  /** The served manager-level health summary. Given an owner, `agentCount` counts only that owner's
   *  seats, as `ps` lists them ({@link psOwnerFilter}), so a person reading a shared Manager does not
   *  learn how many seats other owners hold on it. */
  private managerStatusData(ownerFilter: string | undefined): ManagerStatus {
    this.refreshUnavailableConnectors();
    return {
      instanceId: this.managerInstanceId,
      lifecycleUid: this.managerLifecycleUid,
      host: hostname(),
      version: MANAGER_VERSION,
      execution: this.execution,
      runtime: this.runtimeKind,
      custody: this.execution === "none" ? "none" : this.requiredRuntime.kind === "pty" && this.requiredRuntime.supportsRelease === true ? "custodied" : "legacy",
      runHosting: this.execution !== "none" && (this.remoteAuthority ? this.remoteAuthority.runHosting !== undefined : !this.userMode && this.auth !== undefined),
      terminalSessions: this.execution !== "none",
      agentCount: ownerFilter === undefined ? this.agents.size : [...this.agents.values()].filter((a) => a.userOwner === ownerFilter).length,
      uptimeMs: Date.now() - this.startedAtMs,
      connectors: this.connectorStatuses.map((row) => ({ ...row, binaries: { ...row.binaries } })),
      classSpawn: this.classSpawnEnabled(),
      staticReconciliation: this.staticReconciliationStatus(),
      stopImpact: {
        agentScope: ownerFilter === undefined ? "manager" : "owner-filtered",
        observedAt: new Date().toISOString(),
        maintenance: this.maintenanceState,
        resumeRequired: this.resumeRequired,
        stopping: this.leaseStopping,
        lifecycleInFlight: this.lifecycleInFlight,
        reservedLaunches: this.namesCapacity.reservedCount,
        retirementsPending: this.retirement.pendingCount,
        deprovisioningInFlight: this.retirement.inFlightCount,
        staticReconciliationInFlight: this.staticLifecycle.sweepsInFlight,
        agents: [...this.agents.values()]
          .filter((a) => ownerFilter === undefined || a.userOwner === ownerFilter)
          .map((a): ManagerStopImpact["agents"][number] => ({
            name: a.name,
            id: a.id,
            lifecycleUid: a.lifecycleUid,
            mode: a.handle.kind,
            defaultAction: this.maintenanceState !== "active" || this.resumeRequired
              ? "stop-retaining-state" : this.isProcessBoundSeat(a) ? "stop" : "release-custody",
            withAgentsAction: this.maintenanceState !== "active" || this.resumeRequired ? "stop-retaining-state" : "stop",
          })),
        // The same digest form `opResumePreserved` binds, so a preserved-exit stop and the later
        // resume name one inventory.
        ...(this.maintenanceState !== "active" && this.preservationAttemptId && this.preservationInventory
          ? { preservation: { attemptId: this.preservationAttemptId, inventorySha256: createHash("sha256").update(JSON.stringify(this.preservationInventory)).digest("hex") } }
          : {}),
      },
    };
  }

  private staticReconciliationStatus(): ManagerStaticReconciliationStatus {
    return this.staticLifecycle.staticReconciliationStatus();
  }

  /** Complete a crashed predecessor's FROZEN registration gate before this incarnation starts a
   *  new one (#783 item 3 / #871). The CLI `cotal reconcile-gate` already does this; a successor
   *  that cannot register is exactly the state that command exists to repair, so boot must run
   *  the SAME composition rather than waiting for an operator.
   *
   *  Admit only `gone` AND `sweepComplete=true` (the probe mapping already folds an incomplete
   *  `gone` into `unestablishable`). Live / unknown / unestablishable / wrong-op-kind stay loud
   *  refusals. No TTL: request-ingress has no process-epoch fence, so a clock would either let a
   *  superseded serve credential keep consuming ingress or just rename the freeze. An open gate
   *  is a no-op (the successor's own freeze comes next). A committed spec under that freeze is
   *  finished at the committed registrationRevision; only a definite no-commit abort-reopens. */
  private async healFrozenRegistrationGate(authKv: KV, instanceId: string, auth: SpaceAuth, recordsKv: KV): Promise<void> {
    const key = epgateKey(MANAGER_ENDPOINT, instanceId);
    const entry = await authKv.get(key);
    if (!entry || entry.operation !== "PUT") return;
    const row = parseEndpointGate(entry.value, key);
    if (row.state !== "frozen") return;
    const servers = this.servers ?? DEFAULT_SERVER;
    const log = (line: string) => console.error(`  ${line}`);
    let report;
    try {
      report = await reconcileEndpointGate({
        kv: authKv, space: this.space, endpoint: MANAGER_ENDPOINT, instanceId,
        probeHolder: makeManagerHolderLivenessProbe({ space: this.space, servers, auth, log, unreachableWaitMs: DELIVERY_ADMIN_BOOT_WAIT_MS }),
        evictHolders: makeManagerEndpointHolderEvictor({ space: this.space, servers, auth, log }),
        log,
        recordsKv,
      });
    } catch (e) {
      // We observed frozen, then a concurrent reconciler finished first. If the gate is now open,
      // this incarnation continues the takeover. Every other refusal — including raced-but-still-
      // frozen — stays loud.
      if (e instanceof GateReconcileRefused && (e.condition === "not-frozen" || e.condition === "raced")) {
        const latest = await authKv.get(key);
        if (latest && latest.operation === "PUT" && parseEndpointGate(latest.value, key).state === "open") {
          console.error(`boot self-heal: ${MANAGER_ENDPOINT}/${instanceId} is open after ${e.condition}; continuing the normal takeover`);
          return;
        }
      }
      throw e;
    }
    console.error(
      `✓ boot self-heal: ${MANAGER_ENDPOINT}/${instanceId} registration gate reopened at generation ${
        report.reopenedAtGeneration} (processEpoch ${report.after.processEpoch}, registrationRevision ${report.after.registrationRevision}; freeze-holder gone, sweepComplete=true). Continuing the normal takeover.`,
    );
  }
  private dialServeConnection(
    state: { nc: NatsConnection; identity: Identity; grant: EpServeGrant; creds?: string },
    readCreds: () => string = () => state.creds!,
    deadline?: number,
  ): Promise<{ nc: NatsConnection; handle: EpServeHandle }> { return this.servePlane.dialServeConnection(state, readCreds, deadline); }
  private registerManagerService(): Promise<void> { return this.servePlane.registerManagerService(); }

  /** Mint the standing `goal-writer` credential and STAGE it into this
   *  instance's §13.1 revocation family (`epcred.<e>.<iid>`), over the passed executor's `authKv`
   *  (the scoped `endpoint-serve-executor`, which holds the epcred write grant). The GRANT profile
   *  stays goal-writer-only (Q2, disjoint from the serve credential); only the FAMILY membership
   *  is shared, so the registration barrier's existing enumerate+revoke+evict catches the
   *  goal-writer on takeover/retire with NO barrier code change. Used both at registration (the run
   *  block's `authKv`) and at renewal (a fresh executor's), re-minting the SAME stable nkey with a
   *  fresh bounded exp: `mintCreds` stamps a random `issuance:` tag on `goal-writer` (`userTags`),
   *  so each issuance signs distinct bytes and stages a distinct ledger row (per-JWT `credentialId`
   *  digest) even within one second. */
  private async mintAndStageGoalWriter(authKv: KV): Promise<string> {
    const auth = this.auth!;
    const identity = this.goalWriterIdentity!;
    // The issuance gate + §13.1 revocation family are keyed by the REGISTRATION instanceId
    // (the persisted logical id), NOT the per-process lifecycleUid — the barrier
    // enumerates `epcred.<e>.<managerInstanceId>`, so the goal-writer must stage into that family.
    const iid = this.managerInstanceId;
    const creds = await mintCreds(auth, identity, "goal-writer", { goalWriter: { endpoint: MANAGER_ENDPOINT } });
    const exp = inspectCredHealth(creds).exp;
    if (exp === undefined)
      throw new Error(`the goal-writer credential for ${MANAGER_ENDPOINT}/${iid} is unbounded; the §13.1 ledger row requires an expiry`);
    const fence = serveIssuanceGateKv(authKv, this.space, { endpoint: MANAGER_ENDPOINT, instanceId: iid });
    const observed = await fence.observe();
    if (observed === null)
      throw new Error(`the issuance gate for ${MANAGER_ENDPOINT}/${iid} vanished; the goal-writer cannot join its §13.1 revocation family`);
    // The §13.1 open-and-commit fence, the SAME one the serve credential's own mint runs: a frozen
    // gate refuses, and a gate that moved under us loses the CAS and revokes the staged row. Without
    // it a barrier mid-takeover (already past its enumeration) would let this credential land
    // ACTIVE in a family nothing revokes again.
    await commitSiblingIssuance(fence, observed, {
      credentialId: credentialIdOf(creds),
      credentialKey: identity.id,
      holderPrincipal: principalKey(DEV_OWNER, identity.id).key,
      endpoint: MANAGER_ENDPOINT, lifecycleUid: iid, sourceChain: ["root"], state: "active", exp,
      generation: observed.generation, processEpoch: observed.processEpoch,
      registrationRevision: observed.registrationRevision, nameAuthorityRevision: observed.nameAuthorityRevision,
    });
    return creds;
  }

  /** #2073: dial the goal-writer's ONE standing connection and rebuild everything derived from it
   *  (the fence-resolving action context, the issuance-gate reader) — shared by the initial start
   *  and the closed-connection recovery ({@link onGoalWriterConnectionClosed}), so a redial never
   *  leaves the context bound to a dead socket. */
  private async dialGoalWriter(
    gw: { nc: NatsConnection; ctx: ActionContext; creds?: string; identity: Identity; gate?: EpIssuanceGate },
  ): Promise<void> {
    const nc = await this.dial({
      ...((this.auth || this.remoteAuthority) ? standaloneConnectOpts({ creds: () => gw.creds!, tls: false }) : {}),
      inboxPrefix: `_INBOX_${gw.identity.id}`,
      maxReconnectAttempts: -1,
    });
    nc.closed().then((err) => { void this.onGoalWriterConnectionClosed(err ?? undefined); });
    this.trackTransport(nc);
    gw.nc = nc;
    // The (i) fence resolver (SPEC 13.6): resolve an executing instance's CURRENT gate
    // epoch. This manager reconciles only ITS OWN goals, so it resolves its own
    // registration instanceId to this incarnation's serve-grant epoch; a foreign/retired instance
    // is `null` (no current terminal to surface). A successor incarnation carries an ADVANCED epoch
    // here, so its reads pick the current-epoch subject and the predecessor's terminal is fenced out.
    gw.ctx = await actionContext(nc, this.space);
    // The own-issuance-gate READER for the currency belt, on BOTH mesh modes. Reads
    // `epgate.<e>.<iid>` over this connection; observe-only (stage/commit/revoke are never called
    // through it — the goal-writer holds no gate/epcred WRITE grant, so a mis-call would
    // broker-deny anyway).
    //
    // OPEN MESH IS NOT EXEMPT, and this is load-bearing. An open-mesh registration mints no
    // credentials, so the §13.1 takeover barrier's revoke-and-evict loop enumerates an EMPTY family
    // and is VACUOUS — yet it still advances processEpoch. The gate row itself DOES exist there
    // (`provisionEndpointGateOpen`, over the authority stores the open serve path ensures), and a
    // bare connection CAN read it (executed probe). So this belt is the ONLY thing standing between
    // a deposed open-mesh incarnation and a wrong terminal on the one create-only result subject.
    //
    // NAME IT HONESTLY: on an open mesh this is a COOPERATIVE fence. The broker enforces nothing, so
    // a hostile or non-conformant process can simply not run the check — the same guarantee class as
    // every other open-mesh property. It is also a read-then-CAS, so it NARROWS the commit window
    // rather than closing it. An AUTH mesh gets durable closure from the §13.1 barrier (revoke +
    // cluster-verified eviction BEFORE the epoch advance); an open mesh gets none.
    gw.gate = serveIssuanceGateKv(await new Kvm(nc).open(epAuthBucket(this.space)), this.space, { endpoint: MANAGER_ENDPOINT, instanceId: this.managerInstanceId });
  }

  /** #2073: the goal-writer rail's closed-connection fault, the same bounded shape the serve rail
   *  uses ({@link onServeConnectionClosed}) through the same {@link boundedReconnect} helper:
   *  re-dial with the current credential (a transport blip needs nothing new), re-mint through the
   *  existing goal-writer renewal branch when the credential itself has expired, then re-attach.
   *  Unlike the serve rail this never exits the process on exhaustion (brief step 4: only the serve
   *  rail is the control plane the report lost) — it logs and leaves the credential to the next
   *  scheduled renewal pass. */
  private async onGoalWriterConnectionClosed(err: Error | undefined): Promise<void> {
    if (this.leaseStopping) return;
    console.error(`! manager goal-writer connection closed: ${err?.message ?? "unknown reason"}`);
    const gw = this.goalWriter;
    const recovered = await this.boundedReconnect("goal-writer", async () => {
      if (!gw) return false;
      if (this.remoteAuthority) await this.renewRemoteBeforeRedial("goal-writer", () => gw.creds);
      else if (gw.creds !== undefined && inspectCredHealth(gw.creds).state !== "healthy") {
        gw.creds = await this.withEndpointServeExecutor(({ authKv }) => this.mintAndStageGoalWriter(authKv));
        this.goalWriterCreds = gw.creds;
      }
      await this.dialGoalWriter(gw);
      console.error("manager goal-writer re-dialed");
      return true;
    }, inspectCredHealth(gw?.creds ?? "").state === "expired");
    if (this.leaseStopping || recovered) return;
    console.error("! manager goal-writer could not be re-dialed; leaving the credential to the next renewal pass");
  }

  /** Spawn-as-action: stand up the standing self-mediated goal-writer connection +
   *  ActionContext. Mode-dual, mirroring {@link registerManagerService}: an AUTH mesh uses the
   *  scoped `goal-writer` credential already minted + family-STAGED inside registration's run block
   *  ({@link mintAndStageGoalWriter} — DISJOINT grant from the serve cred, SHARED §13.1 revocation
   *  family); an OPEN mesh uses a bare connection (no credential system to mint from - the broker
   *  enforces nothing). The connection presents the CURRENT credential on every (re)connect (a
   *  renewal is adopted without reconnecting the whole endpoint); the ActionContext bonds its
   *  KV + JS + JSM to this one connection and space (SPEC 13.4), so a composition mixup cannot splice
   *  goal state across brokers. */
  private async startGoalWriter(): Promise<void> {
    const identity = (this.auth || this.remoteAuthority) ? this.goalWriterIdentity! : newIdentity();
    // The mutable holder captured by the authenticator (mirrors the serve connection): a half-TTL
    // renewal updates `gw.creds` and the next (re)connect presents the refreshed credential.
    const gw: { nc: NatsConnection; ctx: ActionContext; creds?: string; identity: Identity; gate?: EpIssuanceGate } =
      { nc: undefined as unknown as NatsConnection, ctx: undefined as unknown as ActionContext, creds: (this.auth || this.remoteAuthority) ? this.goalWriterCreds : undefined, identity };
    await this.dialGoalWriter(gw);
    this.goalWriter = gw;
    console.error(`manager goal-writer standing (endpoint ${MANAGER_ENDPOINT}, ${(this.auth || this.remoteAuthority) ? "scoped cred, §13.1 family-staged" : "open/bare"})`);
  }

  /** Retire the goal-writer connection (best-effort, both exit paths). */
  private async stopGoalWriter(): Promise<void> {
    const gw = this.goalWriter;
    if (!gw) return;
    this.goalWriter = undefined;
    await this.retireConnection(gw.nc);
  }
  private mintAndStageSessionLedger(authKv: KV): Promise<string> { return this.servePlane.mintAndStageSessionLedger(authKv); }
  private startSessionPlane(): Promise<void> { return this.servePlane.startSessionPlane(); }
  private stopSessionPlane(): Promise<void> { return this.servePlane.stopSessionPlane(); }

  /** The boot reconcile: a fresh incarnation (a manager restart takes a NEW
   *  instanceId, so the in-memory acceptance map starts empty) inherits the endpoint's accepted-but-
   *  unterminal goals from any predecessor. The local signer enumerates with an ephemeral PROVISIONER.
   *  A remote manager calls the authenticated host-owned scan, which keeps the sealed consumer and its
   *  lifecycle authority on the host; the instance executor, goal-writer, and supervisor hold NO records
   *  consumer grant. Settle each orphan so an accepted goal is NEVER dropped across a restart. Open mesh:
   *  a bare connection (the broker enforces nothing). Runs ONCE at start, BEFORE spawn-as-action begins
   *  accepting (the `goalReconcileDone` gate), so it never races a live goal's acceptance. Never
   *  fatal — a reconcile failure is logged and the gate opens either way. */
  private async reconcileGoalIndex(): Promise<void> {
    const gw = this.goalWriter;
    if (!gw) { this.goalReconcileDone = true; return; }
    try {
      let entries: { ref: GoalRef; iid: string; allocated?: GoalIndexEntry["allocated"]; note?: string }[] = [];
      if (this.remoteAuthority) {
        entries = (await this.remoteAuthority.scanGoalIndex()).map((entry) => ({
          ref: { endpoint: entry.endpoint, caller: { owner: entry.owner, actor: entry.actor, uid: entry.uid }, goalId: entry.goalId },
          iid: entry.iid,
          ...(entry.allocated !== undefined ? { allocated: entry.allocated } : {}),
          ...(entry.note !== undefined ? { note: entry.note } : {}),
        }));
      } else {
        const nc = this.auth
          ? await this.dial({ ...standaloneConnectOpts({ creds: await mintCreds(this.auth, newIdentity(), "provisioner"), /* not yet wired to a recorded transport */ tls: false }), maxReconnectAttempts: 0 })
          : await this.dial({ maxReconnectAttempts: 0 });
        try {
          const kvm = new Kvm(nc);
          await ensureAuthorityStores(await jetstreamManager(nc), kvm, this.space);
          entries = await listGoalIndex(await kvm.open(recordsBucket(this.space)), MANAGER_ENDPOINT);
        } finally {
          await drainAndClose(nc);
        }
      }
      // Single-manager: EVERY inherited entry belongs to a DEAD predecessor (only one manager
      // at a time), so all are reconciled. The `iid` field is the hook the multi-instance sweep
      // filters on (skip a goal whose accepting `iid` is a still-LIVE sibling — never settle its goal).
      for (const entry of entries) {
        const key = goalKey(entry.ref);
        if (this.goalAcceptances.has(key) || this.turnRelay.hasAcceptance(key)) continue; // never settle a goal THIS incarnation drives
        try {
          // A note marks a TURN entry: its relay is rebuilt (the hold is its bounded ending), never
          // settled uncertain — the spawn arm's readiness window is the wrong ending for a relay.
          if (entry.note !== undefined) await this.adoptTurnGoal(entry);
          else await this.reconcileOneGoal(entry.ref, entry.iid);
        }
        catch (e) { console.error(`! goal reconcile for ${entry.ref.goalId}: ${rejectionText(e)}`); }
      }
      if (entries.length) console.error(`goal-index boot reconcile: swept ${entries.length} inherited goal(s)`);
    } catch (e) {
      console.error(`! goal-index boot reconcile failed: ${rejectionText(e)} - accepted goals from a predecessor may stay unsettled until the next restart`);
    } finally {
      this.goalReconcileDone = true;
      this.turnRelay.markReconciled(Date.now());
      // A seat that pulled during the window was refused, and a predecessor may have died before
      // its notice went out, so every seat holding a rebuilt turn is told once.
      const seats = this.turnRelay.pendingSeats();
      for (const seat of seats) this.noticeSeatTurns(seat);
    }
  }

  /** Settle ONE inherited goal by evidence: no goal record (a crash between the index write and the
   *  goal-record create) leaves the pointer untouched (never settle a goal that was never accepted,
   *  and clearing it would race a live goal mid-creation); a TERMINAL goal clears the index
   *  (converged — the predecessor committed but died before clearing); a NON-TERMINAL goal settles
   *  `uncertain` (the accepting incarnation is gone, so the success signal will never reach us — the
   *  bounded readiness outcome the plan maps the window to). Within the readiness window it arms a
   *  bounded, unref'd timer to settle at the deadline (an early uncertain would steal a still-possible
   *  success the substrate guards against). */
  private async reconcileOneGoal(ref: GoalRef, acceptedByIid: string): Promise<void> {
    const gw = this.goalWriter;
    if (!gw) return;
    const status = await readGoalStatus(gw.ctx, ref);
    if (status === undefined) return; // index points at no goal record: a dead pointer, left for honesty
    if (GOAL_TERMINAL_STATES.includes(status.value.state)) { await clearGoalIndex(gw.ctx, ref); return; }
    const spec = await readGoalSpec(gw.ctx, ref);
    if (spec === undefined) return; // a status without its spec is garbled — leave for the next boot
    // NEVER A CROSS-INSTANCE SETTLE. The accepting incarnation is recorded on the INDEX ENTRY
    // itself (`iid`, written at accept), which is the honest coordinate: a same-instanceId restart
    // inherits its predecessor's orphans, and a goal accepted by a DIFFERENT (possibly still-live)
    // sibling is left for its owner. This replaces the goal spec's `executor` pin, which existed
    // only to epoch-scope the terminal subject and is gone with it (§13.2 reserved subjects).
    if (acceptedByIid !== this.managerInstanceId) {
      console.error(`goal reconcile ${ref.goalId}: accepted by instance "${acceptedByIid}", not this incarnation "${this.managerInstanceId}"; left for its owner (never a cross-instance settle)`);
      return;
    }
    const settle = async () => {
      // A SUCCESSOR settling work it inherited: the committer is THIS incarnation at its CURRENT
      // serve epoch, which is strictly greater than the goal's acceptedEpoch — the `committed >
      // accepted` arm of the attribution rule, and the reason that arm has to exist.
      await settleGoalUncertain(gw.ctx, { ref, now: Date.now(), committer: { instanceId: this.managerInstanceId, epoch: this.serviceServe?.grant.epoch ?? 0 } }); // first-terminal-wins: a racing terminal returns the winner, no throw
      await clearGoalIndex(gw.ctx, ref);
    };
    const remaining = spec.value.acceptedAt + (spec.value.readinessDeadlineMs ?? this.readinessTimeoutMs) - Date.now();
    if (remaining <= 0) { await settle(); return; }
    console.error(`goal reconcile ${ref.goalId}: within the readiness window (${remaining}ms) - arming a bounded settle`);
    const t = setTimeout(() => { settle().catch((e) => console.error(`! goal reconcile settle ${ref.goalId}: ${rejectionText(e)}`)); }, remaining + 100);
    t.unref?.();
  }

  /** Publish a goal PROGRESS event on the caller-scoped epe subtree, over the SERVE
   *  connection (which holds the `epe.<e>.<iid>.<epoch>.>` egress grant; the goal-writer deliberately
   *  does not). The terminal rides a final event `phase:"terminal"` (the caller follows epe to
   *  the terminal; the durable result fact + inspect/ps are the reconcile authority). A dropped event
   *  is non-fatal (the terminal is authoritative in the journal). */
  private emitGoalProgress(ref: GoalRef, epoch: number, event: Record<string, unknown>): void {
    const nc = this.serviceServe?.nc;
    if (!nc) return;
    try {
      nc.publish(
        epeSubject(this.space, MANAGER_ENDPOINT, this.managerInstanceId, epoch, goalProgressTopic(ref)),
        new TextEncoder().encode(JSON.stringify({ v: 1, goalId: ref.goalId, ...event })),
      );
    } catch (e) {
      console.error(`! goal progress emit for ${ref.goalId} failed: ${rejectionText(e)}`);
    }
  }

  /** The own-gate currency belt: before the goal-writer commits a terminal fact, the manager reads
   *  its OWN issuance gate epoch and REFUSES the commit if superseded. This NARROWS the window; it
   *  is not the fence. Layer 1 below is closed by the sibling-mint fence; layers 2 and 3 are not
   *  closed by any planned slice and must not be described as temporary.
   *
   *  THE RESIDUAL, STACKED:
   *   1. SIBLING-MINT INJECTION. A §13.1 barrier's revoke/evict loop closes only over the family
   *      SNAPSHOT IT ENUMERATED, so a sibling mint that observes the gate and stages a ledger row
   *      WITHOUT the observe/open/commit fence can be staged and released AFTER that enumerate and
   *      never be revoked. This layer is closed exactly where BOTH sibling mint sites
   *      ({@link mintAndStageGoalWriter}, {@link mintAndStageSessionLedger}) route their stage
   *      through `commitSiblingIssuance` (the revision-pinned CAS that makes a losing mint release
   *      nothing), and open exactly where they do not — state the mechanism, never the branch.
   *   2. THE BARRIER WINDOW. A gate FREEZE neither kills this connection nor advances the epoch,
   *      and this belt compares `processEpoch` alone, so it still PASSES from barrier start until
   *      the reopen. A ledger revoke marks a row; it does not re-check a live JWT mid-publish. The
   *      durable kill is the CLUSTER-VERIFIED EVICTION, so a deposed manager can INITIATE new
   *      terminal publishes from barrier start until eviction is verified — not merely finish bytes
   *      already on the wire. Successor EXISTENCE and corpse DEATH are different phases, so the
   *      barrier's ordering licenses no conclusion about when the corpse stops being able to write.
   *   3. OPEN MESH. No credential family exists, so the revoke/evict loop is vacuous and this belt
   *      is COOPERATIVE only: a non-conformant process simply does not run it.
   *  The named follow-up that would close 2 and 3 is the gate-linearized commit (routing the
   *  terminal through the issuance gate's own CAS), deliberately deferred as substrate territory. */
  private async assertGoalWriterEpochCurrent(epoch: number): Promise<void> {
    const gate = this.goalWriter?.gate;
    if (!gate) return; // no goal-writer standing yet
    const observed = await gate.observe();
    if (observed === null)
      throw new EpEnvelopeError("expired", `the manager's issuance gate for ${MANAGER_ENDPOINT}/${this.managerInstanceId} is gone; a retired incarnation never commits a goal terminal (SPEC 13.1/13.6)`);
    if (observed.processEpoch !== epoch)
      throw new EpEnvelopeError("expired", `the manager's issuance gate epoch is ${observed.processEpoch} but this goal was accepted under epoch ${epoch}; a superseded incarnation never commits a goal terminal (SPEC 13.6)`);
  }

  /** A spawn's refusal reaches only its caller's terminal, so the manager also writes one line for it
   *  to its own log, naming the request ID the caller printed, the persona and the reason. */
  private async loggedSpawnRefusal<T>(ctx: EpServeContext, serve: () => Promise<T>): Promise<T> {
    try { return await serve(); }
    catch (e) {
      const persona = (ctx.request.args as { name?: unknown } | undefined)?.name;
      console.error(oneLine(`! spawn request ${ctx.request.id} for persona "${String(persona ?? "")}" refused (${e instanceof EpEnvelopeError ? e.code : "error"}): ${rejectionText(e)}`));
      throw e;
    }
  }

  /** Serve `spawn`/`launch` as an ACTION. Authz already ran in {@link serveGated}. The
   *  accept path runs INLINE on the handler ({@link startAgent} with hooks): the goal binds + the
   *  acceptance replies the moment the identity is minted, BEFORE any provision, or on the
   *  hosted enrollment arm once the host has enrolled the agent; progress and the terminal are driven
   *  OFF-handler, so the ~30s readiness wait no longer blocks the reply.
   *  Returns the acceptance floor payload {name, owner, actor, uid, goalId, fingerprint, executor}
   *  (the ALLOCATED identity). goalId = the request id (env.id). */
  private async serveSpawnGoal(ctx: EpServeContext, run: (hooks: SpawnHooks) => Promise<ControlReply>): Promise<SpawnAcceptance> {
    // These four refuse before anything is accepted or allocated, so they state it (SPEC 13.3).
    if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal(), undefined, "not-executed");
    const gw = this.goalWriter;
    if (!gw) throw new EpEnvelopeError("unavailable", "the manager goal-writer connection is not standing; spawn-as-action cannot accept (SPEC 13.6)", undefined, "not-executed");
    // Refuse to accept until the boot reconcile of inherited goals completes, so a fresh
    // acceptance never races the sweep (settling a live goal mid-flight would steal its real terminal).
    if (!this.goalReconcileDone)
      throw new EpEnvelopeError("unavailable", "the manager is still reconciling accepted goals at boot; retry shortly (SPEC 13.6)", undefined, "not-executed");
    const goalId = ctx.request.id;
    const { fingerprint } = submissionFingerprint(ctx.request as unknown, ctx.subject);
    const ref = goalRefOf(ctx.subject, goalId);
    const key = goalKey(ref);
    const executor = { lifecycleUid: this.managerInstanceId, epoch: this.serviceServe?.grant.epoch ?? 0 };
    const epoch = executor.epoch;
    const acceptedAt = Date.now();

    // Idempotent same-goalId retry (a client re-send): serve the IDENTICAL acceptance without
    // re-running the accept path — so a HARD-PINNED retry does not trip the same-name refuse and no
    // name is re-allocated. Same-incarnation rides the live map; the create-only bindGoal in onAccepted
    // still fences a CONCURRENT same-goalId race (the loser aborts and serves the winner's acceptance).
    const prior = this.goalAcceptances.get(key);
    // A goal that already ENDED is answered from its committed terminal and never accepted again.
    // Running the accept for it allocates a fresh name and identity, then refuses at the index
    // CAS, because the entry its terminal cleared cannot be created twice, and that refusal tells
    // the caller to reconcile the store. A retry that outlived its entry above must not reach it.
    const ended = prior === undefined ? await readGoalResult(gw.ctx, ref) : undefined;
    const accepted = prior ?? ended;
    if (accepted !== undefined) {
      if (accepted.fingerprint !== fingerprint)
        throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" was accepted under a different submission; one goalId never carries two specs (SPEC 13.6)`, undefined, "not-executed");
      return prior ?? this.cachedSpawnAcceptance(ref, goalId, fingerprint, executor);
    }

    let resolveAccept!: (a: SpawnAcceptance) => void;
    let rejectAccept!: (e: unknown) => void;
    const acceptP = new Promise<SpawnAcceptance>((res, rej) => { resolveAccept = res; rejectAccept = rej; });
    let acceptance: SpawnAcceptance | undefined;
    let readinessTimeoutMs = this.readinessTimeoutMs;
    // H1: set the instant the terminal path is ENTERED, not when it succeeds — the post-accept
    // fallback below must fire only when `onOutcome` never ran at all, never as a second attempt
    // behind a commit that threw.
    let terminalEntered = false;
    // TWO DIFFERENT QUESTIONS, DELIBERATELY NOT ONE FLAG.
    //
    //   `terminalEntered`  HAS this goal already been settled (or claimed) by someone?
    //   `ownsGoal`         MAY THIS ATTEMPT settle it at all?
    //
    // The second is the authority, and it is default-CLOSED: an attempt earns it by WINNING the
    // create-only `bindGoal` CAS below, and nothing else grants it. That matters because the
    // post-accept fallback exists to settle a goal nobody answered, so every new way of leaving
    // this function is opted INTO committing a terminal unless something stops it. Deriving the
    // right from the claim instead of from a running record means a losing attempt CANNOT commit
    // down any unwind path, including ones added later that never thought about this. Collapsing
    // the two into one boolean is what let a duplicate-goal loser steal the winner's terminal
    // (#357): it had entered no terminal, so the fallback wrote one for it, using its own abort
    // message as the caller-visible outcome.
    let ownsGoal = false;
    // Set by onEffect. A refusal that arrives with it still false changed nothing.
    let effectStarted = false;
    // Set by onUndone: the host's code for a later refusal that left nothing behind.
    let undone: EpErrorCode | undefined;
    // The task of a once spawn, once accepted.
    let onceRef: GoalRef | undefined;

    // The terminal commits OFF-handler on the goal-writer connection (manager-only authority; a
    // caller cannot publish it). TWO COMPOSED FENCES (defense in depth): (a) reads THIS
    // incarnation's OWN gate epoch and REFUSES a superseded commit (the currency belt), and (b)
    // barrier-revoke evicts this connection on takeover. The terminal lands on the ONE subject
    // SPEC §13.2 (reserved subjects) reserves; first-terminal-fact-wins is global, so a committed outcome is visible
    // to every reader in every incarnation. On success the reconcile-index entry is cleared.
    //
    // Named rather than inlined into the hooks below so the H1 post-accept fallback drives THIS
    // path — one commit site, so the progress event, the index clear and the `agentGoals` cleanup
    // cannot drift between a normal outcome and a recovered one.
    const onOutcome = async (o: { kind: "succeeded" | "failed" | "uncertain"; data?: unknown }): Promise<boolean> => {
      // THE AUTHORITY CHECK, and the only one. An attempt that never won the bind provisioned
      // nothing and has no outcome to report: the goal belongs to whoever won it, in this
      // incarnation or a sibling. Refusing here rather than at each unwind site is the point --
      // there is exactly one commit path, so this fences every route into it, present and future.
      if (!ownsGoal) return false;
      terminalEntered = true; // entered, not succeeded — see the catch below
      // A once spawn that did not succeed never served its task (delivery opens only with a
      // succeeded verdict), so the task is cancelled now rather than at the seat's exit. A launched
      // seat's debt is still settled by its exit, which proves the seat gone first; a spawn that
      // never launched one owes nothing more.
      if (o.kind !== "succeeded" && onceRef !== undefined) {
        const reason = o.kind === "uncertain" ? "readiness-timeout" : "launch-failed";
        if (this.onceWatched.has(goalKey(onceRef))) void this.commitOnceCancel(onceRef, reason).catch((e: unknown) => console.error(`! once task ${onceRef!.goalId} (${reason}): ${rejectionText(e)}; its seat's exit cancels it`));
        else void this.settleOnceTurn(onceRef, reason);
      }
      try {
        await this.assertGoalWriterEpochCurrent(epoch); // a superseded corpse never commits
        let fact;
        if (o.kind === "succeeded") {
          this.emitGoalProgress(ref, epoch, { phase: "presence" });
          ({ fact } = await commitGoalResult(gw.ctx, { ref, now: Date.now(), cause: "complete", state: "succeeded", data: o.data, committer: { instanceId: this.managerInstanceId, epoch } }));
        } else if (o.kind === "failed") {
          ({ fact } = await commitGoalResult(gw.ctx, { ref, now: Date.now(), cause: "complete", state: "failed", data: o.data, committer: { instanceId: this.managerInstanceId, epoch } }));
        } else {
          // Forward the readiness detail as the terminal's reason: this manager owns the deadline,
          // so it owns what elapsing it MEANS. Absent, core commits its own generic line (#605).
          const { reason: why, running } = (o.data ?? {}) as { reason?: unknown; running?: unknown };
          ({ fact } = await settleGoalUncertain(gw.ctx, { ref, now: Date.now(), committer: { instanceId: this.managerInstanceId, epoch }, ...(typeof why === "string" && why.length > 0 ? { reason: why } : {}), ...(running === true ? { running: true } : {}) }));
        }
        this.expireGoalAcceptance(ref);
        this.emitGoalProgress(ref, epoch, { phase: "terminal", state: fact.state, ...(fact.data !== undefined ? { data: fact.data } : {}) });
        await clearGoalIndex(gw.ctx, ref); // terminal reached - the successor never reconciles it
        if (acceptance) this.agentGoals.delete(acceptance.name); // goal terminal - no cancel path left
        return true;
      } catch (e) {
        // THE NARROWER LEG, LEFT OPEN DELIBERATELY. If the COMMIT ITSELF throws (the currency belt
        // refused a superseded commit, or the broker failed) there is genuinely no terminal, and the
        // H1 fallback must NOT retry it: a retry either loses the same way or overwrites a real
        // supersession refusal with a manufactured outcome. That is why `terminalEntered` is set on
        // ENTRY. This leg is infrastructure-class and converges through the reconcile index at the
        // next boot, which is why the index is NOT cleared above on this path. Do not "close" it
        // here with a retry loop.
        console.error(`! goal terminal commit for ${goalId} failed: ${rejectionText(e)}`);
        return false;
      }
    };

    const bg = run({
      onAccepted: async ({ name, agentTriple }) => {
        // Record the goal in the reconcile index BEFORE the bind (index-CAS-before-bind),
        // so a successor incarnation finds + settles this goal if we crash before its terminal. A
        // crash between this write and the bind leaves an index entry whose goal status is absent —
        // the sweep clears it as a no-goal; a crash before it leaves no entry (never durable). A
        // Carry THIS incarnation's instanceId (the executor coord) so a multi-instance sweep can skip a live sibling's goal.
        //
        // H2, THE ACCEPTANCE FLOOR: the allocated identity is written HERE, before the bind and so
        // before the acceptance is acked, because this entry is the only durable record of it that
        // exists that early — the goal spec does not carry it and the terminal does not exist yet.
        // A same-goalId attempt that loses the bind while the winner is still in flight can then
        // serve what the winner actually allocated instead of inventing an empty identity.
        const idx = await recordGoalIndex(gw.ctx, ref, executor.lifecycleUid, { name, owner: agentTriple.owner, actor: agentTriple.actor, uid: agentTriple.uid, readinessDeadlineMs: readinessTimeoutMs });
        // A create loss is an idempotent retry ONLY for the same incarnation. A FOREIGN iid means a
        // sibling instance accepted this goalId (the live vector is a client retry over ANYCAST, not
        // a journal consumer): this attempt provisions nothing and answers with the winner's floor,
        // or refuses if that instance never persisted one.
        if (!idx.recorded && idx.existing.iid !== executor.lifecycleUid) {
          acceptance = await this.acceptanceFromIndex(idx.existing, ref, goalId, fingerprint, executor);
          resolveAccept(acceptance);
          // No claim needed here: `ownsGoal` is still false, so the commit path refuses this attempt.
          throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" was accepted by instance "${idx.existing.iid}"; that instance's acceptance is served and this attempt provisions nothing (SPEC 13.6)`);
        }
        // Bind AFTER the accept-path checks (name/capacity/persona) + identity mint, BEFORE any provision:
        // a create-only CAS per goalId (a refused accept above left zero bind, zero reserve).
        const b = await bindGoal(gw.ctx, ref, fingerprint);
        if (!b.bound) {
          if (b.existing.fingerprint !== fingerprint)
            throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" is already bound to a different submission; one goalId never carries two specs (SPEC 13.6)`);
          // Lost a concurrent same-goalId race: serve the winner's acceptance and abort THIS provision
          // (no second spawn). The throw unwinds to the finally, which releases this attempt's reserve.
          acceptance = this.goalAcceptances.get(key) ?? await this.cachedSpawnAcceptance(ref, goalId, fingerprint, executor);
          resolveAccept(acceptance);
          // No claim needed here either. This attempt lost the CAS, so `ownsGoal` is still false and
          // the single check in `onOutcome` refuses it. Before that check existed this site had to
          // remember to claim the terminal by hand, and the one place that forgot is how a loser
          // came to commit `failed` on the winner's goal, using its own abort text as the outcome.
          // Unwind the provision (the acceptance is already served); the code is discarded by the
          // caller (acceptance !== undefined), so it just aborts this attempt's side-effects.
          throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" is already accepted; the cached acceptance is served`);
        }
        // WON the claim: this attempt, and only this attempt, may settle this goal.
        ownsGoal = true;
        await createGoal(gw.ctx, ref, {
          fingerprint,
          command: ctx.subject.command,
          caller: { id: `${ctx.subject.caller.owner}.${ctx.subject.caller.actor}`, lifecycleUid: ctx.subject.caller.uid },
          // The ACCEPTING incarnation's epoch: half of the terminal's attribution pair (§13.6).
          acceptedEpoch: epoch,
          requestId: goalId,
          sourceSeq: 0,
          acceptedAt,
          readinessDeadlineMs: readinessTimeoutMs,
        });
        acceptance = { name, owner: agentTriple.owner, actor: agentTriple.actor, uid: agentTriple.uid, goalId, fingerprint, readinessDeadlineMs: readinessTimeoutMs, executor };
        this.goalAcceptances.set(key, acceptance);
        this.agentGoals.set(name, ref); // A despawn of this name mid-goal drives the cancel path
        resolveAccept(acceptance);
        this.emitGoalProgress(ref, epoch, { phase: "handoff" });
      },
      onLaunched: () => this.emitGoalProgress(ref, epoch, { phase: "launched" }),
      onReadinessWindow: (value) => { readinessTimeoutMs = value; },
      onOutcome,
      // Claim the terminal WITHOUT committing one: the despawn/stop that ended this launch owns
      // it and commits `cancel`. This only stops the non-ok reply below from manufacturing a
      // `failed` that would race that `cancel` (first-terminal-fact-wins).
      onTerminalDeferred: () => { terminalEntered = true; },
      onEffect: () => { effectStarted = true; },
      onUndone: (code) => { undone = code; },
      onOnce: async (task) => {
        try {
          const accepted = await this.acceptOnceTurn({ spawnRef: ref, fingerprint, command: ctx.subject.command, executor, acceptedAt, ...task });
          onceRef = accepted.ref;
          return accepted;
        } catch (e) {
          // The spawn goal is already bound, so its refusal is a terminal: nothing has launched.
          await onOutcome({ kind: "failed", data: { error: `the once task was not accepted: ${rejectionText(e)}` } });
          throw e;
        }
      },
    });
    bg.then((reply) => {
      // Refused BEFORE onAccepted (hard-pin collision, capacity, persona-not-found) — no goal bound.
      // Only a refusal before the first effect, or one whose effects were all removed, states
      // `not-executed`; a later one, such as the alias gate that re-drives a teardown, leaves the
      // outcome unknown.
      if (acceptance === undefined) {
        const details = reply.details;
        const code = undone ?? reply.code ?? "failed-precondition";
        rejectAccept(new EpEnvelopeError(code as EpErrorCode, reply.error ?? "spawn refused at accept", details, effectStarted && undone === undefined ? undefined : "not-executed"));
        return;
      }
      // H1: `run` CATCHES its own body (a throw in buildLaunch/runtime.spawn) and RESOLVES `{ok:false}`
      // rather than rejecting, so a post-accept failure arrives here, not in the catch below, and
      // reaches none of the onOutcome sites. Without this the goal stays accepted-but-unanswered:
      // the caller follows epe to a terminal that never comes, and the reconcile index that would
      // settle it is only swept at BOOT, so a manager that stays up never converges it.
      if (reply.ok === false && !terminalEntered)
        return onOutcome({ kind: "failed", data: failedTerminal(reply.error ?? "spawn failed after accept", reply) });
    }).catch((e) => {
      if (acceptance === undefined) { rejectAccept(e); return; }
      // Same obligation for a genuine rejection (one that escaped `run`'s own catch).
      if (!terminalEntered)
        return onOutcome({ kind: "failed", data: failedTerminal(rejectionText(e), caughtEnvelope(e)) });
      console.error(`! spawn-as-action async body for ${goalId}: ${rejectionText(e)}`);
    }).catch((e) => console.error(`! goal terminal fallback for ${goalId}: ${rejectionText(e)}`));
    return acceptP;
  }

  /** H2: an acceptance served from a WINNER'S durable acceptance floor (the goal-index entry it
   *  wrote before its own ack). Refuses `unavailable` rather than inventing one — see
   *  {@link cachedSpawnAcceptance} for why an empty identity is never an acceptable answer. */
  private async acceptanceFromIndex(entry: GoalIndexEntry, ref: GoalRef, goalId: string, fingerprint: string, executor: { lifecycleUid: string; epoch: number }): Promise<SpawnAcceptance> {
    if (entry.allocated?.owner === undefined)
      throw new EpEnvelopeError("unavailable", `goal "${goalId}" was accepted by instance "${entry.iid}", which persisted no acceptance floor naming its owner; its allocated identity is not readable from here (SPEC 13.6)`);
    const readinessDeadlineMs = entry.allocated.readinessDeadlineMs ?? (await readGoalSpec(this.goalWriter!.ctx, ref))?.value.readinessDeadlineMs;
    if (readinessDeadlineMs === undefined)
      throw new EpEnvelopeError("unavailable", `goal "${goalId}" is accepted but its readiness deadline is not readable; a synchronous follower cannot bound its wait honestly (SPEC 13.6)`);
    return { name: entry.allocated.name, owner: entry.allocated.owner, actor: entry.allocated.actor, uid: entry.allocated.uid, goalId, fingerprint, readinessDeadlineMs, executor };
  }

  /** Reconstruct a cached acceptance for a same-goalId retry NOT in the live map (a prior incarnation
   *  accepted it, or a concurrent winner whose map write this reader has not yet observed).
   *
   *  H2 — WHY THIS PREFERS THE INDEX OVER THE TERMINAL. It used to read only the committed terminal
   *  and fall back to `{name:"", actor:"", uid:""}` when there was none. That is the common case,
   *  not a corner: a client retry over ANYCAST reaches a sibling while the winner is still
   *  provisioning, so no terminal exists yet, and the caller was handed an ACCEPTED reply naming an
   *  empty agent it can never address. The acceptance floor in the goal index exists from the moment
   *  of acceptance, so it answers precisely the window the terminal cannot. Where neither is
   *  readable the honest answer is a REFUSAL: an accepted goal whose identity nobody can name is
   *  `unavailable` while it runs and its cached outcome once it has ended, never a hollow success. */
  private async cachedSpawnAcceptance(ref: GoalRef, goalId: string, fingerprint: string, executor: { lifecycleUid: string; epoch: number }): Promise<SpawnAcceptance> {
    const entry = await readGoalIndex(this.goalWriter!.ctx, ref);
    if (entry?.allocated !== undefined) return this.acceptanceFromIndex(entry, ref, goalId, fingerprint, executor);
    // The index is CLEARED at terminal, so a settled goal legitimately has no entry: fall back to
    // the terminal's data, which carries the same identity for exactly that case.
    const result = await readGoalResult(this.goalWriter!.ctx, ref);
    const d = (result?.data ?? {}) as { name?: string; id?: string; lifecycleUid?: string };
    const spec = await readGoalSpec(this.goalWriter!.ctx, ref);
    const readinessDeadlineMs = spec?.value.readinessDeadlineMs;
    // The terminal names the agent by its slot id: the `owner.actor` principal in user mode, the
    // bare nkey under DEV_OWNER on a static mesh.
    const principal = typeof d.id !== "string" || d.id.length === 0 ? null : this.userMode ? parsePrincipalKey(d.id) : { owner: DEV_OWNER, actor: d.id };
    if (typeof d.name === "string" && d.name.length > 0 && principal !== null && typeof d.lifecycleUid === "string" && d.lifecycleUid.length > 0 && readinessDeadlineMs !== undefined)
      return { name: d.name, owner: principal.owner, actor: principal.actor, uid: d.lifecycleUid, goalId, fingerprint, readinessDeadlineMs, executor };
    // Only a `succeeded` terminal names the agent. Any other ended goal has its outcome as its
    // whole durable answer, and no retry will make an identity readable (SPEC 13.6 item 5).
    if (result !== undefined) throw goalAlreadyTerminal(goalId, result);
    throw new EpEnvelopeError("unavailable", `goal "${goalId}" is already accepted but its allocated identity is not readable (no acceptance floor, and no terminal carrying one); retry (SPEC 13.6)`);
  }

  /** Drop a goal's acceptance {@link goalAcceptanceRetentionMs} after its terminal committed. A
   *  retry after that reads the terminal, so only a goal that has one may be passed here. */
  private expireGoalAcceptance(ref: GoalRef): void {
    const key = goalKey(ref);
    setTimeout(() => this.goalAcceptances.delete(key), this.goalAcceptanceRetentionMs).unref?.();
  }

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
  private serveTurnGoal(
    ctx: EpServeContext,
    target: { kind: "managed"; agent: ManagedAgent; name: string } | { kind: "personal"; participant: PersonalTurnParticipant; name: string },
  ): Promise<TurnAcceptance> { return this.turnRelay.serveTurnGoal(ctx, target); }

  /** The seat's pull: every pending turn addressed to the CALLER's incarnation, oldest first.
   *  The uid is part of the address — a successor seat never receives a predecessor's turn. */
  private turnPendingFor(c: { owner: string; actor: string; uid: string }): { turns: { goalId: string; payload: string; acceptedAt: number; deadlineAt?: number; once?: true }[]; notices: true; stop?: true } { return this.turnRelay.turnPendingFor(c); }

  /** Tell a seat that its `turn-pending` answer changed (SPEC 14.3 turn notice), over the serve
   *  connection that holds this instance's reply rows. The notice carries no turn and the seat
   *  pulls on it, so a lost notice delays that seat until its next pull, and nothing else. */
  private noticeSeatTurns(seat: { name: string; owner: string; actor: string; uid: string }): void {
    const serve = this.serviceServe;
    if (!serve) return;
    // An issued seat credential reads only the versioned rail, under the generation it was issued.
    const a = this.agents.get(seat.name);
    const participant = this.currentParticipant(seat.owner, seat.actor, seat.uid);
    const generation = a?.lifecycleUid === seat.uid ? a.issued?.generation : participant?.generation;
    const caller = { owner: seat.owner, actor: seat.actor, uid: seat.uid, ...(generation !== undefined ? { generation } : {}) };
    try {
      serve.nc.publish(turnNoticeSubject(this.space, this.managerInstanceId, serve.grant.epoch, caller), new TextEncoder().encode(JSON.stringify({ v: 1 })));
    } catch (e) {
      console.error(`! turn notice for ${seat.actor} failed: ${rejectionText(e)}`);
    }
  }

  /** The seat's yield: claim the hold (one-use; expiry fails closed), then commit the goal
   *  `succeeded` carrying the TurnResult. A yield AFTER the deadline drives the deadline terminal
   *  instead and refuses — the expiry outcome stands, never a late success over it. */
  private serveTurnYield(c: { owner: string; actor: string; uid: string }, raw: Record<string, unknown>): Promise<{ goalId: string; state: string }> { return this.turnRelay.serveTurnYield(c, raw); }

  /** A once seat's report that its task's handoff to its harness was not confirmed. The seat sealed
   *  the task before it reported, so nothing hands it over again; the task fails
   *  `delivery-unconfirmed` and the seat is stopped. The commit proves the seat's live currency, as
   *  a yield's does: a seat already gone commits nothing here, and its exit cancels the task. Only
   *  the addressed seat may report, only for its once task; a repeat after the terminal is answered
   *  with it. */
  private serveTurnUnconfirmed(c: { owner: string; actor: string; uid: string }, raw: Record<string, unknown>): Promise<{ goalId: string; state: string }> { return this.turnRelay.serveTurnUnconfirmed(c, raw); }

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
  private serveTurnCancel(ctx: EpServeContext): Promise<{ goalId: string; state: string }> { return this.turnRelay.serveTurnCancel(ctx); }

  /** The reap hook: a pending turn addressed to the reaped INCARNATION is MARKED dead, never
   *  settled early — no honest terminal exists for it (a completion must prove the executor's
   *  live currency, and the hold is only expirable once due), so the entry rides to its deadline
   *  and the deny then records both facts. The addressee's own client observes the death from
   *  presence long before that, which is the run's L4002. */
  private failSeatTurns(name: string, uid: string): void { return this.turnRelay.failSeatTurns(name, uid); }

  /** Adopt one inherited TURN goal at boot (the reconcile sweep's turn branch): a non-terminal
   *  entry carrying a parseable note rebuilds its pending relay — never an `uncertain` settle,
   *  because the deadline hold IS this goal's bounded ending and it survived the restart. No
   *  liveness verdict is made here (the agents map is empty during reconcile, so absence means
   *  "not yet re-registered", never "dead"); a garbled note or a floor that does not name the
   *  seat's owner is logged and left, the dead-pointer honesty rule. */
  private adoptTurnGoal(entry: { ref: GoalRef; iid: string; allocated?: GoalIndexEntry["allocated"]; note?: string }): Promise<void> { return this.turnRelay.adoptTurnGoal(entry); }

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
  private acceptOnceTurn(o: {
    spawnRef: GoalRef; fingerprint: string; command: string; executor: { lifecycleUid: string; epoch: number }; acceptedAt: number;
    seat: { name: string; owner: string; actor: string; uid: string }; prompt: string; spawner: string; deadlineMs: number | undefined; readinessDeadlineMs: number; retire?: string;
  }): Promise<{ ref: GoalRef; deadlineAt?: number }> { return this.turnRelay.acceptOnceTurn(o); }

  /** How a once seat's startup watch ended, waited for until {@link STARTUP_OUTCOME_MS} after its
   *  launch or the readiness window, whichever is longer. A watch that has not ended by then, or a
   *  seat being stopped, answers what the handle reports at that moment. */
  private async awaitStartupOutcome(a: ManagedAgent, launchedAt: number, readinessTimeoutMs: number): Promise<StartupOutcome> {
    const until = launchedAt + Math.max(readinessTimeoutMs, STARTUP_OUTCOME_MS);
    for (;;) {
      const outcome = a.handle.startupOutcome?.() ?? "pending";
      if (outcome !== "pending" || a.terminalizing || this.leaseStopping || Date.now() >= until) return outcome;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** Serve a once task from now on: its spawn's succeeded terminal is written. */
  private openOnceDelivery(ref: GoalRef): void { return this.turnRelay.openOnceDelivery(ref); }

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
    this.trackStoppedHandle(a, false, cause);
    void this.cancelAgentGoal(a.name, "graceful");
  }

  /** The once task's exit hook, on the handle the seat was launched with: whichever path ends the
   *  seat, its proved exit cancels a task that has no terminal yet and discharges the seat's debt. An
   *  exit that cannot be proved leaves both. */
  private watchOnceExit(a: ManagedAgent): void {
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
  private settleOnceTurn(ref: GoalRef, reason: string, retire?: OnceRetire): Promise<void> { return this.turnRelay.settleOnceTurn(ref, reason, retire); }

  /** Cancel a once task with `reason` unless it already has a terminal. */
  private commitOnceCancel(ref: GoalRef, reason: string): Promise<void> { return this.turnRelay.commitOnceCancel(ref, reason); }

  /** Ask the seat's connector to prove its launched processes gone, within {@link ONCE_RETIRE_MS}.
   *  Throws without that proof. */
  private async retireOnceSeat(r: OnceRetire): Promise<{ discard(): Promise<void> }> {
    const connector = await this.resolveConnector(r.connector);
    if (!connector.retireAfterExit) throw new Error(`the ${r.connector} connector cannot prove seat ${r.name}'s launched processes gone`);
    return withTimeout(
      connector.retireAfterExit({ space: this.space, name: r.name, lifecycleUid: r.uid, workspaceRoot: this.workspaceRoot }),
      ONCE_RETIRE_MS,
      `seat ${r.name}'s launched processes were not proved gone within ${ONCE_RETIRE_MS}ms`,
    );
  }

  /** Make an adopted seat a once seat again: its exit settles its task, and the task is served to
   *  it. A task that ended before the restart owes the stop the predecessor may not have made. */
  private bindOnceSeat(a: ManagedAgent): Promise<void> { return this.turnRelay.bindOnceSeat(a); }

  /** Settle race: a despawn MID-GOAL drives the goal's cancel terminal - transition to
   *  `cancelling`, then commit the `cancel` cause on the goal-writer connection. First-terminal-fact
   *  wins: if the readiness outcome already committed (succeeded/failed/uncertain) the transition or
   *  the create-only commit loses gracefully and the readiness terminal stands. Fire-and-forget from
   *  despawn (the process teardown is authoritative for the agent; this settles the GOAL honestly).
   *  Cancel rides the despawn's own authorizeNamed reach - there is no cancel-by-goalId. */
  private async cancelAgentGoal(name: string, mode: "graceful" | "terminate"): Promise<void> {
    const gw = this.goalWriter;
    const ref = this.agentGoals.get(name);
    if (!gw || !ref) return;
    this.agentGoals.delete(name);
    const epoch = this.serviceServe?.grant.epoch ?? 0;
    try {
      await this.assertGoalWriterEpochCurrent(epoch); // a superseded corpse never commits a cancel terminal either
      await transitionGoal(gw.ctx, ref, "cancelling", { fields: { cancelMode: mode } });
      const r = await commitGoalResult(gw.ctx, { ref, now: Date.now(), cause: "cancel", data: { cancelledBy: "despawn" }, committer: { instanceId: this.managerInstanceId, epoch } });
      this.expireGoalAcceptance(ref);
      this.emitGoalProgress(ref, epoch, { phase: "terminal", state: r.fact.state, ...(r.fact.data !== undefined ? { data: r.fact.data } : {}) });
      await clearGoalIndex(gw.ctx, ref); // terminal reached - the successor never reconciles it
    } catch {
      // the goal already terminalized (the readiness outcome won the settle race) - nothing to cancel.
    }
  }

  private recordSlotRuntime(a: ManagedAgent): Promise<void> {
    return this.seatCustody.recordSlotRuntime(a);
  }

  private recordSlotCustody(a: { name: string; id: string; lifecycleUid: string }, runtime: RuntimeReference): Promise<void> {
    return this.seatCustody.recordSlotCustody(a, runtime);
  }

  private reserveCustody(runtime: Runtime): RuntimeReference | undefined {
    return this.seatCustody.reserveCustody(runtime);
  }

  private spawnCustodied(runtime: Runtime, name: string, spec: LaunchSpec, cwd: string, reserved: RuntimeReference | undefined): Promise<AgentHandle> {
    return this.seatCustody.spawnCustodied(runtime, name, spec, cwd, reserved);
  }

  /** Keep launch provenance independent of status and runtime wire contracts. */
  private watchConnectorHolder(handle: AgentHandle, holder: ReturnType<typeof retainConnectorSeat>): void {
    if (!holder.active) return;
    holder.launched(handle.pid);
    // A released handle may outlive its Manager. Only an authoritative exit removes
    // identity-less holders, never a release or a failed stop request.
    watchProvedExit(handle, () => holder.ended(), () => true);
  }

  private recordSeat(a: ManagedAgent): void {
    return this.seatCustody.recordSeat(a);
  }

  private refreshSeatRecord(a: ManagedAgent): void {
    return this.seatCustody.refreshSeatRecord(a);
  }

  private dropSeatRecord(a: { name: string; lifecycleUid: string }): void {
    return this.seatCustody.dropSeatRecord(a);
  }

  /** True when a default stop wrote a runtime reference for this exact lifecycle and it is still
   *  there. That file is what a later manager adopts, so a slot free must not remove it before the
   *  retirement that confirms the lifecycle is gone. */
  private releasedSeatPending(a: { name: string; lifecycleUid: string }): boolean {
    try {
      return readReleasedSeatReference(this.workspaceRoot, this.space, a.name)?.lifecycleUid === a.lifecycleUid;
    } catch {
      return false;
    }
  }

  private seatRecordFor(row: StaticManagedSlotRow): SeatRecord | undefined {
    return this.seatCustody.seatRecordFor(row);
  }

  private adoptSeat(row: StaticManagedSlotRow, record: SeatRecord): Promise<string | undefined> {
    return this.seatCustody.adoptSeat(row, record);
  }

  private restartSupervisedSeat(row: StaticManagedSlotRow, record: SeatRecord): Promise<string | undefined> {
    return this.seatCustody.restartSupervisedSeat(row, record);
  }

  private reapOrphanSeat(a: { name: string; runtime?: RuntimeReference }): Promise<void> {
    return this.seatCustody.reapOrphanSeat(a);
  }

  private driveStaticRetirement(a: TeardownTarget, surfaceFailure = false, onDeprovision?: (accounting: DeprovisionResourceAccounting) => void): Promise<void> {
    return this.staticLifecycle.driveStaticRetirement(a, surfaceFailure, onDeprovision);
  }

  private openStaticChatSession(raw: unknown): Promise<{ alias: string; actor: string; lifecycleUid: string; expiresAt: number; sealer: string; sealed: string }> {
    return this.staticLifecycle.openStaticChatSession(raw);
  }

  private retireStaticChatSession(raw: unknown): Promise<{ outcome: "retired" | "alreadyRetired" | "failed"; reason?: string }> {
    return this.staticLifecycle.retireStaticChatSession(raw);
  }

  private retireChatSessionsOnStop(): Promise<void> {
    return this.staticLifecycle.retireChatSessionsOnStop();
  }

  private reportChatSessionsLeftAtStop(why: string): void {
    return this.staticLifecycle.reportChatSessionsLeftAtStop(why);
  }

  private renewManagedStaticCred(a: ManagedAgent): Promise<void> {
    return this.staticLifecycle.renewManagedStaticCred(a);
  }

  private readStaticReconcileSlot(alias: string): Promise<StaticManagedSlotRow | undefined> {
    return this.staticLifecycle.readStaticReconcileSlot(alias);
  }

  private awaitStaticReconcileDrain(): Promise<void> {
    return this.staticLifecycle.awaitStaticReconcileDrain();
  }

  private reconcileStaticLifecycles(postAdoption = false): Promise<void> {
    return this.staticLifecycle.reconcileStaticLifecycles(postAdoption);
  }

  /** The membership gate: decide a control caller by its
   *  AUTHENTICATED wire principal. A LIVE managed slot passes (unless terminalizing); a RETIRING
   *  hold or a RETIRED static incarnation refuses even with a tier-valid JWT (the
   *  copied-credential vector — its subject can never collide with a successor's, so this match
   *  is non-forgeable); any OTHER principal is not a managed lifecycle (an operator instrument:
   *  the credential tier governs, exactly as before). Never name alone, never a payload field. */
  private lifecycleMembershipRefusal(caller: string): string | undefined {
    for (const a of this.agents.values()) {
      if (this.managedPrincipal(a) === caller)
        return a.terminalizing
          ? `the caller's lifecycle ${a.lifecycleUid} is terminalizing; control is refused from the first terminal step`
          : undefined;
    }
    return this.retirement.membershipRefusal(caller);
  }

  /** Open a short-lived PROVISIONER connection, run the onboarding ops on it, and drain it (closure (ii),
   *  residual 2). The DM/DLV consumer-create surface — the irreducible onboarding power — lives only for
   *  this window, never as a standing grant on the long-lived supervisor. A provision-only endpoint
   *  (no presence/consume/channel-watch) connected with memory-only `provisioner` creds; it sets its own
   *  `inboxPrefix` so JS-API replies land on the `_INBOX_<id>.>` the provisioner cred subscribes. */
  private async withProvisioner<T>(fn: (prov: CotalEndpoint) => Promise<T>): Promise<T> {
    if (!this.auth) throw new Error("withProvisioner: no space auth (an open mesh has no scoped creds)");
    // Onboarding runs several provisioning ops, so it keeps the provisioner profile's five-minute window.
    return withScopedEndpoint({ space: this.space, servers: this.servers ?? DEFAULT_SERVER, auth: this.auth }, "provisioner", "provisioner", fn, 5 * 60);
  }

  /** A connection holding this instance's transfer reader grants (docs/design/resume-transfer.md
   *  section 6) for this one receive or sweep: minted from the space's signing seed, or issued by the
   *  host to a remote manager. An open mesh enforces no grants, so a bare one-shot connection is that
   *  reader there. */
  private async withTransferReader<T>(fn: (nc: NatsConnection) => Promise<T>): Promise<T> {
    const issue = this.remoteAuthority?.mintTransferReader;
    if (this.remoteAuthority && !issue) throw new Error("withTransferReader: this manager's remote authority issues no transfer reader");
    const identity = newIdentity();
    const creds = issue
      ? await issue(identity)
      : this.auth && await mintCreds(this.auth, identity, "transfer-reader", { transferReader: { instanceId: this.managerInstanceId } });
    const nc = await this.dial(creds
      ? { ...standaloneConnectOpts({ creds, /* not yet wired to a recorded transport */ tls: false }), maxReconnectAttempts: 0 }
      : { maxReconnectAttempts: 0 });
    try {
      return await fn(nc);
    } finally {
      await drainAndClose(nc);
    }
  }

  /** Purge the space's retained message backlog (chat, optionally DMs). Privileged — the manager mints a
   *  short-lived "purger" cred (same destructive grant as `cotal history clear`, isolated off the
   *  supervisor); regular agents are denied STREAM.PURGE under auth. Cleanup only: leaves live agents and
   *  the TASK queue alone. */
  private async opPurge(args: Record<string, unknown>, _caller: string): Promise<ControlReply> {
    if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    const includeDms = args.includeDms === true;
    try {
      const creds = this.auth ? await mintCreds(this.auth, newIdentity(), "purger") : undefined;
      const result = await clearSpaceHistory({
        servers: this.servers ?? DEFAULT_SERVER,
        space: this.space,
        creds,
        includeDms,
      });
      return { ok: true, data: result };
    } catch (e) {
      return { ok: false, error: rejectionText(e) };
    }
  }

  /** Persist a peer-defined persona as config. After this, `start name` auto-discovers
   *  .cotal/agents/<name>.md and the connector applies its persona/model at spawn.
   *
   *  CONTENT vs POLICY: `owner` has no slot, so a peer cannot claim ownership, and the
   *  capabilities the written persona carries, a saved list a redefine keeps included, are bounded
   *  against the definer before the write, so a peer can put only what it holds into a persona that
   *  a wider spawner might later launch. Channel grants, role, and agent are content: they may
   *  arrive as explicit arguments or as a leading frontmatter block inside `persona`. A prompt
   *  that starts with `---` is parsed and merged (explicit args win) so the written file has one
   *  frontmatter block; a malformed block is refused by name rather than wrapped. A fresh name is
   *  created with the owner {@link personaOwner} records. Redefining an EXISTING file is allowed on
   *  the privileged tier only if `file.owner == caller`, else admin is required. Fail-closed: an
   *  ownerless file (legacy / operator-written) is admin-only. */
  private async opDefinePersona(args: Record<string, unknown>, caller: string, admin: boolean, authenticated?: EpCaller): Promise<ControlReply> {
    if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, error: "name required" };
    const nameErr = this.nameError(name);
    if (nameErr) return { ok: false, error: nameErr };
    const persona = String(args.persona ?? "").trim();
    if (!persona) return { ok: false, error: "persona required" };
    const path = agentFilePath(this.workspaceRoot, name);
    const strList = (v: unknown): string[] | undefined => {
      if (v === undefined || v === null) return undefined;
      return (Array.isArray(v) ? v : [v]).map((x) => String(x));
    };
    const capabilities = strList(args.capabilities);
    let endpointArg: PersonaEndpoint[] | undefined;
    try {
      endpointArg = parsePersonaEndpoints(args.endpoints, "define-persona");
    } catch (e) {
      return { ok: false, error: rejectionText(e) };
    }
    // Read, authorize and compose against the catalog as it is now. Nothing yields between this and
    // the write, so no other call in this manager can change the file in between. The handler does
    // not serialize with other processes; their writes are outside this single-manager guarantee.
    const compose = (): { def: AgentDef } | { reply: ControlReply } => {
      let existing: AgentDef | undefined;
      if (existsSync(path)) {
        try {
          existing = loadAgentFile(path);
        } catch (e) {
          return { reply: { ok: false, error: rejectionText(e) } };
        }
        if (!admin && existing.owner !== caller) {
          const owner = existing.owner ? `owned by ${existing.owner}` : "operator-owned (legacy file - no agent owner)";
          return { reply: {
            ok: false, code: "permission-denied", outcome: "not-executed",
            error: `not authorized to redefine ${name}: ${owner}; only its owner or an operator can`,
            details: [{ kind: "ai.cotal.persona-ownership-refused", operatorOwned: existing.owner === undefined }],
          } };
        }
      }
      try {
        return {
          def: composeWirePersona(
            {
              name,
              owner: this.personaOwner(caller),
              prompt: persona,
              model: args.model as string | undefined,
              role: args.role as string | undefined,
              agent: args.agent as string | undefined,
              subscribe: strList(args.subscribe),
              allowSubscribe: strList(args.allowSubscribe),
              allowPublish: strList(args.allowPublish),
              capabilities,
              endpoints: copyPersonaEndpoints(endpointArg),
            },
            existing,
          ),
        };
      } catch (e) {
        return { reply: { ok: false, error: rejectionText(e) } };
      }
    };
    let composed = compose();
    if ("reply" in composed) return composed.reply;
    // The bound reads the persona as written, so a redefine that omits `capabilities` or `endpoints`
    // has the list it keeps checked too. Resolving the definer's grant yields, so the catalog is read
    // again after it.
    if (composed.def.capabilities?.length || composed.def.endpoints !== undefined) {
      const refusal = await this.definerGrantRefusal(caller, authenticated);
      composed = compose();
      if ("reply" in composed) return composed.reply;
      const kept = composed.def.capabilities ?? [];
      const keptEndpoints = lowerPersonaEndpoints(composed.def.endpoints);
      // A user-auth persona may not name the field at all; elsewhere `[]` hands on nothing to bound.
      const namesEndpoints = composed.def.endpoints !== undefined;
      const refused = kept.length || keptEndpoints.length || (namesEndpoints && this.meshMode === "user")
        ? refusal({ capabilities: kept, endpoints: keptEndpoints, namesEndpoints })
        : undefined;
      if (refused) {
        const fromSaved = [
          ...(capabilities === undefined && kept.length ? ["capabilities"] : []),
          ...(endpointArg === undefined && composed.def.endpoints?.length ? ["endpoints"] : []),
        ];
        return {
          ok: false,
          code: "permission-denied",
          error: fromSaved.length
            ? `${refused} ${fromSaved.map((f) => `\`${f}\``).join(" and ")} come${fromSaved.length === 1 ? "s" : ""} from the saved persona, which a redefine that omits ${fromSaved.length === 1 ? "it keeps" : "them keeps"}; pass what the definer holds, or [] to clear ${fromSaved.length === 1 ? "it" : "them"}.`
            : refused,
        };
      }
    }
    try {
      saveAgentFile(path, composed.def);
    } catch (e) {
      return { ok: false, error: rejectionText(e) };
    }
    return { ok: true, data: { name, path } };
  }

  /** Resolve what a persona's definer may put into it, as a check that returns the refusal for
   *  capabilities or endpoint commands it does not hold, or `undefined` when it holds them all. The
   *  check itself does not yield. An open mesh mints no credential, so nothing is bounded there. A
   *  static definer is bounded by its issued evidence, as a spawner is; a user-auth definer by its
   *  own ledger row's scope, under the ledger's token rule, with `admin` exempt. A user-auth persona
   *  cannot name `endpoints` at all, `[]` included (SPEC 13.15). A hosted manager reads no ledger, so
   *  it refuses. A later spawn of the persona is bounded again against its own spawner. */
  private async definerGrantRefusal(caller: string, authenticated: EpCaller | undefined): Promise<(grant: { capabilities: string[]; endpoints: EpCapability[]; namesEndpoints: boolean }) => string | undefined> {
    if (this.meshMode === "open") return () => undefined;
    if (this.meshMode === "static") {
      const run = await this.spawnRun(authenticated, undefined);
      const bound = await this.staticSpawnBound(authenticated, run !== undefined && "admission" in run ? run : undefined);
      return ({ capabilities, endpoints }) => this.spawnBoundRefusal(bound, { capabilities, ...(endpoints.length ? { endpoints } : {}) }, false, "define-persona");
    }
    if (this.remoteAuthority)
      return ({ capabilities, namesEndpoints }) => namesEndpoints
        ? userMeshEndpointsRefusal("define-persona")
        : capabilities.length ? "define-persona: this manager's user authority is hosted, so it cannot read the definer's grant and its persona can grant no capabilities." : undefined;
    const p = parsePrincipalKey(caller);
    const scope = p ? await resolveAuthProvider().actorScope({ dir: userAuthStateDir(this.workspaceRoot, this.space), owner: p.owner, actor: p.actor }) : undefined;
    return ({ capabilities, namesEndpoints }) => {
      if (namesEndpoints) return userMeshEndpointsRefusal("define-persona");
      if (scope?.includes("admin")) return undefined;
      const over = capabilities.filter((c) => !capabilityWithin(scope ?? [], c));
      if (!over.length) return undefined;
      return scope === undefined
        ? `define-persona: the definer ${caller} has no grant in this space, so its persona can grant nothing. This persona asks for capabilities ${over.join(", ")}.`
        : `define-persona: this persona grants more than the definer holds: capabilities ${over.join(", ")} beyond [${scope.join(", ") || "none"}]. Drop these from the persona, or have the operator widen the definer's grant.`;
    };
  }

  /** Remove one machine-local persona definition without touching any running lifecycle that was
   *  launched from it. Removal accepts the catalog's safe filename alphabet without applying the
   *  current spawn-name length or user-mode actor rules, so an obsolete invalid-name entry remains
   *  repairable. Ownership matches redefine: the recorded owner, or admin for an ownerless file. */
  private opRemovePersona(args: Record<string, unknown>, caller: string, admin: boolean): ControlReply {
    if (this.execution === "none") throw new EpEnvelopeError("unimplemented", this.executionRefusal());
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, code: "bad-request", error: "name required" };
    if (!/^[A-Za-z0-9_-]+$/.test(name))
      return { ok: false, code: "bad-request", error: `unsafe persona name ${JSON.stringify(name)} (allowed: letters, digits, _ -)` };
    const path = agentFilePath(this.workspaceRoot, name);
    if (!existsSync(path)) return { ok: false, code: "not-found", error: `no persona "${name}"` };
    let owner: string | undefined;
    try {
      owner = loadAgentFile(path).owner;
    } catch {
      // A catalog entry may be invalid for launch solely because an older release admitted a name
      // above today's identity limit. Read only its frontmatter owner without asking the launch
      // parser to accept the identity. This does not make the file spawnable or readable.
      try {
        const source = readFileSync(path, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
        const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(source);
        if (!match) throw new Error("missing frontmatter");
        const frontmatter: unknown = parseYaml(match[1]);
        if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) throw new Error("frontmatter is not a mapping");
        const fields = frontmatter as Record<string, unknown>;
        if (String(fields.name ?? "") !== name) throw new Error("frontmatter name differs from the catalog entry");
        if (fields.owner !== undefined && typeof fields.owner !== "string") throw new Error("owner is not a string");
        owner = fields.owner;
      } catch {
        return { ok: false, code: "not-found", error: `no persona "${name}"` };
      }
    }
    if (!admin && owner !== caller) {
      const heldBy = owner ? `owned by ${owner}` : "operator-owned (legacy file - no agent owner)";
      return { ok: false, code: "permission-denied", error: `not authorized to remove ${name}: ${heldBy}; only its owner or an operator can` };
    }
    try {
      rmSync(path);
    } catch (e) {
      if (!existsSync(path)) return { ok: false, code: "not-found", error: `no persona "${name}"` };
      return { ok: false, error: rejectionText(e) };
    }
    return { ok: true, data: { name } };
  }

  /** The owner a fresh wire-defined persona records. A user-auth caller's principal is stable, and
   *  so is one of this manager's own seats for its life. Any other static caller, such as the CLI's
   *  operator instrument minted for one call, would leave an owner no later call matches, so it
   *  records none and the file is operator-owned, as a local `persona create` writes it. A peer
   *  joined with its own credential is such a caller too. */
  private personaOwner(caller: string): string | undefined {
    if (this.userMode) return caller;
    for (const a of this.agents.values()) if (this.managedPrincipal(a) === caller) return caller;
    return undefined;
  }

  /** Whether this caller may READ a catalog card's details (role/model/description/body). Same
   *  ownership rule as redefine: owner == caller, or admin. Ownerless / operator-written files are
   *  admin-only. Names of parseable files still appear on the list so a definer can see a taken
   *  spawn name; details stay off the wire unless this is true. */
  private canReadPersona(owner: string | undefined, caller: string, admin: boolean): boolean {
    return personaCatalogReadable(owner, caller, admin);
  }

  /** Mesh-side catalog list (#402). Every parseable name is returned so a definer can see a taken
   *  spawn name. Role / model / description / owner ride only when the caller could redefine the
   *  file (same ownership as `definePersona`); other cards are name-only, so a peer cannot read a
   *  prompt it does not own. Unparseable files are omitted for non-admin (no existence leak of a
   *  broken card). */
  private opListPersonas(caller: string, admin: boolean): ControlReply {
    const personas = [];
    for (const e of listPersonaCatalog(this.workspaceRoot)) {
      if (e.error) {
        if (!admin) continue;
        personas.push({ name: e.name, error: "unparseable" });
        continue;
      }
      const def = e.def!;
      if (!this.canReadPersona(def.owner, caller, admin)) {
        personas.push({ name: e.name });
        continue;
      }
      const description = personaCatalogDescription(def);
      personas.push({
        name: e.name,
        ...(def.role ? { role: def.role } : {}),
        ...(def.model ? { model: def.model } : {}),
        ...(description ? { description } : {}),
        ...(def.owner ? { owner: def.owner } : {}),
      });
    }
    return { ok: true, data: { personas } };
  }

  /** Mesh-side catalog show (#402). Same ownership as list. Unknown, unauthorized, or unparseable
   *  names are not-found (no existence or parser-diagnostic leak). The body is included so a peer can
   *  inspect a prompt it owns before spawn; policy fields stay off the wire. */
  private opShowPersona(args: Record<string, unknown>, caller: string, admin: boolean): ControlReply {
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, error: "name required" };
    const nameErr = this.nameError(name);
    if (nameErr) return { ok: false, error: nameErr };
    const path = agentFilePath(this.workspaceRoot, name);
    if (!existsSync(path)) return { ok: false, error: `no persona "${name}"` };
    let def;
    try {
      def = loadAgentFile(path);
    } catch {
      return { ok: false, error: `no persona "${name}"` };
    }
    if (!this.canReadPersona(def.owner, caller, admin)) return { ok: false, error: `no persona "${name}"` };
    const description = personaCatalogDescription(def);
    return {
      ok: true,
      data: {
        name,
        ...(def.role ? { role: def.role } : {}),
        ...(def.model ? { model: def.model } : {}),
        ...(description ? { description } : {}),
        ...(def.owner ? { owner: def.owner } : {}),
        ...(def.persona ? { persona: def.persona } : {}),
      },
    };
  }

  /** The post-authorization `input` effect (C3): type `text` into the seat's terminal as if a human
   *  had. The single call an external UI needs to deliver a harness command (`/compact`, `/clear`,
   *  `/model`) without holding a terminal open on the caller's side.
   *
   *  Why the runtime HANDLE and not an attach session: a session is a stream (backlog, subscriber
   *  set, a lifetime the session plane accounts for and caps). Opening and discarding one per
   *  keystroke line would burn a session slot for a write, and would put a capacity refusal in the
   *  path of an operation that has no capacity cost. {@link AgentHandle.write} is the one-shot
   *  sibling of `interrupt()`, which already writes into the same pty.
   *
   *  Three refusals, each for a different reason and each with its own code, so a caller can tell
   *  "never going to work" from "not right now":
   *   - the name was refilled while authorization awaited: act on the incarnation the caller was
   *     authorized for or on nothing at all (the same guard {@link attachAuthorized} carries, for
   *     the same reason: a name is a reusable slot and `authorizeNamed` can await a ledger read);
   *   - the agent is not running: there is no terminal to type into;
   *   - the runtime cannot write (tmux/cmux/orca/herdr attach to an externally-owned process, so
   *     they own no input stream for it): `unimplemented`, named by runtime kind. NOT a fallback
   *     to an attach session and NOT a silent success - a dropped keystroke would leave the caller
   *     believing a command was delivered that never was.
   *
   *  `enter` defaults to true: a harness command typed but not submitted has not been delivered.
   *  Nothing is echoed back; the caller reads the resulting turns from the event plane. */
  private async inputAuthorized(a: ManagedAgent, args: Record<string, unknown>): Promise<{ name: string; bytes: number }> {
    // These three refuse before the first write, so nothing was typed (SPEC 13.3). A write the
    // runtime rejects below states no outcome: the runtime contract does not say a rejected write
    // delivered nothing, and an earlier slice may already have reached the seat.
    if (this.agents.get(a.name) !== a)
      throw new EpEnvelopeError("failed-precondition", `agent "${a.name}" was replaced during authorization - retry`, undefined, "not-executed");
    if (a.handle.status() !== "running")
      throw new EpEnvelopeError("failed-precondition", `agent "${a.name}" is not running (${a.handle.status()}); nothing to type into`, undefined, "not-executed");
    const write = a.handle.write?.bind(a.handle);
    if (!write)
      throw new EpEnvelopeError("unimplemented", `input is not supported by runtime ${a.handle.kind}`, undefined, "not-executed");
    if (a.agent === "claude") {
      // AskUserQuestion ignores bracketed text at its choice menu, but the following Enter
      // confirms the highlighted option. Refuse rather than answer a different question choice.
      const handle = a.handle;
      let selection = false;
      try {
        const session = handle.attach();
        const backlog = await session.backlog();
        const term = new Headless.Terminal({ cols: session.cols, rows: session.rows, allowProposedApi: true });
        try {
          await new Promise<void>((done) => term.write(backlog, done));
          const screen = term.buffer.active;
          const lines = Array.from({ length: term.rows }, (_, y) =>
            screen.getLine(screen.baseY + y)?.translateToString(true).trim() ?? "");
          selection = lines.some((line) => /^❯\s+\d+\./u.test(line))
            && lines.some((line) => line.includes("Enter to select") && line.includes("↑/↓ to navigate") && line.includes("Esc to cancel"));
        } finally {
          term.dispose();
        }
      } catch {
        throw new EpEnvelopeError("failed-precondition", `cannot inspect Claude input for seat "${a.name}"; use \`cotal attach --name ${a.name}\` to inspect and type directly`, undefined, "not-executed");
      }
      if (selection)
        throw new EpEnvelopeError("failed-precondition", `Claude is showing a selection menu for seat "${a.name}"; input text cannot safely select an option. Use \`cotal attach --name ${a.name}\`, then arrow keys and Enter; nothing was typed`, undefined, "not-executed");
      // Snapshot parsing awaits I/O. Keep this write bound to the authorized incarnation and handle.
      if (this.agents.get(a.name) !== a || a.handle !== handle || handle.status() !== "running")
        throw new EpEnvelopeError("failed-precondition", `agent "${a.name}" changed while inspecting its terminal; nothing was typed`, undefined, "not-executed");
    }
    // The contract validated `text` (non-empty, <= 64KiB) and `enter` (boolean) before this ran, so
    // the only decision left is the carriage return. `!== false` and not `?? true`: an ABSENT enter
    // and an explicit `true` must behave identically, and only `false` may suppress the return.
    //
    // THE TEXT IS DELIVERED AS A BRACKETED PASTE AND THE RETURN FOLLOWS IT AS ITS OWN WRITE, and
    // that is the whole of issue #1649. A TUI harness reads keystrokes, so a return fused onto the
    // tail of the text (`${text}\r`) is the text's last character rather than the submit key: the
    // line waits in the composer and the NEXT call's return submits the PREVIOUS call's text, so
    // every delivery runs one call behind while the op still reports the full byte count.
    //
    // Separating the return is necessary and NOT sufficient, which is the part that cost a second
    // round of measurement. A TUI classifies a fast burst of input as a PASTE and eats the newline
    // that trails it (Jcode spells this `paste_guard::consume_paste_trailing_enter`), so a text big
    // enough to need more than one write is still one call behind even when the return is written
    // alone. Measured on a real seat, delivering in 2048-char slices with a yield before the return:
    // 120 and 700 bytes submitted on their own call, 2500 and 3100 bytes did not - each appeared
    // only when the NEXT call's return arrived. That is the reported symptom exactly.
    //
    // Bracketed paste states the boundary instead of guessing at it. `ESC[200~ text ESC[201~`
    // delimits the pasted block, so the return after it is unambiguously a keystroke and the guard
    // has no trailing newline to consume. This is a CLASSIFIER, not a race, so a sleep would be the
    // wrong instrument: measured on a real seat, a 250ms pause before the return still lost the
    // submission while 1000ms carried it, and any margin chosen from those numbers is a guess a
    // loaded host breaks. Bracketed delivery submitted 120, 2600 and 5912 bytes (the issue's own
    // size) each on its own call. The terminal advertises support by enabling DECSET 2004, which
    // Jcode's TUI does.
    //
    // The bytes the SEAT receives as text are unchanged, and the receipt still counts the text plus
    // the return: the paste markers are framing this op adds, never content the caller asked to
    // deliver, so counting them would make `bytes` disagree with what the caller sent.
    const text = String(args.text);
    const submit = args.enter !== false;
    const intendedBytes = Buffer.byteLength(text, "utf8") + (submit ? 1 : 0);
    const parts: Array<{ data: string; counted: boolean }> = [{ data: PASTE_START, counted: false }];
    for (let i = 0; i < text.length; i += INPUT_SLICE_CHARS)
      parts.push({ data: text.slice(i, i + INPUT_SLICE_CHARS), counted: true });
    parts.push({ data: PASTE_END, counted: false });
    // `enter:false` still presses nothing: the text is delivered into the composer and left there.
    if (submit) parts.push({ data: "\r", counted: true });
    let bytes = 0;
    for (const [i, part] of parts.entries()) {
      // Yield BEFORE each write but the first, so the child drains the previous slice rather than
      // the pty buffer merging them. `setImmediate` runs after I/O, which a microtask would not.
      if (i > 0) await new Promise<void>((resolve) => setImmediate(resolve));
      let accepted: number;
      try {
        accepted = await write(part.data);
      } catch (error) {
        throw new EpEnvelopeError("unavailable", `input for seat "${a.name}" failed: ${rejectionText(error)}`);
      }
      if (!Number.isSafeInteger(accepted)) {
        throw new EpEnvelopeError("unavailable", `input for seat "${a.name}" failed: runtime accepted ${String(accepted)} of ${intendedBytes} bytes`);
      }
      // A short write on ANY part is a failed delivery, including a marker: a paste block that was
      // opened but not closed would leave the seat's composer in paste mode.
      if (accepted !== Buffer.byteLength(part.data, "utf8"))
        throw new EpEnvelopeError("unavailable", `input for seat "${a.name}" failed: runtime accepted ${accepted} of ${Buffer.byteLength(part.data, "utf8")} bytes of one write`);
      if (part.counted) bytes += accepted;
    }
    if (bytes !== intendedBytes)
      throw new EpEnvelopeError("unavailable", `input for seat "${a.name}" failed: runtime accepted ${String(bytes)} of ${intendedBytes} bytes`);
    return { name: a.name, bytes };
  }

  /** The post-authorization attach effect: mint the holder-bound §13.6 offer, redeem it
   *  through the ONE session plane (one-use CAS + presenter-equality), and stand up the PTY bridge —
   *  atomically. The reply is the SIGNED grant (no ws:// URL, non-bearer, never logged); the caller
   *  redeems it over the mesh with a per-session rails-only cred it mints itself. Only streamable
   *  backends (pty/host) attach; an external runtime's attach() throws with per-runtime guidance. */
  private async attachAuthorized(a: ManagedAgent, caller: { owner: string; actor: string; uid: string }): Promise<ControlReply> {
    // Every refusal before establishAttach below has opened no session, so it states that (SPEC 13.3).
    if (!this.sessionPlane) throw new EpEnvelopeError("failed-precondition", "the manager session plane is not available (the manager is not fully started)", undefined, "not-executed");
    // A name is a reusable slot and the authorization above can await (user mode reads the ledger).
    // The ep target is incarnation-pinned, so `a` cannot BE a successor — but the slot it names can
    // have been stopped and refilled while we waited, and everything below must act on the
    // incarnation this caller was actually authorized for, never on whoever holds the name now.
    if (this.agents.get(a.name) !== a)
      throw new EpEnvelopeError("failed-precondition", `agent "${a.name}" was replaced during authorization - retry`, undefined, "not-executed");
    // Never establish a session over a dead agent — a doomed session (the caller would get an
    // immediate process-exit at best, a confusing empty terminal at worst). Refuse honestly.
    if (a.handle.status() !== "running") throw new EpEnvelopeError("failed-precondition", `agent "${a.name}" is not running (${a.handle.status()}); nothing to attach`, undefined, "not-executed");
    // CLAIM the session slot BEFORE attaching the target's PTY, matching the console door: this door
    // used to attach first and check capacity inside establishAttach, so a `resource-exhausted`
    // refusal landed AFTER the attach. The claim is carried INTO establishAttach, so one reservation
    // spans the attach and the establishment, and it is released on every refusal below.
    //
    // RESIDUAL, NAMED: no shipped runtime acquires anything at attach time — pty's `attach()` returns
    // a pure view (it registers a data subscriber only when `onData` is called) and tmux/cmux/orca
    // throw — so an attach nobody bridges is a garbage-collectible object, not a held resource, and
    // ordering alone suffices. A future runtime that DOES acquire something in `attach()` reopens
    // this: it would need a release on the failure paths, and `AttachSession` has no close today.
    const slot = this.sessionPlane.claimSlot();
    let session;
    try {
      session = a.handle.attach();
    } catch (e) {
      slot.release();
      // The external runtimes refuse attach() before acquiring anything (see the residual above).
      //
      // A runtime that streams NO terminal is `unimplemented` and not a precondition: asking again
      // cannot change it, and a caller that reads this as transient retries a refusal forever. The
      // runtime's own throw is the guidance for watching the agent where it really runs, so it is
      // carried through verbatim, and the namespaced detail lets a caller act on the one fact
      // without reading the wording. This is the same answer `input` gives a runtime that cannot
      // write, for the same reason.
      if (!this.runtimeFor(a.handle.kind).streamsTerminal)
        throw new EpEnvelopeError("unimplemented", `the ${a.handle.kind} runtime streams no terminal, so agent "${a.name}" has none to attach: ${rejectionText(e)}`,
          [{ kind: RUNTIME_NO_TERMINAL_DETAIL, runtime: a.handle.kind }], "not-executed");
      throw new EpEnvelopeError("failed-precondition", rejectionText(e), undefined, "not-executed");
    }
    // establishAttach releases the claim it was handed on every exit; nothing to unwind here.
    const { grant } = await this.sessionPlane.establishAttach(caller, { name: a.name, lifecycleUid: a.lifecycleUid }, session, slot);
    const carried = a.launch.resumed?.host;
    return { ok: true, data: { grant, ...(carried ? { resumedFrom: { host: carried, source: a.launch.resumed!.source } } : {}) } };
  }

  /** The console's mesh §13.6 session establisher (backing `POST /session/<name>` on the
   *  loopback face). Drives THE ONE plane — same establishAttach as the ep `attach` command — with
   *  the loopback OPERATOR as holder (same-host trust boundary), then hands the browser everything it
   *  needs to open the caller rail over the broker ws listener: the holder-bound grant, a per-session
   *  RAILS-ONLY caller cred (static mints from the seed, TTL-bound to the session; an open mesh has no
   *  credential system so the browser connects bare), and the ws URL. NO 127.0.0.1 terminal transport
   *  — the terminal rides the mesh session. Injected only when a wsPort exists (see the constructor). */
  private async establishConsoleSession(name: string): Promise<SessionEstablishment> {
    if (!this.sessionPlane) throw new Error("the manager session plane is not available (the manager is not fully started)");
    if (this.wsPort === undefined) throw new Error("the broker websocket port is not configured; the console cannot open a mesh session");
    // CLAIM the session slot here, before the PTY attach and before this establisher goes on to
    // mint a seed-signed `session-caller` credential: a capacity refusal must land before anything
    // with a side effect or a cost. The claim is carried INTO establishAttach, so the reservation
    // spans the whole establishment rather than being a check that a concurrent caller can race.
    // (See attachAuthorized for why the attach itself needs no unwind on any shipped runtime.)
    const slot = this.sessionPlane.claimSlot();
    try {
      const a = this.agents.get(name);
      if (!a) throw new Error(`no managed agent "${name}"`);
      if (a.handle.status() !== "running") throw new Error(`agent "${name}" is not running (${a.handle.status()}); nothing to attach`);
      const session = a.handle.attach(); // throws for non-streamable runtimes — surfaced to the browser as a 500
      // The loopback operator is the console's holder (same-host trust boundary).
      const caller = { owner: DEV_OWNER, actor: "console", uid: this.managerLifecycleUid };
      const { grant } = await this.sessionPlane.establishAttach(caller, { name: a.name, lifecycleUid: a.lifecycleUid }, session, slot);
      // The caller credential is minted ONLY after a session is really live, so a refused or failed
      // establishment never yields a seed-signed JWT. (A failure HERE would leave a live session the
      // browser never reaches, holding its slot until the grant expires — unreachable in practice,
      // because the SERVING mint above signs from this same `this.auth` first and would have failed
      // before any session existed.)
      const creds = this.auth
        ? await mintCreds(this.auth, newIdentity(), "session-caller", {
            sessionCaller: { endpoint: MANAGER_ENDPOINT, sessionId: grant.sessionId, epoch: grant.serving.epoch },
            expiresAt: Math.floor(grant.exp / 1000), // grant.exp is ms (now+ttlMs); the JWT exp is seconds
          })
        : "";
      return { grant, wsUrl: `ws://127.0.0.1:${this.wsPort}`, creds };
    } catch (e) {
      slot.release(); // idempotent with establishAttach's own release
      throw e;
    }
  }

  /** Managed agents cross-referenced with live presence (the manager sees the roster).
   *
   *  `ownerFilter`: restrict to agents whose spawn-time stored `userOwner` equals it (the ps/status
   *  owner-domain bound); undefined = unbounded. {@link NO_OWNER_MATCHES} matches nothing. */
  private list(ownerFilter?: string) {
    const roster = new Map(this.ep.getRoster().map((p) => [p.card.name, p]));
    const observedAt = Date.now();
    // The roster is only evidence while THIS observer's presence watch is fresh. A stale view
    // (whole-bucket silence past TTL) or an unpopulated one (snapshot not yet replayed) cannot
    // support "offline" or "absent" for anyone: a live deployment on 2026-09-09 rendered every live seat as
    // one of those for hours after the presence stream was recreated under a still-open watch.
    // Carry the view state on the row so the renderer can say "unknown" instead of a verdict.
    // An endpoint that reports no view (test doubles built on `getRoster` alone) is read as
    // `current`: that is exactly what every row meant before the field existed.
    const view = typeof this.ep.presenceView === "function" ? this.ep.presenceView() : { state: "current" as const };
    return [...this.agents.values()].filter((a) => ownerFilter === undefined || a.userOwner === ownerFilter).map((a) => {
      // USER MODE: a detached agent's bearer-refresh death is silent everywhere except here — its
      // bearer command writes each attempt's outcome to the health file, and `ps` renders it
      // FAIL-CLOSED: a failed record is the failure + repair sentence; a missing/malformed or
      // stale record on a live agent is auth-unknown/auth-stale, NEVER silently healthy.
      const health = a.userOwner
        ? agentAuthState(a.secretPaths?.health ?? agentLifecycleSecretFilePaths(this.workspaceRoot, this.space, a.name, a.lifecycleUid).health)
        : undefined;
      // The connector-reported provider from presence (#785): the live roster card's `meta.provider`,
      // when it is a non-empty string. Absent when the connector reported none — never fabricated.
      const seen = roster.get(a.name);
      const presenceIdentityVerified = this.isOwnPresence(a, seen);
      const providerMeta = seen?.card.meta?.provider;
      const provider = typeof providerMeta === "string" && providerMeta ? providerMeta : undefined;
      // The harness-reported condition beside the mesh status (#618): a turn that died upstream reads
      // `waiting` with `rate_limit` here, not a bare `waiting`. Absent when the connector reported none.
      // Projected field by field like `provider`: a malformed peer row must not fail this reply's schema.
      const reported = roster.get(a.name)?.condition;
      const condition =
        reported && typeof reported.code === "string" && reported.code
          ? {
              code: reported.code,
              ...(typeof reported.source === "string" ? { source: reported.source } : {}),
              ...(typeof reported.message === "string" ? { message: reported.message } : {}),
              ...(typeof reported.since === "number" && Number.isFinite(reported.since) ? { since: reported.since } : {}),
            }
          : undefined;
      // The seat's last harness-reported work progress (#618). `ts` is only its heartbeat, so a turn
      // that stopped advancing reads as an old `activeAt` beside a live process. Absent when none was reported.
      const activeAtReported = roster.get(a.name)?.activeAt;
      const activeAt = typeof activeAtReported === "number" && Number.isFinite(activeAtReported) ? activeAtReported : undefined;
      // How long an offline verdict has stood (#1208): the seat's last heartbeat before it went
      // offline. Only beside a verdict, since a stale or unpopulated view dates nothing, only from the
      // seat's own record, since `seen` is matched by name and a same-named foreign peer or an older
      // incarnation must not date this seat, and only when the seat's unvalidated `ts` fits the row
      // schema, so one odd record cannot fail the reply.
      const offlineSince = view.state === "current" && this.isOwnPresence(a, seen) && seen.status === "offline" && Number.isSafeInteger(seen.ts) && seen.ts >= 0
        ? seen.ts
        : undefined;
      return {
        name: a.name,
        // The spawned agent's id (nkey, or the user-mode principal) — lets an operator tool (e.g.
        // `cotal down -f`) match a ledger entry by name AND id before stopping, so it never stops a
        // same-named foreign agent.
        id: a.id,
        role: a.role,
        agent: a.agent,
        space: this.space,
        mode: a.handle.kind,
        status: a.handle.status(),
        uptimeMs: Date.now() - a.startedAt,
        mesh: seen?.status ?? "absent",
        ...(a.joinIssue ? { joinHealth: { state: "degraded" as const, reason: a.joinIssue } } : {}),
        ...(condition ? { condition } : {}),
        ...(a.startupNotice !== undefined ? { startupNotice: a.startupNotice } : {}),
        ...(activeAt !== undefined ? { activeAt } : {}),
        // `current` is the only state in which `mesh` is a verdict; the other two are the
        // observer's own condition and travel on the row (older CLIs ignore the field).
        meshView: view.state,
        presenceIdentityVerified,
        ...(view.state === "current" && presenceIdentityVerified ? { presenceObservedAt: observedAt } : {}),
        ...(offlineSince !== undefined ? { offlineSince } : {}),
        // The incarnation coordinate (SPEC 13.1) — with `id`, exactly what a v0.4 caller needs to
        // build a targeted (`despawn`/`attach`) request against THIS incarnation.
        lifecycleUid: a.lifecycleUid,
        // #651 enrichment: per-seat facts the manager ALREADY holds, carried on the row so `ps
        // --wide`/`--json` can surface them without a new collection path. All optional in the row
        // schema: a fact this backend did not record serializes absent, never fabricated (the
        // pid is absent on runtimes that do not own a real process; a launch may pin no model).
        model: a.launch.model,
        variant: a.launch.variant,
        ...(provider ? { provider } : {}),
        cwd: a.launch.cwd,
        pid: a.handle.pid,
        spawner: a.spawner,
        instanceId: this.managerInstanceId,
        host: hostname(),
        // #1500: the session a `--resume` seat forked, with its title and transcript hash once the
        // seat has recorded them.
        ...(a.launch.forkSource ? { resume: this.forkProvenance(a) ?? { source: a.launch.forkSource } } : {}),
        ...(health && health.state !== "ok" ? { authHealth: health.state, authReason: health.reason } : {}),
      };
    });
  }
}
