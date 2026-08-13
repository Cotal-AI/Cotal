import { execFile } from "node:child_process";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import {
  CotalEndpoint,
  DEFAULT_SERVER,
  DEV_OWNER,
  MANAGER_LEASE_TTL_MS,
  STANDING_RENEWABLE_TTL_SEC,
  agentFilePath,
  clearSpaceHistory,
  connectorServers,
  deprovisionAgent,
  firstFreeName,
  idFromCreds,
  inspectCredHealth,
  loadAgentFile,
  loadCotalConfig,
  mintCreds,
  mintLifecycleUid,
  mkSecretDir,
  newIdentity,
  actionContext,
  parsePrincipalKey,
  parseShareSelection,
  principalKey,
  probeConnect,
  provisionAgent,
  provisionAgentDurables,
  registry,
  resolveAuthProvider,
  saveAgentFile,
  subjectMatches,
  CONTROL_AUTH_ADMIN,
  controlServiceSubject,
} from "@cotal-ai/core";
import { agentAuthState, agentCredsDir, agentLifecycleSecretFilePaths, agentSecretFilePaths, agentSecretKeyForFile, authDir, connectorInstallHint, DEFAULT_CONNECTOR, defaultAgentType, DELIVERY_CREDS_KEY, findCotalRoot, getSpaceAuth, hasUserAuthState, loadManagerInstanceIdentity, loadMeshes, manifestExtensionNames, materializeFromManifest, materializeSecretToFile, MEMBERSHIP_RW_CREDS_KEY, mergeLaunchOptions, remintDaemonCreds, resolveOnPath, saveManagerInstanceIdentity, SYSTEM_CREDS_FILES, userAuthStateDir, workspaceSecretStore, writeRenewalRecord, type RenewalRecord } from "@cotal-ai/workspace";
import type { ActionContext, AgentDef, AttachSession, Connector, ConnectorModelCatalog, ControlReply, CredHealth, LaunchSpec, ManagerLeaseInfo, MeshLaunchAgent, Presence, SecretStore, SpaceAuth } from "@cotal-ai/core";
import {
  createRuntime,
  type AgentHandle,
  type Runtime,
  type RuntimeMode,
} from "./runtime/index.js";
import { AttachEndpoint, type SessionEstablishment } from "./attach-endpoint.js";
import { makeManagerEndpointEvictor } from "./endpoint-evict.js";
import { launchSpecForRun, materializePersona, launchAgentToStartOpts, parseLaunchSpec, persistLaunchSpec } from "./launch.js";
import { authorizeLaunch, authorizeNamedControl } from "./authorize.js";
import { controlShutdown } from "./control-shutdown.js";
import { parseResumeCommitArgs, parseResumeControlArgs, parseResumeFinalizeArgs } from "./resume.js";
// Unit B (the static §13.1 lifecycle executor): the shared grammar/stores from core plus the
// manager-side adapter (transport + slot orchestration + the F1 terminal) — see static-lifecycle.ts.
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import {
  recordsBucket,
  epAuthBucket,
  ensureAuthorityStores,
  ensureContractStore,
  createEndpointStreams,
  contractStoreContext,
  publishContractArtifact,
  contractArtifactCanonicalBytes,
  standaloneConnectOpts,
  STATIC_SLOT_PREFIX,
  rawDigest,
  STANDING_RENEWABLE_TTL_SEC as MANAGED_STATIC_TTL_SEC,
  newArtifactSigner,
  sessionsBucket,
  SESSION_GRANT_MAX_TTL_MS,
  type LifecycleStateTransport,
  type StaticManagedSlotRow,
  type SignerAnchor,
} from "@cotal-ai/core";
// P2 item 6: the manager's ONE §13.6 session plane — offer mint + one-use redeem + PTY-bridge
// standup for `attach`, over a dedicated standing session-LEDGER connection (the byte rails ride
// per-session credentials on their own short-lived connections).
import { ManagerSessionPlane, openSessionLedgerKv, type SessionServing } from "./session/index.js";
// P2 item 1 (1a-serve): the manager as an ordinary v0.4 `service` endpoint — the §13.1
// endpoint-serve credential subsystem (gate provisioning, registration barrier, mint fence) plus
// the register/authorize/serve seams, all driven over a scoped one-shot executor connection.
import {
  provisionEndpointGateOpen,
  endpointRegistrationBarrier,
  serveIssuanceGateKv,
  commitSiblingIssuance,
  markLedgerRowRevoked,
  epcredRowKey,
  epgateKey,
  registerServiceInstance,
  authorizeServeGrant,
  writeServiceStatus,
  SERVICE_READY,
  serveEndpoint,
  type EpIssuanceGate,
  bindGoal,
  createGoal,
  transitionGoal,
  commitGoalResult,
  settleGoalUncertain,
  readGoalResult,
  readGoalStatus,
  readGoalSpec,
  recordGoalIndex,
  readGoalIndex,
  clearGoalIndex,
  listGoalIndex,
  type GoalIndexEntry,
  GOAL_TERMINAL_STATES,
  goalRefOf,
  goalProgressTopic,
  epeSubject,
  submissionFingerprint,
  EpEnvelopeError,
  type EpCommandDef,
  type EpServeContext,
  type EpServeGrant,
  type EpServeHandle,
  type GoalRef,
  type Identity,
  type ServiceNameAuthority,
} from "@cotal-ai/core";
import { MANAGER_ENDPOINT, managerClusterArtifacts, managerCommandDefs, managerContractArtifactValues, type ManagerStatus } from "./manager-service-contract.js";
import type { NatsConnection } from "@nats-io/transport-node";
import type { KV } from "@nats-io/kv";
import {
  staticLifecycleTransport,
  activateStaticLifecycle,
  runStaticTerminal,
  readStaticSlot,
  casStaticSlot,
  recordSlotCredential,
  appendStaticCredentialRow,
  planStaticSlotResume,
} from "./static-lifecycle.js";

/** Concurrency ceiling — the manager refuses to hold more than this many live + in-flight +
 *  cooling slots at once (P4a). Bounds a fork-bomb: spawn is a full agent process per call. */
const MAX_AGENTS = 50;
/** Minimum slot lifetime for rate-flooring (P4c). A slot freed (by despawn OR natural exit/reap)
 *  before living this long leaves a cooling stamp that still counts toward the ceiling until it
 *  expires — so churn (spawn↔despawn or spawn↔fast-exit) can't outrun the concurrency bound. */
const MIN_LIFETIME = 10_000;
/** Backstop for the detached-launch readiness race (#159 B1). `startAgent` waits on two REAL outcomes —
 *  the assigned id joining the mesh (presence) = started, the child process exiting = failed — NOT a
 *  liveness-inferring timer. This is only the last-resort bound for "neither happened in time": the launch
 *  is then reported UNCERTAIN (a non-success reply that does NOT deprovision — it may still be booting, or
 *  stuck before connector startup). Generous, since a real cold agent join can take several seconds. Held
 *  as an instance field ({@link Manager.readinessTimeoutMs}) so a test can shorten it. Exported so the
 *  launch-parity smoke can assert every launch client's request timeout OUTLIVES this window — the tier
 *  rule forbids the clients importing it directly. */
export const READINESS_TIMEOUT_MS = 30_000;
/** Upper bound on a detached agent-exit deprovision (#159 B2). A wedged broker must not leave the
 *  fire-and-forget teardown pending forever with no log — past this it rejects into freeSlot's fail-loud
 *  `.catch`. Generous over the helper's 5s connect timeout to allow the two consumer-deletes + ACL purge
 *  + drain on a healthy-but-slow broker. */
const DEPROVISION_TIMEOUT_MS = 15_000;
/** The delivery-admin `reloadCreds` request bound — STRICTLY GREATER than the daemon's internal
 * per-component preflight bound (4s each, run in parallel) so a slow or refused proof returns the
 * daemon's STRUCTURED per-component failure, never a client-side timeout that the catch below would
 * misrecord as "no delivery-admin responder" (a false negative while the daemon is mid-proof). */
const DELIVERY_ADMIN_RELOAD_TIMEOUT_MS = 15_000;
/** A hard preservation stop should settle quickly. The manager still waits and reports a partial
 * cut rather than pretending a child is gone. Held in ManagerOptions so fake runtimes can shorten it. */
const PRESERVE_STOP_TIMEOUT_MS = 10_000;

/** The STABLE retirement opId for one lifecycle (#29 piece 3): deterministic from the uid, so a
 *  despawn retry, a same-name-spawn nudge, and the auth service's boot resume all drive the SAME
 *  operation (the rail's idempotence table needs exactly one op per retiring incarnation). 26 hex
 *  chars = in the lifecycle-token grammar `[a-z0-9]{26,32}`, collision-resistant. */
function retireOpId(lifecycleUid: string): string {
  return createHash("sha256").update(`retire:${lifecycleUid}`).digest("hex").slice(0, 26);
}

/** Sentinel owner-filter value that matches NO agent's `userOwner` (owner tokens never contain a
 *  dash) — what {@link Manager.psOwnerFilter} returns for an unparseable caller so a malformed
 *  principal fail-closes to an empty `ps` instead of an unbounded one. */
const NO_OWNER_MATCHES = "-no-owner-";

/** Run the agent's bearer argv once, pre-launch — the end-to-end auth preflight (state dir, daemon,
 *  ledger row, secret). Its stderr is the provider command's operator-exact sentence; surface it
 *  verbatim as the spawn refusal. */
function execBearerPreflight(argv: string[]): Promise<void> {
  return new Promise((res, rej) => {
    execFile(argv[0], argv.slice(1), { timeout: 30_000, maxBuffer: 64 * 1024 }, (err, _stdout, stderr) => {
      if (err) return rej(new Error(stderr.trim() || err.message));
      res();
    });
  });
}

/** Reject `p` with `Error(msg)` if it hasn't settled within `ms`; clears the timer when `p` settles so it
 *  never keeps the loop alive. Used to bound the detached deprovision so its fail-loud log is guaranteed. */
function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

function sameStrings(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort());
}

export interface ManagerOptions {
  space: string;
  servers?: string;
  name?: string;
  /** Spawn backend. `auto` (default) → pty; external runtimes are explicit-only. */
  runtime?: RuntimeMode;
  workspaceRoot?: string;
  /** Port for the console + attach HTTP/WS endpoint. 0 → ephemeral. */
  consolePort?: number;
  /** P2 item 6: the broker's WebSocket listener port (loopback), allocated by `cotal up`. When set,
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
  /** Restore attempt this fresh manager will accept for the admin resumePreserved control op. */
  resumeAttemptId?: string;
  /** Fsynced coordinator evidence recovered after commit but before finalize. */
  resumeDurableCommitToken?: string;
  /** Resolve connectors from the installed `cotal ext` manifest (lazy import + live-remove honored),
   *  as the published binary does. A library composition leaves this off and resolves only what its
   *  composition root imported — a direct `new Manager()` never implicitly reads the machine manifest. */
  installedExtensions?: boolean;
  /** The {@link SecretStore} for EVERY secret this manager touches — the daemon-cred renewal write side
   *  (`remintDaemonCreds`) AND the per-agent standing-secret kinds (static creds / actor tokens /
   *  sentinel creds). ONE store, so a hosted composition (KMS/Vault) can never end up with the manager
   *  re-signing daemon creds into one store while it reads/writes agent creds through another (split
   *  authority). Defaults to the workstation FS store over `workspaceRoot`, so a local `cotal up` is
   *  unchanged. It must be the SAME store the delivery daemon reads (`runDelivery(args, store)`), or a
   *  hosted remint writes one store while the daemon reads another and rides to expiry. */
  secretStore?: SecretStore;
  /** P2 item 6: the global ceiling on concurrently live §13.6 sessions this manager will serve.
   *  Defaults to {@link MAX_LIVE_SESSIONS_DEFAULT}. Each session mints a credential and opens its
   *  own connection, and establishment is caller-triggered, so this is the process-level resource
   *  bound; exceeding it refuses `resource-exhausted` before either happens. Operator-set because
   *  the right number is deployment-shaped — the browser console holds one session per open pane.
   *  {@link ManagerSessionPlaneDeps.maxSessions} carries the per-caller-scoping residual. */
  maxSessions?: number;
}

export type ManagerMaintenanceState = "active" | "preserving" | "preserved";

export type ManagerResumeIdentity =
  // lifecycleUid is the agent's ORIGINAL incarnation uid (its durables are keyed by it): the resume
  // must recover it, not mint a fresh one, or a later teardown would orphan the real durables. It is
  // recorded here (from the live ManagedAgent) so recovery is uniform across all three modes.
  | { mode: "open"; id: string; lifecycleUid: string }
  | { mode: "static"; id: string; lifecycleUid: string; credential: { kind: "file"; path: string; sha256: string } }
  | {
      mode: "user";
      owner: string;
      actor: string;
      lifecycleUid: string;
      actorToken: { kind: "file"; path: string; sha256: string };
      sentinelCredential: { kind: "file"; path: string; sha256: string };
      health: { kind: "file"; path: string };
    };

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
      | { kind: "manifest"; runId?: string; requested: string; hash: string; configPath: string; configSha256: string; manifestSha256?: string };
    model?: string;
    variant?: string;
    subscribe?: string[];
    allowSubscribe: string[];
    allowPublish?: string[];
    capabilities?: string[];
    events: boolean;
    shareTools?: string;
    /** Original connector fork source, not a captured id for the currently running host session. */
    forkSource?: string;
    /** Values are deliberately not persisted: connector launch options are opaque and may be secrets. */
    unresolvedLaunchOptionKeys?: string[];
  };
  /** Host-local files that must survive the maintenance cut, including `.cotal/run` artifacts. */
  dependencies: string[];
  spawner: string;
  /** User-auth ledger delegation parent; distinct from manager process-ownership spawner. */
  authorityParent?: string;
  startedAt: string;
}

export interface ManagerResumeInventory {
  version: "cotal-manager-resume/v1";
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
   *  own `name:` (auto-numbered on collision). The file must exist (no silent default-ACL fallback). */
  name: string;
  /** Connector / agent type — resolved from the registry. Defaults to `COTAL_DEFAULT_AGENT`, else `"cotal"`. */
  agent?: string;
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
  /** Publish the session's structured events to `events.<name>`. Defaults to off; `true` (the
   *  `--events` flag) opts in. */
  events?: boolean;
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
  /** `--share-tools` selection narrowing which of the operator's configured MCP servers this
   *  agent gets (absent → all declared for the connector — the pre-merge manager behavior). */
  shareTools?: string;
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
}

interface ManagedLaunch {
  source: ManagerResumeAgent["launch"]["source"];
  cwd: string;
  model?: string;
  variant?: string;
  subscribe?: string[];
  allowSubscribe: string[];
  allowPublish?: string[];
  capabilities?: string[];
  events: boolean;
  shareTools?: string;
  forkSource?: string;
  unresolvedLaunchOptionKeys?: string[];
}

interface PreparedResume {
  spec: LaunchSpec;
  id?: string;
  creds?: string;
  userAuth?: { owner: string; actor: string; sentinelCredsPath: string; bearerCmd: string[] };
}

interface ManagedAgent {
  name: string;
  role?: string;
  agent: string;
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
  /** Set for a USER-MODE agent: its derived owner. Marks the slot for user-mode teardown (ledger
   *  revoke + token/sentinel/health file removal) and the auth-health read in {@link list}. */
  userOwner?: string;
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
  control?: { path: string; token: string };
  launch: ManagedLaunch;
  /** Preservation and a not-yet-confirmed resume retain broker/auth state if the process exits. */
  suppressCleanup?: boolean;
  /** The F5 TERMINALIZING latch (Unit B): flipped SYNCHRONOUSLY before the first await on every
   *  stop/despawn path (stopHandle + freeSlot are the chokepoints). Once set, this principal's
   *  control ops refuse (the membership gate) and no further credential is minted for it
   *  (renewal + the slot's own durable phase both refuse) — closing the freeSlot→retiring window
   *  in-process, not just by `agents.delete` ordering. */
  terminalizing?: boolean;
}

/**
 * The agent supervisor: a long-lived mesh node that owns agent process lifecycle.
 * It serves control requests on the "manager" service and spawns/kills agents
 * through a pluggable {@link Runtime} (pty by default). It does NOT proxy agent
 * mesh traffic — terminal I/O streams over its own attach endpoint instead.
 */

/** Runtime hooks the spawn-as-action serve path (P2 item 2) injects into {@link Manager.startAgent}.
 *  Roster boot and the blocking callers pass none (unchanged behavior). */
export interface SpawnHooks {
  /** Fires synchronously AFTER the incarnation identity (nkey + lifecycleUid) is minted but BEFORE
   *  any provision/side-effect — the accept seam: it binds the goal and replies the acceptance. A
   *  THROW here aborts the spawn before provisioning (the existing catch returns the failure and the
   *  finally releases the reserve, so no footprint leaks) — this is the bind-conflict refusal path. */
  onAccepted?: (allocated: { name: string; identity: Identity; lifecycleUid: string; agentTriple: { owner: string; actor: string; uid: string } }) => Promise<void> | void;
  /** Fires once the child process has been launched (the "launched" progress edge). */
  onLaunched?: () => void;
  /** Fires at the readiness verdict (presence join → succeeded / process exit → failed / window
   *  elapsed → uncertain), carrying the succeeded reply data — the async serve body commits the goal
   *  terminal + emits the final progress event here. Awaited, but the caller swallows its own errors
   *  so a terminal-commit failure never disrupts the (already-replied) spawn. */
  onOutcome?: (outcome: { kind: "succeeded" | "failed" | "uncertain"; data?: unknown }) => Promise<void> | void;
  /** Fires when this spawn ends with its goal's terminal owned by ANOTHER path — today only a
   *  despawn/stop that lands inside the readiness window, whose own handler commits `cancel`.
   *  It commits nothing; it only claims the terminal so the post-accept fallback does not
   *  manufacture a `failed` from the non-ok reply and race the real `cancel`. Without it, a
   *  deliberate stop mid-launch reports the agent as having died on launch. */
  onTerminalDeferred?: () => void;
}

/** The spawn-as-action acceptance (P2 item 2 floor): the ALLOCATED agent identity (name + the
 *  addressing triple item-1 addresses by) plus the goal coordinates (goalId = the request id) and
 *  the executor coordinate (the manager incarnation its terminal fences on). Carries NO secret
 *  material (pin 7); it names what was actually allocated, never a requested-but-unallocated name. */
export interface SpawnAcceptance {
  name: string;
  owner: string;
  actor: string;
  uid: string;
  goalId: string;
  fingerprint: string;
  executor: { lifecycleUid: string; epoch: number };
}

export class Manager {
  private readonly space: string;
  private readonly servers: string | undefined;
  /** P2 item 6: the broker ws listener port (loopback) `cotal up` allocated, for the console session
   *  client's wsUrl. Undefined ⇒ no console session client (POST /session 503s). */
  private readonly wsPort?: number;
  private readonly name: string;
  private readonly workspaceRoot: string;
  /** P2 item 6: the operator-set global live-session ceiling (see {@link ManagerOptions.maxSessions}). */
  private readonly maxSessions?: number;
  /** The ONE secret store for every kind this manager touches (daemon-cred remint + agent kinds).
   *  See {@link ManagerOptions.secretStore}. */
  private readonly secrets: SecretStore;
  /** See {@link ManagerOptions.installedExtensions}. */
  private readonly installedExtensions: boolean;
  private readonly runtime: Runtime;
  private readonly preserveStopTimeoutMs: number;
  private readonly agents = new Map<string, ManagedAgent>();
  /** Names whose spawn is in flight (reserved synchronously before the provision await) — counted
   *  toward the ceiling so two concurrent same-name spawns can't both pass the gate (P4a). */
  private readonly reserved = new Set<string>();
  /** Expiry stamps (`startedAt + MIN_LIFETIME`) for slots that freed while still young — a
   *  count-only, lazily-pruned recycle floor (P4c). Pruned + summed into the ceiling gate. */
  private cooling: number[] = [];
  /** Names RESERVED PENDING RETIREMENT (#29 piece 3): a despawned agent's name stays held until
   *  the auth plane confirms its lifecycle's retirement TERMINAL over the auth-admin rail — the
   *  alias-reuse gate that closes the same-name despawn→respawn race at its root. An UNCERTAIN
   *  outcome (rail down, timeout) keeps the hold with the last attempt's copy; a same-name spawn
   *  refuses legibly AND re-fires the request. In-memory: across a manager restart the durable
   *  truth is the auth-side lifecycle head itself (an unretired head refuses issuance — the
   *  named residual this belt narrows, not replaces). */
  private retiring = new Map<string, { opId: string; lifecycleUid: string; owner: string; actor: string; agentId: string; userOwner?: string; secretPaths?: ManagedAgent["secretPaths"]; startedAt: number; lastError?: string; standingAuthorityLive?: boolean }>();
  /** SINGLE-FLIGHT guard for {@link requestRetirement} (audit #1): one in-flight rail round-trip per
   *  (name, lifecycleUid). The detached `deprovision` call and every same-name-spawn nudge for THAT
   *  lifecycle JOIN the same promise instead of stacking independent requests that dual-enter the
   *  barrier; a fresh trigger after it settles re-drives. Keyed by (name, uid) — NOT name alone — so a
   *  same-name SUCCESSOR (which can spawn after the hold clears but before this flight's `nc.close`
   *  yield settles) never joins the predecessor's rail request and skips its own retirement. */
  private retiringFlight = new Map<string, Promise<void>>();
  /** Wire principals of RETIRED static incarnations (Unit B, F5(a)): populated at every completed
   *  static terminal and from the boot sweep's retired slot rows, so a copied credential of a
   *  retired incarnation is refused at the control surface even across a manager restart. The
   *  durable truth is the slot row + principal-keyed head; this set is the in-memory index of it
   *  (one string per retired incarnation — bounded by lifecycle count, never pruned in-process). */
  private readonly retiredPrincipals = new Set<string>();
  /** This manager process's own incarnation uid (SPEC 13.1; minted once per supervisor process,
   *  never reused across restarts) — the endpoint's presence key AND the `managerInstance` audit
   *  coordinate every static activation records. */
  private readonly managerLifecycleUid = mintLifecycleUid();
  /** The persisted LOGICAL instance id (SPEC 13.6 item 7, P2 item 3): STABLE across restart, so a
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
  /** P2 item 1 (1a-serve): the manager's v0.4 service-endpoint serve state — the serve handle +
   *  its dedicated connection, the STABLE serve identity (renewals re-mint the same nkey), the
   *  branded serve grant, and the CURRENT credential (the connection's authenticator reads it on
   *  every (re)connect, so a renewal is adopted without re-registration). Absent on open meshes,
   *  in user mode (the named 1a follow-up), and before registration completes. */
  private serviceServe?: { handle: EpServeHandle; nc: NatsConnection; identity: Identity; grant: EpServeGrant; creds?: string };
  /** P2 item 2 (spawn-as-action): the SELF-MEDIATED goal-writer connection + ActionContext — a
   *  standing connection DISJOINT from the serve credential (Q2), scoped to exactly this endpoint's
   *  goal bind/terminal facts + goal-record writes ({@link goalWriterGrants}). Auth mode mints the
   *  `goal-writer` cred; an open mesh uses a bare connection (no credential system to mint from).
   *  `gate` (auth mode) is the own-issuance-gate READER for the must-5 (a) currency belt — the
   *  manager reads its OWN `epgate.<e>.<iid>` epoch over this connection before a terminal commit
   *  and skips a superseded commit (the fast-fail belt paired with the (b) barrier-revoke fence). */
  private goalWriter?: { nc: NatsConnection; ctx: ActionContext; creds?: string; identity: Identity; gate?: EpIssuanceGate };
  /** P2 item 2 must-5 (b): the STABLE goal-writer identity (auth mode) — minted once at
   *  registration alongside the serve identity; a renewal re-mints the SAME nkey with a fresh
   *  bounded exp and re-stages its distinct credId into the §13.1 revocation family. The current
   *  goal-writer credential is minted INSIDE {@link registerManagerService}'s run block (fence
   *  live) and stashed here for {@link startGoalWriter} to build the standing connection from. */
  private goalWriterIdentity?: Identity;
  private goalWriterCreds?: string;
  /** P2 item 6: the manager's ONE §13.6 session plane — offer mint + one-use redeem + PTY-bridge
   *  standup for `attach`. The face's establisher and the CLI attach handler both call THIS one
   *  plane; the manager never constructs a second. Undefined until {@link startSessionPlane}. */
  private sessionPlane?: ManagerSessionPlane;
  /** P2 item 6: the standing session-LEDGER connection + its mutable creds holder (the authenticator
   *  presents the refreshed cred on the next reconnect after a half-TTL renewal — the goal-writer
   *  precedent). Auth mode only; an open mesh runs the plane over a bare connection. */
  private sessionLedgerConn?: { nc: NatsConnection; creds?: string };
  /** P2 item 6: credentialId → the nkey that credential was minted for, for the live per-session
   *  SERVING credentials. The §13.1 ledger row records the holder principal, and the row is written
   *  at stage time (after the mint), so the two steps need this one hop. Entries are dropped at
   *  revoke; a session that never staged drops its entry when the manager exits. */
  private readonly sessionServingKeys = new Map<string, string>();
  /** P2 item 6: the STABLE session-LEDGER identity (auth mode) — minted once at registration
   *  alongside the serve + goal-writer identities; a renewal re-mints the SAME nkey with a fresh
   *  bounded exp and re-stages its distinct credId into the §13.1 revocation family. The current
   *  credential is minted INSIDE {@link registerManagerService}'s run block and stashed here. */
  private sessionLedgerIdentity?: Identity;
  private sessionLedgerCreds?: string;
  /** P2 item 2: the acceptance replied for each in-flight goalId this incarnation accepted, so an
   *  idempotent same-goalId retry serves the IDENTICAL acceptance (same allocated name/triple) without
   *  a second spawn. Durable cross-incarnation reconstruction rides the must-5 goal-index; here the
   *  live map covers same-incarnation retries, with the committed result fact as the fallback. */
  private goalAcceptances = new Map<string, SpawnAcceptance>();
  /** P2 item 2 must-5 Q-B: the boot reconcile of the durable goal index runs ONCE at start (a
   *  fresh incarnation inherits the endpoint's accepted-but-unterminal goals from any predecessor).
   *  Spawn-as-action REFUSES to accept until it completes, so the sweep never races a live goal's
   *  acceptance (settling one mid-flight would steal its real terminal). */
  private goalReconcileDone = false;
  /** P2 item 2 (M4): the live spawn goal ref for each managed agent name, so a despawn MID-GOAL
   *  drives the cancel path (transition -> cancel terminal). Cleared when the goal terminalizes. */
  private agentGoals = new Map<string, GoalRef>();
  /** Process start, for the served `status` uptime. */
  private readonly startedAtMs = Date.now();
  /** SINGLE-FLIGHT guard for {@link deprovision} (INT-2/C): one in-flight teardown per
   *  (name, lifecycleUid). The detached freeSlot teardown and every same-name-spawn nudge that
   *  re-drives it JOIN one promise instead of launching a SECOND, concurrent teardown. Without it,
   *  two teardowns race the NAME-KEYED ledger revoke: once the first frees the alias and a successor
   *  mints its own row, the second's delayed revoke (which carries no lifecycle coordinate) would
   *  delete the SUCCESSOR's standing authority. Keyed by (name, uid) so a later same-name lifecycle
   *  gets its own flight; a fresh trigger after settle re-drives only if the hold still stands. */
  private deprovisioningFlight = new Map<string, Promise<void>>();
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
  private leaseInfo?: Omit<ManagerLeaseInfo, "since">;
  private leaseRevision?: number;
  private leaseTimer?: ReturnType<typeof setInterval>;
  /** The class-2 renewal owner's half-TTL schedule (D5 slice 5); armed only on auth meshes. */
  private credRenewTimer?: ReturnType<typeof setInterval>;
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

  constructor(opts: ManagerOptions) {
    this.space = opts.space;
    this.servers = opts.servers;
    this.name = opts.name ?? "manager";
    this.workspaceRoot = opts.workspaceRoot ?? findCotalRoot();
    this.maxSessions = opts.maxSessions;
    this.secrets = opts.secretStore ?? workspaceSecretStore(this.workspaceRoot);
    this.installedExtensions = opts.installedExtensions ?? false;
    this.runtime = createRuntime(opts.runtime ?? "auto", `cotal-${this.space}`);
    this.preserveStopTimeoutMs = opts.preserveStopTimeoutMs ?? PRESERVE_STOP_TIMEOUT_MS;
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
      // P2 item 6: the console's mesh §13.6 session establisher — injected ONLY when a broker ws
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
    return this.runtime.kind;
  }

  /** The console page URL (manager-hosted, loopback). */
  get consoleUrl(): string {
    return this.attach.consoleUrl();
  }

  async start(): Promise<void> {
    await this.attach.start();
    // In auth mode the manager is just another user in the space's account — it mints
    // itself creds from the same signing key it uses for the agents it spawns. The signer comes
    // through the SecretStore seam (`this.secrets` — the injected `ManagerOptions.secretStore`, or
    // the local `.cotal/auth/auth.json` FS default), so a HOSTED composition mints from its KMS/Vault
    // and no signing seed is ever read from the hosted disk. `this.space` cross-checks the bundle.
    this.auth = await getSpaceAuth(this.secrets, this.space);
    // USER-MODE detection is FAIL-CLOSED on the on-disk marker (the space-scoped state dir), never
    // on the mutable mesh registry alone — registry drift/tamper must not let a user-auth space
    // take the static self-mint branch. A marker/registry disagreement is a refused start with the
    // repair, not a guess.
    this.userMode = hasUserAuthState(this.workspaceRoot, this.space);
    const recorded = loadMeshes().find((m) => m.space === this.space);
    if (recorded && (recorded.mode === "user") !== this.userMode)
      throw new Error(
        `mesh registry says space "${this.space}" is ${recorded.mode}-mode but the on-disk user-auth marker ${this.userMode ? "exists" : "is missing"} (${userAuthStateDir(this.workspaceRoot, this.space)}) - \`cotal down\` and re-\`cotal up\` this space to reconcile before running a manager`,
      );
    if (this.userMode && !recorded)
      throw new Error(
        `space "${this.space}" has user-auth state on disk but no mesh registry entry - a user-mode manager needs the authoritative record (\`cotal up\` writes it before the control plane); \`cotal up --user-auth\` this space, or remove the stale ${userAuthStateDir(this.workspaceRoot, this.space)}`,
      );
    if (this.userMode && !this.auth)
      throw new Error(
        `space "${this.space}" has user-auth state but no auth.json under ${authDir(this.workspaceRoot)} - the pre-flip manager still needs the space trust bundle; re-run \`cotal up --user-auth\` here`,
      );
    // P2 item 3 (SPEC 13.6 item 7): the LOGICAL instance id + serve identity PERSIST across restart
    // (a space-scoped manager identity file under .cotal). A restart re-registers the SAME id with an
    // ADVANCED epoch (the successor fences the predecessor); a fresh mint over a malformed file is
    // refused loud (no-fallbacks - a restart never silently becomes a fresh instance). A second
    // manager in a DIFFERENT workspace root is a DIFFERENT logical id by construction (its own state
    // dir) - two managers in ONE space are two workspace roots.
    {
      const persisted = loadManagerInstanceIdentity(this.workspaceRoot, this.space);
      if (persisted !== undefined) {
        this.managerInstanceId = persisted.instanceId;
        this.managerServeIdentity = persisted.serveIdentity;
      } else {
        this.managerInstanceId = mintLifecycleUid();
        this.managerServeIdentity = newIdentity();
        saveManagerInstanceIdentity(this.workspaceRoot, this.space, { instanceId: this.managerInstanceId, serveIdentity: this.managerServeIdentity });
      }
    }
    let creds: (() => Promise<string>) | undefined;
    let id: string | undefined;
    if (this.auth) {
      const identity = newIdentity();
      const auth = this.auth;
      id = identity.id;
      // The long-lived SUPERVISOR cred (closure (ii), residual 2): serve the three control tiers, hold the
      // singleton lease (open-only), publish + watch presence — and nothing else. Provisioning runs on an
      // EPHEMERAL provisioner connection per spawn (withProvisioner); destructive purge mints a PURGER per
      // call. So the always-on daemon holds no DM/DLV read, no consumer-create, no stream-admin tamper.
      //
      // STANDING RENEWAL (D5 slice 5, class 1): the manager holds the DATA signing seed, so it is its
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
      // every static activation, Unit B).
      lifecycleUid: this.managerLifecycleUid,
      // The supervisor serves control + watches presence; it never consumes chat/dm/task
      // (no message handler). consume:false avoids binding consumers it doesn't use — and
      // under auth avoids trying to bind its own DM/task durables that nothing pre-created.
      // It still pre-creates OTHERS' durables via provisionDmInbox/provisionTaskQueue (lazy jsm).
      consume: false,
      // It also never reads the channel registry (it provisions + serves control, no channel
      // pull/display), so skip the channel-registry watch — the supervisor cred (residual 2) then
      // holds no channel-KV read grant. Presence (the roster) is still watched.
      watchChannels: false,
      card: { id, name: this.name, role: "manager", kind: "endpoint" },
    });
    // Surface endpoint errors (incl. NATS permission denials) — without a listener an
    // emitted "error" would crash the supervisor.
    this.ep.on("error", (e: Error) => console.error(`! manager endpoint: ${e.message}`));
    await this.ep.start();
    await this.ep.setActivity(`supervisor (${this.runtime.kind})`);
    // Per-instance liveness lease (P2 item 3 — the old per-space singleton is DEMOTED per D9). Acquire
    // THIS logical instance's own key (atomic CAS create). A DIFFERENT instance (a second manager in a
    // second workspace root) has a distinct id ⇒ a distinct key ⇒ it coexists; the create THROWS only
    // when the SAME instance id is already live (a same-root double-start, or a restart racing the
    // crashed predecessor's not-yet-expired key), and we REFUSE loud. A crashed holder's key auto-expires
    // (bucket TTL). Losing this key later stops THIS instance only, never the space (security pin 6).
    this.leaseInfo = { holder: this.ep.ref().id, instanceId: this.managerInstanceId, runtime: this.runtime.kind, root: resolve(this.workspaceRoot), pid: process.pid };
    try {
      this.leaseRevision = await this.ep.acquireManagerLease(this.leaseInfo);
    } catch (e) {
      // Our OWN instance id already holds a live key ⇒ refuse. Anything else (e.g. a KV/JS error) is a
      // real failure to surface, not a silent "held" — keep the cause so it isn't misread as a conflict.
      const held = await this.ep.readManagerLease().catch(() => undefined);
      await this.ep.stop();
      await this.attach.stop();
      throw new Error(
        held
          ? `manager instance ${this.managerInstanceId} already serves space "${this.space}" from this workspace root (${held.runtime}, pid ${held.pid}, root ${held.root}) - stop it first before restarting the same instance`
          : `could not acquire the manager lease for space "${this.space}": ${(e as Error).message}`,
      );
    }
    this.leaseTimer = setInterval(() => { void this.renewLease(); }, MANAGER_LEASE_TTL_MS / 2);
    this.leaseTimer.unref?.();
    // Unit B (static §13.1): ensure the two authority stores exist with their normative shape,
    // then sweep the durable slot rows and reconcile — re-drive any crashed activation/terminal
    // (exact-op) and terminalize dead-but-active slots (F3 "no active orphan"). Runs ONLY under
    // the just-acquired lease (a refused second manager must never sweep-terminal live slots) and
    // BEFORE control serving, so no spawn races the reconciliation.
    if (this.auth && !this.userMode) await this.reconcileStaticLifecycles();
    // P2 item 1 (1d): the manager serves NO ctl tiers - its whole control surface is the v0.4
    // service endpoint registered below. The old three-tier rail (self/manager/admin) is deleted;
    // `ctl.delivery`/`ctl.delivery-admin` (the delivery daemon) and `ctl.auth-admin` (the auth
    // plane) are separate services and keep their rails.
    // D5 slice 5 class 2: the manager is the CLASS-2 RENEWAL OWNER — the one control-plane process
    // that is resident in EVERY mesh mode (foreground `up`, `up --detach`, same-root refresh) and
    // holds the signer. Ordered initial pass NOW (ensureControlPlane starts delivery BEFORE the
    // manager, so the daemon's launch-time creds write always precedes this — no write race), then
    // every half-TTL: re-sign the daemon creds files for their EXISTING nkeys, request the explicit
    // `reloadCreds` adoption on the delivery-admin rail, and persist the audit record doctor renders.
    if (this.auth) {
      await this.renewDaemonCreds();
      this.credRenewTimer = setInterval(() => { void this.renewDaemonCreds(); }, (STANDING_RENEWABLE_TTL_SEC / 2) * 1000);
      this.credRenewTimer.unref?.();
    }
    // P2 item 1: register the manager as an ordinary v0.4 `service` endpoint (SPEC §13.7/§13.9)
    // and serve its typed command surface on the ep rails - since 1d the ONLY control door, in
    // EVERY mesh mode. Static + user meshes mint the scoped executor + endpoint-serve credential;
    // an open mesh runs the same gate/registration ceremony over bare connections and never mints
    // (there is no credential system - the broker enforces nothing, matching the old open-mesh ctl
    // trust). Fail-loud: a manager that cannot register does not start half-registered.
    await this.registerManagerService();
    // P2 item 2: stand up the standing goal-writer connection for spawn-as-action — AFTER
    // registration (it writes this endpoint's goal facts/records), disjoint from the serve cred.
    await this.startGoalWriter();
    // P2 item 6: stand up the ONE §13.6 session plane for `attach` — AFTER registration too (it
    // rides the serve grant's epoch + the family-staged session-ledger cred), on its own standing
    // connection disjoint from both the serve and goal-writer creds.
    await this.startSessionPlane();
    // P2 item 2 must-5 Q-B: reconcile any accepted-but-unterminal goals inherited from a predecessor
    // BEFORE spawn-as-action begins accepting (the goalReconcileDone gate) — a fresh incarnation
    // never drops a goal a dead predecessor accepted. Never fatal; the gate opens either way.
    await this.reconcileGoalIndex();
    // Plane-3 (durable backstop) is NOT the manager's job — the manager only manages agent lifecycle.
    // The server-side delivery daemon hosts the fan-out writer + trusted reader, owns the durable
    // membership registry, and serves the runtime durable join/leave/list ops (on `ctl.delivery`). The
    // manager records each agent's read ACL at spawn (`commitAcl`, in provisionAgent) so the daemon can
    // re-authorize it; that is the only Plane-3 state the manager touches, and it rides minting.
  }

  /** One class-2 renewal pass (D5 slice 5): re-sign `.cotal/delivery.creds` + `.cotal/membership-rw.creds`
   *  for their existing nkeys, then request the delivery daemon's EXPLICIT `reloadCreds` adoption on the
   *  delivery-admin rail and persist the audit record (`.cotal/renewal.json`) that `cotal doctor auth`
   *  renders — so "file re-signed" and "daemon adopted" are distinguishable states. A missing daemon
   *  (no responder) is recorded honestly: each daemon's own 75% renewal timer remains the adoption backstop.
   *  Never throws — renewal failure must be LOUD (log + record), not fatal to the supervisor. */
  private async renewDaemonCreds(): Promise<void> {
    const release = this.beginLifecycle();
    if (!release) return;
    try {
      // Re-sign through the manager's ONE store — the SAME store the delivery daemon reads
      // (`runDelivery(args, store)`), so a hosted remint writes the store the daemon renews from,
      // never a divergent one. Locally this is the workstation FS store (`.cotal/*.creds`).
      // `this.space` gates cross-space signer swaps; the `preflight` proves broker acceptance before
      // overwriting from ANY signer form (full or stripped). A same-label alternate full bundle is
      // self-bound, not broker-bound, so the manager-hosted path proves every re-sign before it could
      // clobber the last-good with a broker-dead cred; a wrong-account signer's cred is refused here.
      const results = await remintDaemonCreds(this.workspaceRoot, this.space, this.secrets, {
        preflight: (creds) => this.probeStaticCredential(creds).then((r) => r.ok),
      });
      const resigned = results.filter((r) => r.ok);
      let adoption: RenewalRecord["adoption"];
      if (resigned.length) {
        // Hand the daemon the EXPECTED generation per component (SHA-256 of the JWT we just
        // re-signed) so its reply proves it adopted THIS generation, not merely re-read some file.
        const expected: { delivery?: string; membership?: string } = {};
        for (const r of resigned) {
          if (r.file === DELIVERY_CREDS_KEY && r.fingerprint) expected.delivery = r.fingerprint;
          else if (r.file === MEMBERSHIP_RW_CREDS_KEY && r.fingerprint) expected.membership = r.fingerprint;
        }
        try {
          const reply = await this.ep.requestDeliveryAdmin("reloadCreds", { expected }, DELIVERY_ADMIN_RELOAD_TIMEOUT_MS);
          // Keep the per-component aggregate on BOTH outcomes: on a top-level failure `reply.data`
          // still carries which component adopted and which was refused, which `doctor auth` renders.
          adoption = reply.ok
            ? { ok: true, detail: reply.data }
            : { ok: false, error: reply.error, detail: reply.data };
        } catch (e) {
          adoption = { ok: false, error: `no delivery-admin responder (${(e as Error).message}) - the daemon's 75% re-read backstop adopts the re-signed file` };
        }
      }
      for (const r of results.filter((x) => !x.ok && !x.skipped))
        console.error(`! credential renewal: could not re-sign ${r.file}: ${r.error} - the daemon dies loud at this cred's expiry unless it is reminted`);
      if (adoption && !adoption.ok) console.error(`! credential renewal: daemon adoption failed: ${adoption.error}`);
      // `writeRenewalRecord` redacts the ephemeral fingerprint at the persistence boundary (covering
      // the `doctor auth --fix` writer too), so the results pass straight through.
      writeRenewalRecord(this.workspaceRoot, { ts: new Date().toISOString(), owner: "manager", results, adoption });
      this.warnOnSystemCredExpiry();
      // F5(b) (Unit B): the MANAGER is the renewal owner for its managed-static agent creds —
      // supervisor-side PUSH remint for recorded LIVE slots (the child JWT is never proof of
      // incarnation; a copied credential cannot drive this and is stranded at its own row's TTL).
      // Same class-2 mechanics as the daemon creds: re-sign the file for the SAME nkey; the
      // agent endpoint's 75% source re-read adopts it.
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
            const stored = await this.secrets.get(agentSecretKeyForFile(a.secretPaths.creds));
            if (stored === undefined) continue; // no materialized cred (never minted here) - nothing to renew
            const health = inspectCredHealth(stored);
            if (health.state === "healthy") continue;
            if (health.state === "unbounded" || health.state === "unreadable") {
              console.error(`! managed cred renewal ${a.name}: credential is ${health.state}${health.error ? ` (${health.error})` : ""} - not renewed (a pre-TTL credential stays as minted until respawn)`);
              continue;
            }
            await this.renewManagedStaticCred(a);
          } catch (e) {
            console.error(`! managed cred renewal ${a.name}: ${(e as Error).message} - the agent dies loud at this cred's expiry unless it is reminted`);
          }
        }
      }
      // P2 item 1 (checklist 7): the manager is the `endpoint-serve` renewal owner for its OWN
      // service credential — re-mint the SAME serve identity with a fresh bounded exp THROUGH the
      // §13.1 mint fence over a scoped one-shot executor (every renewal stages a distinct ledger
      // row and wins the gate CAS; never the standing connection). The serve connection's
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
          }
        } catch (e) {
          console.error(`! endpoint-serve renewal: ${(e as Error).message} - the manager's service endpoint dies loud at this cred's expiry unless it is re-registered`);
        }
      }
      // P2 item 2 must-5 (b): the manager is also the goal-writer's renewal owner — re-mint the SAME
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
          }
        } catch (e) {
          console.error(`! goal-writer renewal: ${(e as Error).message} - spawn-as-action stops accepting at this cred's expiry unless the manager restarts`);
        }
      }
      // P2 item 6: the manager is also the session-ledger's renewal owner — re-mint the SAME nkey
      // with a fresh bounded exp AND re-stage its new credId into the §13.1 family, through the
      // scoped executor. Without this the standing session-ledger connection dies at its TTL and
      // `attach` stops establishing sessions until a restart. The connection's authenticator presents
      // the refreshed credential on its next (re)connect.
      if (this.sessionLedgerConn && this.sessionLedgerCreds && this.auth) {
        const sw = this.sessionLedgerConn;
        try {
          if (inspectCredHealth(this.sessionLedgerCreds).state !== "healthy") {
            const fresh = await this.withEndpointServeExecutor(({ authKv }) => this.mintAndStageSessionLedger(authKv));
            this.sessionLedgerCreds = fresh;
            sw.creds = fresh;
          }
        } catch (e) {
          console.error(`! session-ledger renewal: ${(e as Error).message} - attach stops establishing sessions at this cred's expiry unless the manager restarts`);
        }
      }
    } catch (e) {
      console.error(`! credential renewal pass failed: ${(e as Error).message}`);
    } finally {
      release();
    }
  }

  /** Warn, on every renewal pass, when a $SYS credential is at or past its renewal point.
   *
   *  The manager is the renewal owner for every credential it CAN re-sign, and these two are the ones
   *  it cannot: they are `rotation-renewed`, so no resident process re-mints them and they simply die
   *  on their 30-day horizon. Before this, a mesh that never ran `doctor auth` got no signal at all —
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
      const path = join(this.workspaceRoot, ".cotal", file);
      if (!existsSync(path)) continue;
      let health: CredHealth;
      try {
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
   * preserveState flips state before its first await, so work is either counted or rejected. */
  private beginLifecycle(resumeOperation = false): (() => void) | undefined {
    if (this.maintenanceState !== "active" || (this.resumeRequired && !resumeOperation)) return undefined;
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

  /** A cleanup spawned by accepted active-mode work is part of that work for maintenance draining,
   * even where the ordinary control reply remains fire-and-forget. */
  private trackDeprovision(a: { id: string; name: string; lifecycleUid: string; userOwner?: string; secretPaths?: ManagedAgent["secretPaths"] }, context = ""): void {
    this.lifecycleInFlight++;
    void this.deprovision(a)
      .catch((e) => console.error(`deprovision${context ? ` ${context}` : ""} ${a.name} (${a.id}): ${(e as Error).message}`))
      .finally(() => this.releaseLifecycle());
  }

  private async awaitLifecycleDrain(): Promise<void> {
    if (this.lifecycleInFlight === 0) return;
    await new Promise<void>((resolve) => this.lifecycleDrainWaiters.push(resolve));
  }

  private maintenanceError(): string {
    if (this.resumeRequired) return `manager is waiting for resume attempt ${this.resumeAttemptId}; ordinary lifecycle/control work is fenced`;
    return `manager is in ${this.maintenanceState} mode; new lifecycle/control work is fenced`;
  }

  /** Fence and build the inventory without stopping a child. The coordinator must durably persist
   * this exact plan before calling commitPreservation with the same attempt id. */
  preparePreservation(attemptId: string): Promise<ManagerPreservationPlan> {
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
    const inventory = this.preservationInventory ?? {
      version: "cotal-manager-resume/v1",
      space: this.space,
      createdAt: new Date().toISOString(),
      agents: [...this.agents.values()].map((a) => this.resumeEntry(a)),
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
      failures.push({ name: "<inventory>", id: attemptId, error: `prepared inventory would be rejected at resume: ${(e as Error).message}` });
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
      this.credRenewTimer = setInterval(() => { void this.renewDaemonCreds(); }, (STANDING_RENEWABLE_TTL_SEC / 2) * 1000);
      this.credRenewTimer.unref?.();
    }
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
          failures.push({ name: a.name, id: a.id, error: `stop failed: ${(e as Error).message}` });
          return;
        }
        try {
          await this.awaitHandleExit(a.handle);
          if (this.agents.get(a.name) === a) this.agents.delete(a.name);
        } catch (e) {
          failures.push({ name: a.name, id: a.id, error: (e as Error).message });
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
    if (handle.status() === "exited") return;
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
        return `retained reference unavailable: ${path} (${(e as Error).message})`;
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
      return `retained reference cannot be hashed: ${(e as Error).message}`;
    }
    return undefined;
  }

  private fileDigest(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }

  private fileDigestOrEmpty(path: string): string {
    try { return this.fileDigest(path); } catch { return ""; }
  }

  private resumeEntry(a: ManagedAgent): ManagerResumeAgent {
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
            return { mode: "static" as const, id: principal.actor, lifecycleUid: a.lifecycleUid, credential: { kind: "file" as const, path: files.creds, sha256: this.fileDigestOrEmpty(files.creds) } };
          })()
        : { mode: "open", id: principal.actor, lifecycleUid: a.lifecycleUid };
    const dependencies = [a.launch.source.configPath];
    if (a.launch.source.kind === "manifest" && a.launch.source.runId)
      dependencies.unshift(join(this.workspaceRoot, ".cotal", "run", `${a.launch.source.runId}.json`));
    return {
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
        events: a.launch.events,
        shareTools: a.launch.shareTools,
        forkSource: a.launch.forkSource,
        unresolvedLaunchOptionKeys: a.launch.unresolvedLaunchOptionKeys,
      },
      dependencies,
      spawner: a.spawner,
      authorityParent: a.authorityParent,
      startedAt: new Date(a.startedAt).toISOString(),
    };
  }

  /** Tear down every managed agent's footprint — the shared teardown for EVERY manager-exit path (#159
   *  B2): graceful {@link stop} AND the fail-closed lease-loss exit ({@link renewLease}). A manager exit is
   *  a mass agent-exit, and without this its agents' footprints (creds files + `dm_`/`dlv_` durables + ACL
   *  rows) would orphan exactly as the per-agent exit path prevents. Hard-stop each child (an exit has no
   *  time for the graceful grace window) and AWAIT its deprovision — bounded per agent (`withTimeout`) and
   *  best-effort (`allSettled` + a loud log), so one slow/failed teardown can neither hang nor abort exit.
   *  The creds file is dropped even if the broker teardown fails (see {@link deprovision}). Deliberately
   *  touches NEITHER the lease NOR the endpoints — the caller owns those (and lease loss must NOT release
   *  the key, which may now belong to a replacement holder). */
  private async teardownManagedAgents(): Promise<void> {
    const managed = [...this.agents.values()];
    for (const a of managed) {
      // Free the slot + hard-stop each; `stopHandle` is best-effort (never throws — see it), so one bad
      // stop can't strand the rest, and every snapshot entry is deprovisioned below regardless.
      this.agents.delete(a.name);
      this.stopHandle(a, false);
    }
    // Deprovision EVERY snapshot entry regardless of whether its stop failed (allSettled + a loud log).
    await Promise.allSettled(
      managed.filter((a) => !a.suppressCleanup).map((a) =>
        this.deprovision(a).catch((e) => console.error(`deprovision ${a.name} (${a.id}) on shutdown: ${(e as Error).message}`)),
      ),
    );
  }

  private async stopRetainedAgentsOnExit(): Promise<void> {
    const managed = [...this.agents.values()];
    for (const a of managed) a.suppressCleanup = true;
    const failures: string[] = [];
    await Promise.all(managed.map(async (a) => {
      try {
        a.handle.stop({ graceful: false });
      } catch (e) {
        failures.push(`${a.name}: stop failed: ${(e as Error).message}`);
      }
      try {
        await this.awaitHandleExit(a.handle);
        if (this.agents.get(a.name) === a) this.agents.delete(a.name);
      } catch (e) {
        failures.push(`${a.name}: ${(e as Error).message}`);
      }
    }));
    if (failures.length)
      throw new Error(`manager preservation shutdown incomplete: ${failures.join("; ")}`);
  }

  async stop(): Promise<void> {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    if (this.credRenewTimer) clearInterval(this.credRenewTimer);
    if (this.maintenanceState === "active" && !this.resumeRequired) {
      await this.teardownManagedAgents(); // normal shutdown stays destructive (#159 B2)
    } else {
      // A signal after a partial preservation must never fall back into destructive teardown.
      await this.stopRetainedAgentsOnExit();
    }
    await this.ep.releaseManagerLease(this.managerInstanceId, this.leaseRevision);
    await this.stopServiceServe();
    await this.stopGoalWriter();
    await this.stopSessionPlane();
    await this.ep.stop();
    await this.attach.stop();
  }

  /** Stop the v0.4 service-endpoint serve loop (drain subscriptions, await in-flight handlers)
   *  and drop its dedicated connection. Best-effort by design — both exit paths (graceful stop,
   *  lease-loss fail-close) must complete their remaining teardown even if the broker is gone. */
  private async stopServiceServe(): Promise<void> {
    const s = this.serviceServe;
    if (!s) return;
    this.serviceServe = undefined;
    try { await s.handle.stop(); } catch { /* best effort */ }
    try { await s.nc.drain(); } catch { try { s.nc.close(); } catch { /* best effort */ } }
  }

  /** Refresh THIS instance's liveness lease before the bucket TTL expires it. On loss (missed the TTL —
   *  this instance stalled past the renew window) FAIL CLOSED for THIS INSTANCE ONLY: stop serving +
   *  tear down OUR managed agents + exit, so a stalled instance can't keep double-processing under a key
   *  a same-id restart may re-acquire. Keyed per instance, so this NEVER frees or touches a sibling
   *  manager's key and NEVER freezes the space (security pin 6) — the sibling keeps serving. We do NOT
   *  re-acquire (a same-id restart may already be live) and do NOT release the key (it may be the
   *  restart's). A DIFFERENT instance losing ITS key is a separate, independent event. */
  private async renewLease(): Promise<void> {
    try {
      if (!this.leaseInfo || this.leaseRevision === undefined) return;
      this.leaseRevision = await this.ep.renewManagerLease(this.leaseInfo, this.leaseRevision);
    } catch (e) {
      console.error(`! manager instance ${this.managerInstanceId} lost its liveness lease for space "${this.space}" (${(e as Error).message}) - shutting down THIS instance (its serving only; siblings keep the space)`);
      if (this.leaseTimer) clearInterval(this.leaseTimer);
      // Tear down our managed agents' footprints too (#159 B2) — this exit path leaks them otherwise. Do
      // NOT release the lease key (it may belong to the replacement holder). Best-effort, like ep/attach.
      try {
        if (this.maintenanceState === "active" && !this.resumeRequired) await this.teardownManagedAgents();
        else await this.stopRetainedAgentsOnExit();
      } catch { /* best effort */ }
      await this.stopServiceServe();
      await this.stopGoalWriter();
      await this.stopSessionPlane();
      try { await this.ep.stop(); } catch { /* best effort */ }
      try { await this.attach.stop(); } catch { /* best effort */ }
      process.exit(1);
    }
  }

  private async opFinalizeResume(rawArgs: unknown): Promise<ControlReply> {
    {
      let args: { attemptId: string; durableCommitToken: string };
      try {
        args = parseResumeFinalizeArgs(rawArgs);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
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
        return { ok: false, error: `resume attempt ${args.attemptId} cannot verify live principals at finalize: ${(e as Error).message}` };
      }
      if (inactive.length)
        return { ok: false, error: `resume attempt ${args.attemptId} is not live at finalize: ${inactive.join("; ")}` };
      for (const entry of this.resumeInventory?.agents ?? []) {
        const managed = this.agents.get(entry.name);
        if (managed) managed.suppressCleanup = false;
      }
      // Unit B (F3, distsys/security CONDITIONAL @ 9e13648): the boot sweep DEFERRED every active
      // slot while a resume was pending (it could not know which would be adopted). Now adoption
      // is complete and `this.agents` is EXACTLY the adopted set, so re-sweep to terminalize any
      // active slot the resume did NOT claim — a durable ACTIVE ORPHAN (crashed after slot->active
      // before agents.set, then not in the resumed inventory). This runs while `resumeRequired` is
      // still true, so no ordinary spawn can race it (beginLifecycle refuses non-resume ops), and
      // it closes both the alias wedge AND the F5(a) gap (the orphan's principal enters
      // retiredPrincipals, so a copied JWT is refused). Best-effort + loud: a sweep failure must
      // not fail the finalize (the next non-resume boot re-drives it), but it is never swallowed.
      if (this.auth && !this.userMode)
        await this.reconcileStaticLifecycles(true).catch((e) => console.error(`! post-resume static reconcile: ${(e as Error).message} - a durable active orphan may still wedge its alias until the next non-resume restart`));
      this.resumeFinalized = true;
      this.resumeRequired = false;
      return { ok: true, data: { attemptId: args.attemptId, state: "active" } };
    }
  }

  private async opCommitResume(rawArgs: unknown): Promise<ControlReply> {
    {
      let attemptId: string;
      try {
        attemptId = parseResumeCommitArgs(rawArgs).attemptId;
      } catch (e) {
        return { ok: false, error: (e as Error).message };
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
        return { ok: false, error: (e as Error).message };
      }
    }
  }

  private async opPreservationCtl(op: string, rawArgs: unknown): Promise<ControlReply> {
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
      return { ok: false, error: (e as Error).message };
    }
  }

  /** The ONE shared control-admission chokepoint (P2 item 1, checklist 3/8) BOTH dispatch doors
   *  run — the v0.3 `ctl` door ({@link handle}) and the v0.4 `ep` service handlers
   *  ({@link serveGated}): the maintenance/resume fence (`beginLifecycle`: a resume-pending or
   *  non-active manager accepts no ordinary control work) and then the F5(a) membership gate
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
   *  onto the §13.3 catalog: maintenance/resume → `unavailable`, F5(a) membership →
   *  `permission-denied`. The serve boundary publishes the structured error reply. */
  private async serveGated<T>(ctx: EpServeContext, fn: () => T | Promise<T>): Promise<T> {
    const caller = principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key;
    const admission = this.admitControl(caller);
    if (admission.refusal !== undefined)
      throw new EpEnvelopeError(admission.fence === "membership" ? "permission-denied" : "unavailable", admission.refusal);
    try {
      return await fn();
    } finally {
      admission.release();
    }
  }

  /** The ep door's ADMIN flag for a caller (the 1c tier refinement). Static mesh: `true` — the
   *  admin-grade rows (any-mode despawn/attach, the `manager.admin` family, `launch`) are minted
   *  only into operator instruments (§13.2: `any` is operator-policy-mintable; the agent/spawn
   *  rollups never carry them), so REACHING the handler is holding the admin tier, exactly as
   *  holding `ctl.<admin>` is today. User mesh: the caller's CURRENT ledger scope must carry
   *  `admin` — the same fresh-read authority {@link psOwnerFilter} consults, so a revoked scope
   *  demotes the very next call even on a still-valid bearer. Fail-closed: an unreadable ledger
   *  authorizes nothing. NAMED RESIDUAL (critic, 1c.2b): the static `true` has no serve-time
   *  re-check — a LEAKED static admin instrument keeps its reach until the credential's bounded
   *  TTL (the one-shot 5-minute profile), the same static-revoke≠reconnect-death class ruled
   *  across this campaign; static revocation is the TTL, not a ledger. */
  private async epAdminReach(caller: string): Promise<boolean> {
    if (!this.userMode) return true;
    const key = parsePrincipalKey(caller);
    if (!key) return false;
    try {
      const scope = await resolveAuthProvider().actorScope({
        dir: userAuthStateDir(this.workspaceRoot, this.space),
        owner: key.owner,
        actor: key.actor,
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
    if (!(await this.epAdminReach(principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key)))
      throw new EpEnvelopeError("permission-denied", `an any-mode ${ctx.subject.command} is operator reach; the caller's current ledger grant does not carry "admin" (SPEC 13.2)`);
    return true;
  }

  /** The v0.4 typed command table (P2 item 1, slice 1b): every ordinary handler runs the SHARED
   *  admission chokepoint ({@link serveGated}) and then delegates to the SAME op core the ctl
   *  door dispatches (checklist 8: one core, two thin doors). The resume/preservation family
   *  deliberately BYPASSES serveGated — exactly as it sits before {@link admitControl} on the ctl
   *  door (those ops must run while `resumeRequired` fences ordinary work) — riding its own state
   *  fences; its ep gate is the admin-grade `manager.admin` capability grant (the 1b rule: static
   *  admin-class commands are capability-gated + untargeted, never a fabricated ledger mode).
   *
   *  TIER SEMANTICS on the ep door (the 1c grant-migration table): the tier lives in the CALLER'S
   *  GRANT, refined per-op exactly as the ctl doors refine their subject tier. Owner-mode
   *  `despawn`/`attach` keep the privileged semantics (`admin=false`, own-domain via
   *  {@link authorizeNamed}) — every spawn-capable agent holds those rows. ANY-mode requests are
   *  the operator instrument's cross-agent reach (rev 3): the any-mode subject row is mintable
   *  only under operator policy (§13.2), so on a static mesh holding it IS the admin tier, and in
   *  user mode the caller's CURRENT ledger scope must still carry `admin`
   *  ({@link epAdminReach}, the same fresh-read authority `psOwnerFilter` consults). The
   *  `manager.admin` family (purge + the resume/preservation ops) is capability-gated at mint AND
   *  re-checked at serve time via {@link epAdminReach} (the `adminGated` wrapper) so a user's
   *  revoked scope demotes the next call. `launch` is OWNER-EQUALITY on this door for everyone
   *  (freelance HIGH #2): the deploy path is its only consumer and stamps the caller's own owner,
   *  so cross-owner launch was a ctl-tier incidental never exercised, and keying it on the actor's
   *  ledger scope broke the deployer-view attenuation - uniform owner-equality is the safe tier.
   *  TWO DELIBERATE NARROWINGS vs the ctl doors (NOT bit-exact parity, panel-accepted): (1)
   *  `define-persona` is `admin=false` for everyone (own-persona discipline; no ep consumer needs
   *  cross-owner persona writes - an operator redefines via config, not the wire), where the ctl
   *  admin tier allowed operator cross-owner redefine; (2) launch is owner-equality-only, above.
   *  Both are least-privilege reductions, never widenings. */
  private managerServiceDefs(): EpCommandDef[] {
    const args = (ctx: EpServeContext): Record<string, unknown> => (ctx.request.args ?? {}) as Record<string, unknown>;
    const callerOf = (ctx: EpServeContext): string => principalKey(ctx.subject.caller.owner, ctx.subject.caller.actor).key;
    // A ctl-core failure reply becomes the §13.3 structured error the serve boundary publishes.
    // The data half of a failure reply (e.g. a degraded resume result) rides the error MESSAGE
    // only — the item-2 action model gives failures a typed channel.
    const unwrap = (r: ControlReply): unknown => {
      if (!r.ok) throw new EpEnvelopeError("failed-precondition", r.error ?? "the operation failed");
      return r.data;
    };
    // The admin-family serve gate (1c.2c, security4's hardening): every `manager.admin`-class
    // command re-checks operator reach AT SERVE TIME - static: true (the mint boundary already
    // gates the rows to instruments); user mesh: the caller's CURRENT ledger scope must still
    // carry `admin` ({@link epAdminReach}'s fresh read), so a revoked scope demotes the very next
    // call instead of riding the bearer's remaining JWT-row lifetime. The resume family keeps its
    // serveGated BYPASS (those ops must run while the maintenance fence holds) but not the gate.
    const adminGated = async <T>(ctx: EpServeContext, fn: () => T | Promise<T>): Promise<T> => {
      if (!(await this.epAdminReach(callerOf(ctx))))
        throw new EpEnvelopeError("permission-denied", `${ctx.subject.command} is operator reach; the caller's current ledger grant does not carry "admin" (SPEC 13.2)`);
      return fn();
    };
    const targetAgent = (ctx: EpServeContext): ManagedAgent => {
      const t = ctx.request.target!; // targeted commands only: the serve boundary enforced body-target presence + fresh currency
      const a = this.findManagedByTarget(t);
      if (!a) throw new EpEnvelopeError("expired", `target ${t.owner}.${t.actor} (lifecycle ${t.lifecycleUid}) is not a live managed agent of this manager`);
      return a;
    };
    return managerCommandDefs({
      status: (ctx) => this.serveGated(ctx, () => this.managerStatusData()),
      ps: (ctx) => this.serveGated(ctx, async () => this.list(await this.psOwnerFilter(callerOf(ctx), false))),
      inspect: (ctx) => this.serveGated(ctx, async () => {
        const name = String(args(ctx).name ?? "").trim();
        const row = this.list(await this.psOwnerFilter(callerOf(ctx), false)).find((x) => x.name === name);
        if (!row) throw new EpEnvelopeError("not-found", `no agent "${name}"`);
        return row;
      }),
      models: (ctx) => this.serveGated(ctx, async () => {
        const data = unwrap(await this.opModels(args(ctx)));
        return { catalogs: Array.isArray(data) ? data : [data] };
      }),
      // P2 item 2: `spawn` is an ACTION - accept a goal + reply the acceptance floor payload, drive
      // progress + terminal off-handler (no ~30s block). The blocking reply path is gone (pin 8).
      spawn: (ctx) => this.serveGated(ctx, () => this.serveSpawnGoal(ctx, (h) => this.opStart(args(ctx), callerOf(ctx), h))),
      despawn: (ctx) => this.serveGated(ctx, async () => {
        const a = targetAgent(ctx);
        const denied = await this.authorizeNamed(a, callerOf(ctx), await this.epAnyModeAdmin(ctx));
        if (denied) throw new EpEnvelopeError("permission-denied", denied);
        return unwrap(this.despawnAuthorized(a, args(ctx).graceful !== false, true));
      }),
      attach: (ctx) => this.serveGated(ctx, async () => {
        const a = targetAgent(ctx);
        const denied = await this.authorizeNamed(a, callerOf(ctx), await this.epAnyModeAdmin(ctx));
        if (denied) throw new EpEnvelopeError("permission-denied", denied);
        return unwrap(await this.attachAuthorized(a, ctx.subject.caller));
      }),
      stopSelf: (ctx) => this.serveGated(ctx, () => unwrap(this.opStopSelf(callerOf(ctx), args(ctx)))),
      definePersona: (ctx) => this.serveGated(ctx, () => unwrap(this.opDefinePersona(args(ctx), callerOf(ctx), false))),
      purge: (ctx) => this.serveGated(ctx, () => adminGated(ctx, async () => unwrap(await this.opPurge(args(ctx), callerOf(ctx))))),
      // launch is OWNER-EQUALITY on the ep door for every caller (freelance HIGH #2): the deploy
      // path is the only launch consumer and its spec stamps the CALLER's own owner, so
      // owner-equality always holds for a legitimate deploy; cross-owner launch was a ctl
      // admin-tier INCIDENTAL never exercised by a real flow (static is single-owner, so the flag
      // is a no-op there). Keying admin on epAdminReach read the ACTOR's ledger scope, which does
      // NOT reflect the deployer VIEW's privileged-tier attenuation - an admin user's stolen
      // deployer bearer would then bypass owner-equality (operator launch) despite the view holding
      // no admin rows. Uniform owner-equality removes that divergence in the least-privilege
      // direction (consistent with the delta-(b) tier narrowing the panel endorsed).
      // P2 item 2 (ruling 3): manifest `launch` is an ACTION through the SAME chokepoint as spawn -
      // the manifest resolve + owner-equality authz run in opLaunch's accept path, then the goal
      // drives progress + terminal. The acceptance floor is the allocated identity + goal coords.
      launch: (ctx) => this.serveGated(ctx, () => this.serveSpawnGoal(ctx, (h) => this.opLaunch(args(ctx), callerOf(ctx), false, h))),
      resumePreserved: (ctx) => adminGated(ctx, async () => unwrap(await this.opResumePreserved(args(ctx)))),
      commitResume: (ctx) => adminGated(ctx, async () => unwrap(await this.opCommitResume(args(ctx)))),
      finalizeResume: (ctx) => adminGated(ctx, async () => unwrap(await this.opFinalizeResume(args(ctx)))),
      preparePreservation: (ctx) => adminGated(ctx, async () => unwrap(await this.opPreservationCtl("preparePreservation", args(ctx)))),
      commitPreservation: (ctx) => adminGated(ctx, async () => unwrap(await this.opPreservationCtl("commitPreservation", args(ctx)))),
      abortPreservation: (ctx) => adminGated(ctx, async () => unwrap(await this.opPreservationCtl("abortPreservation", args(ctx)))),
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
        return `${entry.name}: ${(e as Error).message}`;
      }
    }));
    const drift = authority.filter((error): error is string => error !== undefined);
    if (drift.length)
      return { ok: false, error: `resume attempt ${attemptId} retained authority changed before commit: ${drift.join("; ")}` };
    let inactive: string[];
    try {
      inactive = this.resumeLivenessErrors(inventory, this.ep.getRoster());
    } catch (e) {
      return { ok: false, error: `resume attempt ${attemptId} cannot verify live principals: ${(e as Error).message}` };
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
   *  holds `admin`, read fresh. The policy is the pure
   *  {@link authorizeNamedControl}; this wrapper only binds the manager's state (the mode flag +
   *  the provider-backed ledger read — a build with no provider authorizes nothing extra,
   *  fail-closed via the policy's catch). Error string when denied, `undefined` when allowed. */
  private authorizeNamed(target: ManagedAgent, caller: string, admin: boolean): Promise<string | undefined> {
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
        inactive.push(`${entry.name} runtime status failed: ${(e as Error).message}`);
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
  private opStopSelf(callerId: string, args: Record<string, unknown>): ControlReply {
    const target = [...this.agents.values()].find((a) => this.managedPrincipal(a) === callerId);
    if (!target) return { ok: false, error: `self-stop: caller ${callerId} is not a managed agent` };
    const graceful = args.graceful !== false;
    this.stopHandle(target, graceful);
    this.trackStoppedHandle(target, true);
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
   *  BEST-EFFORT / never throws (#159 B2): a runtime hard-stop CAN throw (tmux `closeWindow` / cmux
   *  `closeWorkspace` are direct calls), and every caller (despawn / self-stop / reap / shutdown) frees the
   *  slot + deprovisions RIGHT AFTER — so a throwing stop must not abort that cleanup and leak the agent's
   *  footprint, nor (in `reapChildrenOf`) abort the reap of later siblings. The failure is logged loudly,
   *  never swallowed silently. Being the single stop chokepoint, guarding here covers all callers at once. */
  private stopHandle(a: ManagedAgent, graceful: boolean): void {
    // The F5 TERMINALIZING latch (Unit B): flipped SYNCHRONOUSLY, before any await anywhere on
    // this stop path — from here this principal's control ops refuse and no credential renews.
    a.terminalizing = true;
    try {
      if (graceful && process.platform === "win32" && a.control) controlShutdown(a.control);
      a.handle.stop({ graceful });
    } catch (e) {
      console.error(`stop ${a.name} (${a.id}): ${(e as Error).message}`);
    }
  }

  /** Keep an accepted stop inside the lifecycle drain until the runtime proves the child is gone,
   * so a maintenance prepare can never fence ahead of a child that is still dying.
   *
   * An operator-accepted stop frees its slot at once: `stop` replying ✓ means `ps` no longer lists
   * the agent. That cannot omit a still-live child from a cut, because runPreparation drains the
   * lifecycle BEFORE it reads the roster — the exit proof below is what closes the race, not the
   * slot lingering. A recursive reap (`requireAuthoritativeExit`) instead keeps the slot until the
   * wait proves exit: nobody asked for those children to be gone, so they stay managed until the
   * runtime says otherwise, and a runtime that cannot prove exit records an unverified stop. */
  private trackStoppedHandle(a: ManagedAgent, floor: boolean, requireAuthoritativeExit = false): void {
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
      this.freeSlot(a, floor, true);
      return;
    }
    if (!requireAuthoritativeExit) this.freeSlot(a, floor, true);
    this.lifecycleInFlight++;
    void this.awaitHandleExit(a.handle)
      .then(() => this.freeSlot(a, floor, true)) // no-op once an accepted stop already freed it
      .catch((e) => {
        this.unverifiedStops.push({
          name: a.name,
          id: a.id,
          handle: a.handle,
          authoritative: true,
          error: `accepted stop could not prove exit: ${(e as Error).message}`,
        });
      })
      .finally(() => this.releaseLifecycle());
  }

  /** USER-MODE spawn provisioning (the gate-1 counterpart to the static mint block): resolve the
   *  OWNER (ctl caller's principal, or the manifest's stamped owner — never a payload field),
   *  pre-create the principal-keyed durables + ACL row on the ephemeral provisioner, author the
   *  ledger grant (the upsert ROTATES the per-agent secret on every start — a non-running agent
   *  never holds a standing mint secret), materialize the 0600 secret/sentinel files, and
   *  PREFLIGHT the bearer chain once — the spawned agent must never be the first to discover a
   *  dead auth plane. Every failure is returned as the refusal sentence, with the grant + files
   *  rolled back. */
  private async provisionUserAgent(
    name: string,
    opts: {
      spawner?: string;
      specOwner?: string;
      subscribe?: string[];
      allowSubscribe: string[];
      allowPublish?: string[];
      role?: string;
      capabilities?: string[];
      label: string;
      /** The incarnation's lifecycle UID: recorded on the ledger row (the callout mints the agent's
       *  lifecycle-keyed grants from it) AND used for the provisioned durables/ACL row, so the
       *  credential names and the broker footprint can never diverge. */
      lifecycleUid: string;
    },
  ): Promise<{ owner: string; files: { actorToken: string; sentinelCreds: string; health: string }; launch: { owner: string; actor: string; sentinelCredsPath: string; bearerCmd: string[] } } | { error: string }> {
    const spawnerPr = opts.spawner ? parsePrincipalKey(opts.spawner) : null;
    const owner = opts.specOwner ?? (spawnerPr && spawnerPr.owner.startsWith("u_") ? spawnerPr.owner : undefined);
    if (!owner)
      return {
        error: `user-auth space "${this.space}": no owner for this spawn - call it from a user-mode session (\`cotal login\` then \`cotal spawn\`), or apply a manifest as a logged-in operator`,
      };
    let provider;
    try {
      provider = resolveAuthProvider();
    } catch (e) {
      return { error: (e as Error).message };
    }
    const dir = userAuthStateDir(this.workspaceRoot, this.space);
    // The agent's capability scope rides its ledger row (act.scope in every bearer) — same
    // vocabulary as static capabilities; the broker maps them to the ctl tiers. `role:<r>` tokens
    // pass through too (a persona may hold delegable roles) — the ledger's envelope walk still
    // attenuates every one of these against the spawner chain.
    const scope = (opts.capabilities ?? []).filter((c) => c === "spawn" || c === "admin" || /^role:[A-Za-z0-9_-]+$/.test(c));
    // The manager's ONE store (injected for a hosted composition, workstation FS locally). A hosted
    // user-mode spawn reads the callout material from it — the same store the auth-store kinds
    // (callout/issuer/…) were migrated onto — so this is no longer a local-only path.
    const secrets = this.secrets;
    // LIFECYCLE-KEYED family (SPEC 13.1 name-disjointness on the FS): this incarnation's files
    // embed its uid, so no teardown addressed to another incarnation can ever reach them.
    const files = agentLifecycleSecretFilePaths(this.workspaceRoot, name, opts.lifecycleUid);
    const { actorToken: tokenPath, sentinelCreds: sentinelPath, health: healthPath } = files;
    try {
      // The GRANT first — it is the envelope-rule enforcement point (a delegation must sit within
      // the spawner's own grant), so a refused delegation exits here having touched nothing beyond
      // the ledger: no durables, no broker footprint, nothing for a corrected respawn to race.
      const grant = await provider.grantAgent({
        store: secrets,
        dir,
        space: this.space,
        owner,
        actor: name,
        scope,
        allowSubscribe: opts.allowSubscribe,
        allowPublish: opts.allowPublish ?? [],
        role: opts.role,
        parent: spawnerPr ? opts.spawner : undefined,
        label: opts.label,
        lifecycleUid: opts.lifecycleUid,
      });
      // Durables + ACL row, LIFECYCLE-keyed (SPEC 13.1) — the same onboarding as static agents minus
      // the mint (a user agent's credential is its bearer, minted by the callout per connect from the
      // ledger row's recorded lifecycleUid — the same value provisioned here).
      await this.withProvisioner((prov) =>
        provisionAgentDurables(prov, { owner, actor: name, lifecycleUid: opts.lifecycleUid }, {
          subscribe: opts.subscribe,
          allowSubscribe: opts.allowSubscribe,
          role: opts.role,
        }),
      );
      // The store holds the source of truth; the bearer re-exec (`--token-file`) and the launch's
      // sentinel handoff read FILES, so materialize both at the canonical paths (under the local
      // FS composition, a byte-identical rewrite of the keys' own locations).
      await secrets.put(agentSecretKeyForFile(tokenPath), grant.actorToken);
      await secrets.put(agentSecretKeyForFile(sentinelPath), grant.sentinelCreds);
      await materializeSecretToFile(secrets, agentSecretKeyForFile(tokenPath), tokenPath);
      await materializeSecretToFile(secrets, agentSecretKeyForFile(sentinelPath), sentinelPath);
      rmSync(healthPath, { force: true }); // a fresh start opens a fresh health window
      const bearerCmd = [
        // The manager's own invocation prefix (node + loader flags + the cotal entry) — the agent
        // process execs this argv for every bearer, so it must resolve from ANY cwd. Correct
        // whenever the manager runs under a real `cotal` entry (supervise/up); a test constructing
        // Manager directly never reaches this branch (user meshes boot through the CLI).
        process.execPath,
        ...process.execArgv,
        process.argv[1],
        provider.agentBearerCommand,
        "--dir", dir,
        "--space", this.space,
        "--owner", owner,
        "--actor", name,
        "--token-file", tokenPath,
        "--health-file", healthPath,
      ];
      await execBearerPreflight(bearerCmd);
      return { owner, files, launch: { owner, actor: name, sentinelCredsPath: sentinelPath, bearerCmd } };
    } catch (e) {
      // Roll back everything this attempt materialized — a refused spawn must leave no standing
      // secret, no ledger row, no durable footprint — and AWAIT the broker teardown: the caller
      // may respawn the moment it reads the refusal, and a detached teardown would race (and
      // delete) that fresh spawn's just-provisioned durables.
      await provider.revokeAgent({ dir, owner, actor: name }).catch(() => {});
      await secrets.delete(agentSecretKeyForFile(tokenPath)).catch(() => {});
      await secrets.delete(agentSecretKeyForFile(sentinelPath)).catch(() => {});
      rmSync(tokenPath, { force: true });
      rmSync(sentinelPath, { force: true });
      rmSync(healthPath, { force: true });
      await this.deprovision({ id: principalKey(owner, name).key, name, lifecycleUid: opts.lifecycleUid, userOwner: owner, secretPaths: files }).catch((err) =>
        console.error(`rollback deprovision ${name}: ${(err as Error).message}`));
      return { error: `agent auth preflight failed for "${name}": ${(e as Error).message}` };
    }
  }

  /** Drop a live agent's slot. When `floor` is set and the agent died young (lived less than
   *  MIN_LIFETIME), push a cooling stamp so the freed slot still counts toward the ceiling until it
   *  expires — flooring the RECYCLE, not the call, so both free paths (despawn + exit/reap) are
   *  covered (P4c). Floor self + own-child despawn and natural exit; NEVER admin despawn (operator
   *  emergency-kill stays unthrottled) and NEVER the reserved-rollback path (no cold-start paid). */
  private freeSlot(a: ManagedAgent, floor: boolean, acceptedBeforeFence = false): void {
    if (this.agents.get(a.name) !== a) return; // already freed (exit raced despawn, etc.)
    a.terminalizing = true; // F5 latch (Unit B): also covers exit/reap paths that never rode stopHandle
    this.agents.delete(a.name);
    // P2 item 6 (pin 4): end any live §13.6 attach session bound to THIS incarnation with the honest
    // `target-despawn` reason. Fires once per agent on every free path (despawn / self-stop / reap /
    // exit) via the `agents` guard above; a no-op when no plane or no live session for the target.
    this.sessionPlane?.endForTarget(a.name, a.lifecycleUid, "target-despawn");
    if (floor && Date.now() - a.startedAt < MIN_LIFETIME) this.cooling.push(a.startedAt + MIN_LIFETIME);
    // #29 piece 3: on a USER mesh the name is RESERVED PENDING RETIREMENT — despawn started this
    // lifecycle's FULL teardown (footprint + standing-authority revoke + the auth-side retirement),
    // and the alias frees only when all of it completes (not the retirement alone). The detached
    // deprovision below drives it; a failed revoke or an unreachable rail keeps the name held,
    // re-driven by a retry. Gate on userMode BY
    // CONSTRUCTION (NEW-1): a static-auth mint has no user-mode lifecycle head to retire, so the
    // reservation + rail request simply don't apply there (the incidental nkey-parse used to mask
    // this, but the intent is "user mode only", not "any principal-shaped id").
    if (this.userMode) {
      const p = parsePrincipalKey(a.id);
      if (p) this.retiring.set(a.name, { opId: retireOpId(a.lifecycleUid), lifecycleUid: a.lifecycleUid, owner: p.owner, actor: p.actor, agentId: a.id, userOwner: a.userOwner, secretPaths: a.secretPaths, startedAt: Date.now() });
    } else if (this.auth) {
      // Unit B: a STATIC lifecycle now also holds its name pending its own terminal (the F1
      // static retirement the detached deprovision below drives) — the alias frees only when the
      // gate+head terminal completes, exactly the user-mode discipline. The wire principal is the
      // incarnation-unique nkey (F5-bind); owner is the dev owner.
      this.retiring.set(a.name, { opId: retireOpId(a.lifecycleUid), lifecycleUid: a.lifecycleUid, owner: DEV_OWNER, actor: a.id, agentId: a.id, secretPaths: a.secretPaths, startedAt: Date.now() });
    }
    // Auth mode: tear down the departed agent's minted broker footprint + creds file (#159 B2). The
    // process is already gone, so this must never block the slot free or throw into the caller — it runs
    // detached, and a failure is logged loudly (never swallowed), not retried. The `agents` guard above
    // makes this fire exactly once per agent across every free path (despawn / self-stop / reap / exit).
    if (!a.suppressCleanup && (this.maintenanceState === "active" || acceptedBeforeFence))
      this.trackDeprovision(a);
  }

  /** Tear down a departed agent's minted footprint (#159 B2, auth mode): its local-principal durables
   *  (`dm_local-<id>`, `dlv_local-<id>`), its read-ACL row, and its creds file — everything the spawn's
   *  `provisionAgent` + creds-write left behind. Mints an EPHEMERAL, TARGET-PINNED `deprovisioner` cred
   *  (mirrors the ephemeral `provisioner`/`purger`): it can delete only THIS agent's local-principal footprint,
   *  never a peer's and never the role-shared `svc_<role>` (which its siblings still bind). Open mesh →
   *  no-op (nothing was minted). Idempotent at the broker (missing consumer / ACL row = no-op) and on
   *  disk (`force` tolerates an absent creds file, e.g. a ledgered deploy that wrote none).
   *
   *  Removing the creds file is footprint REDUCTION, not revocation: a JWT copied off disk before exit
   *  keeps its inline publish/live-sub/control grants until key rotation or JWT expiry — cred revocation
   *  is the separate per-user-auth work, not this. Tearing down the durables + ACL row still shrinks the
   *  delivery surface a stale copy could use. */
  private async deprovision(a: { id: string; name: string; lifecycleUid: string; userOwner?: string; secretPaths?: ManagedAgent["secretPaths"] }): Promise<void> {
    if (!this.auth) return; // open mesh mints no creds/durables — nothing to tear down
    // SINGLE-FLIGHT per (name, lifecycleUid) (INT-2/C): join an in-flight teardown for this exact
    // lifecycle rather than launching a second concurrent one whose delayed name-keyed revoke could
    // outlive the hold-clear and delete a successor's row. A fresh trigger after settle re-drives.
    const key = JSON.stringify([a.name, a.lifecycleUid]); // ASCII-safe, delimiter-collision-free
    const inflight = this.deprovisioningFlight.get(key);
    if (inflight) return inflight;
    const flight = this.driveDeprovision(a).finally(() => {
      if (this.deprovisioningFlight.get(key) === flight) this.deprovisioningFlight.delete(key);
    });
    this.deprovisioningFlight.set(key, flight);
    return flight;
  }

  /** The actual footprint teardown (wrapped by {@link deprovision}'s single-flight). */
  private async driveDeprovision(a: { id: string; name: string; lifecycleUid: string; userOwner?: string; secretPaths?: ManagedAgent["secretPaths"] }): Promise<void> {
    if (!this.auth) return; // guaranteed by deprovision; re-checked for the deprovisionBroker narrowing
    if (!this.userMode && !a.userOwner) {
      // Unit B: a STATIC lifecycle retires through the F1 terminal barrier — freeze → head
      // retiring → B1 ledger revoke → footprint cleanup (creds file + broker durables/ACL, INSIDE
      // the barrier) → gate retired → head retired → alias free. The eviction step is the process
      // kill the stop path already performed (static's best-effort eviction).
      return this.driveStaticRetirement(a);
    }
    // Drop the local creds file FIRST + unconditionally — it is a usable identity on disk, useless for a
    // departed agent, so it must not survive even if the broker teardown below fails or times out. The
    // teardown mints its OWN deprovisioner cred (not this file), so removing it early is independent.
    // Migrated kinds: the store delete is the authoritative removal; the rmSync clears the FS
    // materialization (a byte-identical no-op under the local composition, real once the manager
    // `secretStore` is a non-FS store).
    //
    // LIFECYCLE-OWNED (SPEC 13.1, the manager-local half): the family deleted here is the RECORDED
    // one (spawn/adoption), else the lifecycle-keyed derivation for THIS uid — never a name-only
    // derivation, so a stale/replayed teardown addresses only names a same-alias successor never
    // uses. It deliberately CANNOT remove a name-keyed family it holds no record of (an operator's
    // standing `cotal mint` cred, a seeded workstation cred, a pre-split leftover): deleting an
    // unowned same-name file is the exact successor-clobber this ownership discipline removes.
    const secrets = this.secrets;
    const files = a.secretPaths ?? agentLifecycleSecretFilePaths(this.workspaceRoot, a.name, a.lifecycleUid);
    if (files.creds) {
      await secrets.delete(agentSecretKeyForFile(files.creds));
      rmSync(files.creds, { force: true });
    }
    if (a.userOwner) {
      // USER MODE: this teardown IS revocation, not just footprint reduction — the ledger row is
      // the agent's standing mint authority, so delete it (next exchange refused, next connect
      // denied) and shred the secret/sentinel/health files. A copied actor token dies here; a
      // still-LIVE connection ends at its bearer-bound JWT expiry (≤ the agent TTL).
      if (files.actorToken) await secrets.delete(agentSecretKeyForFile(files.actorToken));
      if (files.sentinelCreds) await secrets.delete(agentSecretKeyForFile(files.sentinelCreds));
      for (const f of [files.actorToken, files.sentinelCreds, files.health]) if (f) rmSync(f, { force: true });
      // The ledger row IS the agent's STANDING mint authority (a different store from the auth-plane
      // cred ledger the rail retirement covers): while it lives, a copied actor token can still mint a
      // fresh connect credential. So a FAILED revoke must NOT be swallowed into a clean terminal (INT-2):
      // mark the standing authority live on the hold so the retirement can never free the name (a freed
      // name says "this lifecycle is fully gone" - false while the mint authority stands), and carry a
      // legible operator copy. A retry re-drives this whole teardown (the same-name-spawn nudge routes
      // through deprovision, not the rail alone), so the revoke is re-attempted, not stranded.
      const holdRevoke = this.retiring.get(a.name);
      if (holdRevoke && holdRevoke.lifecycleUid === a.lifecycleUid) holdRevoke.standingAuthorityLive = true;
      try {
        await resolveAuthProvider().revokeAgent({
          dir: userAuthStateDir(this.workspaceRoot, this.space),
          owner: a.userOwner,
          actor: a.name,
        });
        const done = this.retiring.get(a.name);
        if (done && done.lifecycleUid === a.lifecycleUid) done.standingAuthorityLive = false;
      } catch (e) {
        const h = this.retiring.get(a.name);
        if (h && h.lifecycleUid === a.lifecycleUid)
          h.lastError = `the agent's standing mint authority could not be revoked (${(e as Error).message}); the name stays held so a copied actor token cannot mint fresh credentials. NEXT: a same-name spawn re-drives the full teardown (including the revoke), or recover the auth state.`;
        console.error(`revoke agent grant ${a.name}: ${(e as Error).message}`);
      }
    }
    await this.deprovisionBroker(a);
    // #29 piece 3: after the footprint teardown, ask the AUTH plane to RETIRE the lifecycle over
    // the auth-admin rail. The rail re-checks the space-manager lease at serve time; the terminal
    // (or an already-retired answer) clears the name reservation. Failures keep the hold with
    // their operator copy — legible, retryable, never a silent half-state.
    await this.requestRetirement(a);
  }

  /** Request the auth-side retirement of a departed agent's lifecycle (#29 piece 3): an ephemeral
   *  `retirement-requester` credential (request + reply only), the generic `retireLifecycle` op,
   *  a STABLE opId (derived from the lifecycleUid, so every retry re-drives the SAME operation),
   *  and the four-outcome handling in operator vocabulary. */
  private async requestRetirement(a: { id: string; name: string; lifecycleUid: string }): Promise<void> {
    if (!this.userMode) return; // NEW-1: lifecycle retirement is a user-mesh concept; a static mint has no head to retire
    // SINGLE-FLIGHT per (name, lifecycleUid) (audit #1): the detached deprovision call and every
    // same-name-spawn nudge for THIS lifecycle share ONE in-flight retirement, so concurrent triggers
    // never stack independent rail requests that dual-enter runAgentRetirementBarrier. Keyed by
    // (name, uid), NOT name alone: driveRetirement clears the hold on rail ok but then yields at
    // `nc.close()` with the flight still stored, so the alias can free and a SUCCESSOR (new uid) spawn.
    // A name-only key would let that successor's own teardown JOIN the predecessor's still-pending
    // flight and never send its OWN retirement — leaving the successor's lifecycle unretired. The uid in
    // the key gives the successor a disjoint flight (mirrors {@link deprovisioningFlight}). A fresh
    // trigger after settle re-drives (a still-present hold => retirement not yet confirmed).
    const key = JSON.stringify([a.name, a.lifecycleUid]);
    const inflight = this.retiringFlight.get(key);
    if (inflight) return inflight;
    const flight = this.driveRetirement(a).finally(() => {
      if (this.retiringFlight.get(key) === flight) this.retiringFlight.delete(key);
    });
    this.retiringFlight.set(key, flight);
    return flight;
  }

  /** The rail round-trip for one retirement (wrapped by {@link requestRetirement}'s single-flight). */
  private async driveRetirement(a: { id: string; name: string; lifecycleUid: string }): Promise<void> {
    if (!this.auth) return; // guaranteed by requestRetirement; re-checked for the type narrowing below
    const held = this.retiring.get(a.name);
    const me = parsePrincipalKey(this.ep.ref().id);
    const target = parsePrincipalKey(a.id);
    if (!me || !target) {
      if (held) held.lastError = "the manager or target principal could not be derived; the retirement was not requested";
      return;
    }
    const uncertain = (why: string) =>
      `the despawn stopped "${a.name}", but the retirement's completion could NOT be confirmed (${why}). The name stays held - not failed, not done - and a same-name spawn re-drives the same teardown; the auth service also finishes any started retirement on its next boot. NEXT: if the auth rail stays unreachable, recover the stack (\`cotal supervise\`), then re-attempt the same-name spawn.`;
    try {
      const creds = await mintCreds(this.auth, newIdentity(), "retirement-requester", { retirementRequester: { owner: me.owner, actor: me.actor } });
      const nc = await connect({ servers: this.servers ?? DEFAULT_SERVER, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), maxReconnectAttempts: 0 });
      try {
        const subject = controlServiceSubject(this.space, CONTROL_AUTH_ADMIN, me.owner, me.actor);
        const m = await nc.request(
          subject,
          // P2 item 3 (3b-3): declare THIS manager instance's current serve identity so the rail's
          // holder check is registration-record-derived (the serve-issuance gate), not a name-derived
          // "the manager". A superseded predecessor (same instanceId, OLD epoch after a restart) is
          // then refused at the rail — its declared epoch no longer matches the gate's current one.
          JSON.stringify({ op: "retireLifecycle", args: {
            owner: target.owner, actor: target.actor, lifecycleUid: a.lifecycleUid, opId: retireOpId(a.lifecycleUid),
            serveEndpoint: MANAGER_ENDPOINT, serveInstanceId: this.managerInstanceId, serveEpoch: this.serviceServe?.grant.epoch ?? 0,
          } }),
          { timeout: 20_000, noMux: true, reply: `${subject}.reply.${randomUUID()}` },
        );
        const r = m.json<{ ok: boolean; data?: unknown; error?: string }>();
        if (r.ok) {
          // CAS the hold clear (audit #1 ABA): free the alias ONLY if the current hold is still THIS
          // lifecycle's - a late reply for a retired predecessor must never clear a successor's newer hold.
          const cur = this.retiring.get(a.name);
          if (cur && cur.lifecycleUid === a.lifecycleUid) {
            if (cur.standingAuthorityLive) {
              // INT-2: the auth-plane lifecycle retired, but the manager-side STANDING mint authority is
              // not yet revoked (a failed revoke). Freeing the name here would be a false terminal (a
              // copied token could still mint), so keep the hold with its revoke-failure copy; a retry
              // re-drives the full teardown (revoke included).
              console.error(`despawn ${a.name}: the auth-plane lifecycle retired, but the standing mint authority is not yet revoked; the name stays held. ${cur.lastError ?? ""}`);
            } else {
              this.retiring.delete(a.name);
              console.error(`despawn ${a.name}: the agent's retirement completed; the name is free for reuse`);
            }
          } else {
            console.error(`despawn ${a.name}: retirement confirmed for a prior lifecycle of "${a.name}"; the current hold is left intact`);
          }
        } else {
          // The rail's refusal is already the operator copy (lease-loss/stale/foreign-op faces,
          // full-no-op statements included) - surface it INTACT, never flattened.
          if (held) held.lastError = r.error ?? "the auth service refused the retirement without a reason";
          console.error(`despawn ${a.name}: ${r.error ?? "the auth service refused the retirement without a reason"}`);
        }
      } finally {
        await nc.close().catch(() => {});
      }
    } catch (e) {
      const copy = uncertain((e as Error).message);
      if (held) held.lastError = copy;
      console.error(`despawn ${a.name}: ${copy}`);
    }
  }

  /** The teardown's ASYNC BROKER PHASE: mint the ephemeral target-pinned deprovisioner cred and
   *  delete the agent's broker footprint (dm_/dlv_ durables + read-ACL row). Split from
   *  {@link deprovision} because it runs LAST in the ordered teardown chain — after the creds/secret
   *  shred and the awaited ledger revoke, which precede it in that same single-flighted chain (the
   *  revoke is awaited and can be deliberately slow, so it is not merely a synchronous prefix). The name
   *  is NOT freed while any teardown phase is still in flight — the hold clears only after the
   *  standing-authority revoke AND the lifecycle retirement both confirm (see {@link driveRetirement}) —
   *  but the deletes here are still lifecycle-uid-pinned so even a replayed/stale teardown can never
   *  reach a same-name successor's footprint (its names embed a different uid). */
  private async deprovisionBroker(a: { id: string; name: string; lifecycleUid: string }): Promise<void> {
    // LIFECYCLE-PINNED (SPEC 13.1): both the credential's exact-name grants and the delete names
    // carry a.lifecycleUid, so a stale/replayed teardown for this retired incarnation is broker-denied
    // against a same-name successor's footprint (its names embed a different uid).
    const creds = await mintCreds(this.auth!, newIdentity(), "deprovisioner", {
      deprovisionTarget: { principal: a.id, lifecycleUid: a.lifecycleUid },
    });
    // Bound the detached broker teardown so a wedged broker can't leave the deprovision promise pending
    // forever with no log — the timeout rejects into freeSlot's fail-loud `.catch` (paired with the
    // helper's own fail-fast connect). The durables/ACL row still fall to space teardown as a backstop.
    await withTimeout(
      deprovisionAgent({ servers: this.servers ?? DEFAULT_SERVER, space: this.space, targetId: a.id, lifecycleUid: a.lifecycleUid, creds }),
      DEPROVISION_TIMEOUT_MS,
      `deprovision ${a.name} (${a.id}): broker teardown timed out`,
    );
  }

  /** Reap a parent's children on its exit (P4b). Every descendant remains managed until the runtime's
   * authoritative wait proves exit; the wait participates in the lifecycle drain, so preservation can
   * never omit a child that may still be alive. Recursive descendants are scheduled before their parent
   * slot can disappear. */
  private reapChildrenOf(parentId: string): void {
    for (const child of [...this.agents.values()]) {
      if (child.spawner !== parentId) continue;
      this.reapChildrenOf(this.managedPrincipal(child));
      this.stopHandle(child, false);
      this.trackStoppedHandle(child, true, true);
    }
  }

  /** A managed agent's process exited on its own (crash, /exit, finished). Free its slot
   *  (rate-floored — exit-driven churn counts) and reap any children it spawned. Idempotent via
   *  freeSlot's identity guard, so a later graceful-stop SIGKILL firing exit again is a no-op. */
  private onAgentExit(a: ManagedAgent): void {
    // Preservation owns the child-stop snapshot. Exit watchers must neither delete that snapshot nor
    // trigger normal deprovision/reap while the cut is being formed.
    if (this.maintenanceState !== "active") return;
    this.freeSlot(a, true);
    this.reapChildrenOf(this.managedPrincipal(a));
  }

  /** Agent names become `.cotal/agents/<name>.md` paths and mesh identities, so they must be bare
   *  tokens, never a path — blocks traversal / arbitrary writes from a model-supplied name. */
  private nameError(name: string): string | undefined {
    return /^[A-Za-z0-9_-]+$/.test(name)
      ? undefined
      : `unsafe name ${JSON.stringify(name)} (allowed: letters, digits, _ -)`;
  }

  /** First free name in the series `base`, `base-2`, `base-3`, … — checked against live slots,
   *  in-flight (reserved) slots, names held pending retirement, AND the live mesh roster. The
   *  roster check covers occupants this manager does not manage (a foreground `cotal spawn`, a
   *  connector session, another manager's agent): allocating their name would mint a sibling the
   *  broker/auth then refuses to admit, surfacing as a 30s launch-uncertain black hole instead of
   *  the auto-number the join path gives. Presence is ADVISORY (SPEC §6) — this is an availability
   *  choice at allocation, never an authority check (the broker still enforces): a stale
   *  still-live-looking row only costs a numbered suffix, and a missed freshly-joined occupant is
   *  still refused downstream exactly as before. Offline rows do NOT occupy — a properly retired
   *  name stays reusable. */
  /** The roster's LIVE occupant names (status !== offline) — occupants this manager may NOT manage
   *  (a foreground `cotal spawn`, a connector session, ANOTHER manager's agent). Allocating over any
   *  of them mints a sibling the broker/auth then refuses to admit, surfacing as the 30s launch-
   *  uncertain black hole. */
  private liveRosterNames(): Set<string> {
    const live = new Set<string>();
    for (const p of this.ep.getRoster()) if (p.status !== "offline") live.add(p.card.name);
    return live;
  }

  /** THE single name-liveness predicate both the hard-pinned collision refuse (M6, P2 item 2) and
   *  uniqueName's numbering consult, so they can never drift: a name is taken if this manager
   *  reserves/manages/retires it OR a roster-live occupant already holds it. Pass a pre-built
   *  {@link liveRosterNames} set when checking many names in one allocation. */
  private nameInUse(name: string, live: Set<string> = this.liveRosterNames()): boolean {
    return this.agents.has(name) || this.reserved.has(name) || this.retiring.has(name) || live.has(name);
  }

  private uniqueName(base: string): string {
    const live = this.liveRosterNames();
    return firstFreeName(base, (n) => this.nameInUse(n, live));
  }

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

  /** Parse an untyped control-plane `start` request into {@link StartAgentOpts}. */
  private opStart(args: Record<string, unknown>, caller: string, hooks?: SpawnHooks): Promise<ControlReply> {
    // `resume`, when present, must be a non-empty session id. An empty/whitespace value is a
    // malformed request, not an implicit "spawn fresh" (no fallbacks). The CLI surfaces reject it,
    // but a raw control message could otherwise slip an empty value through and silently start fresh.
    if (args.resume !== undefined && !String(args.resume).trim())
      return Promise.resolve({ ok: false, error: "resume: session id must not be empty" });
    if (args.variant !== undefined && !String(args.variant).trim())
      return Promise.resolve({ ok: false, error: "variant: must not be empty" });
    // Opaque launch options, when present, must be a mapping — a raw control message could send a
    // scalar/array (the CLI never does). Core doesn't interpret the keys; the connector validates them.
    if (args.launchOptions !== undefined && (typeof args.launchOptions !== "object" || args.launchOptions === null || Array.isArray(args.launchOptions)))
      return Promise.resolve({ ok: false, error: "launchOptions: expected a key:value mapping" });
    // ACL overrides arrive as string arrays or not at all — a malformed value is a bad request,
    // not something to coerce (no fallbacks).
    const strList = (v: unknown, flag: string): string[] | undefined => {
      if (v === undefined) return undefined;
      if (!Array.isArray(v) || v.some((s) => typeof s !== "string"))
        throw new Error(`${flag}: expected an array of strings`);
      return v as string[];
    };
    let subscribe: string[] | undefined, allowSubscribe: string[] | undefined, allowPublish: string[] | undefined;
    try {
      subscribe = strList(args.subscribe, "subscribe");
      allowSubscribe = strList(args.allowSubscribe, "allowSubscribe");
      allowPublish = strList(args.allowPublish, "allowPublish");
    } catch (e) {
      return Promise.resolve({ ok: false, error: (e as Error).message });
    }
    return this.startAgent(
      {
        name: String(args.name ?? "").trim(),
        agent: args.agent ? String(args.agent) : undefined,
        role: args.role ? String(args.role) : undefined,
        config: args.config ? String(args.config) : undefined,
        identity: args.identity ? String(args.identity) : undefined,
        model: args.model ? String(args.model) : undefined,
        variant: args.variant ? String(args.variant) : undefined,
        launchOptions: args.launchOptions as Record<string, unknown> | undefined,
        resume: args.resume ? String(args.resume) : undefined,
        events: typeof args.events === "boolean" ? args.events : undefined,
        cwd: args.cwd ? String(args.cwd) : undefined,
        prompt: args.prompt ? String(args.prompt) : undefined,
        subscribe,
        allowSubscribe,
        allowPublish,
        shareTools: args.shareTools !== undefined ? String(args.shareTools) : undefined,
      },
      caller,
      hooks,
    );
  }

  /** Resolve a connector by agent type. Library composition (installedExtensions off) → a registry
   *  hit, exactly as before (the composition root imported what it wants). The published binary gates
   *  on MANIFEST membership FIRST — so a live `cotal ext remove` is honored even though the registry
   *  still holds a connector imported earlier this session — then returns the registry hit or lazily
   *  imports the providing package (transactional + single-flight, via the workspace primitive).
   *  Fail-loud with an install hint; no fallback. */
  private async resolveConnector(name: string): Promise<Connector> {
    if (!this.installedExtensions) return registry.resolve<Connector>("connector", name);
    if (!manifestExtensionNames("connector").includes(name)) throw new Error(connectorInstallHint(name));
    const already = registry.all<Connector>("connector").find((c) => c.name === name);
    return already ?? materializeFromManifest<Connector>({ kind: "connector", name }, { hint: (ref) => connectorInstallHint(ref.name) });
  }

  /** Connector names the manager can spawn WITHOUT importing: the manifest on the published binary,
   *  else whatever a composition root registered. Drives the `models` catalog enumeration. */
  private connectorNames(): string[] {
    return this.installedExtensions ? manifestExtensionNames("connector") : registry.all<Connector>("connector").map((c) => c.name);
  }

  /** Return connector-provided model catalogs for selector UIs. Optional by connector: a host with no
   *  local model-list API reports `supported:false` rather than blocking the manager. A connector that
   *  fails to import shows an `error:` row (from manifest enumeration) and never blocks the others. */
  private async opModels(args: Record<string, unknown>): Promise<ControlReply> {
    const requested = String(args.agent ?? "").trim();
    const refresh = args.refresh === true;
    const one = async (connector: Connector): Promise<ConnectorModelCatalog> => {
      if (!connector.listModels) return { agent: connector.name, supported: false, models: [] };
      const missing = (connector.requires ?? []).filter((bin) => !resolveOnPath(bin));
      if (missing.length)
        return {
          agent: connector.name,
          supported: true,
          models: [],
          error: `${connector.name} harness needs ${missing.join(", ")} on PATH - not found`,
        };
      try {
        const catalog = await connector.listModels({ refresh });
        return { agent: connector.name, supported: true, ...catalog };
      } catch (e) {
        return { agent: connector.name, supported: true, models: [], error: (e as Error).message };
      }
    };

    if (requested) {
      let connector: Connector;
      try {
        connector = await this.resolveConnector(requested);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
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
          return { agent: name, supported: false, models: [], error: (e as Error).message };
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
  private async psOwnerFilter(caller: string, admin: boolean): Promise<string | undefined> {
    if (!this.userMode || admin) return undefined;
    const key = parsePrincipalKey(caller);
    if (!key) return NO_OWNER_MATCHES;
    try {
      const scope = await resolveAuthProvider().actorScope({
        dir: userAuthStateDir(this.workspaceRoot, this.space),
        owner: key.owner,
        actor: key.actor,
      });
      if (scope?.includes("admin")) return undefined;
    } catch {
      /* unreadable ledger authorizes nothing extra: fall through to the own-owner bound */
    }
    return key.owner;
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
  private async opLaunch(args: Record<string, unknown>, caller: string, admin: boolean, hooks?: SpawnHooks): Promise<ControlReply> {
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
        persistLaunchSpec(this.workspaceRoot, spec);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    } else {
      try {
        spec = launchSpecForRun(this.workspaceRoot, runId);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
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
      configPath = materializePersona(this.workspaceRoot, runId, la);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const reply = await this.startAgent(launchAgentToStartOpts(la, configPath, spec.owner, runId), caller, hooks);
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
  async startAgent(opts: StartAgentOpts, spawner?: string, hooks?: SpawnHooks): Promise<ControlReply> {
    const release = this.beginLifecycle();
    if (!release) return { ok: false, error: this.maintenanceError() };
    try {
      return await this.startAgentActive(opts, spawner, hooks);
    } finally {
      release();
    }
  }

  private async startAgentActive(opts: StartAgentOpts, spawner?: string, hooks?: SpawnHooks): Promise<ControlReply> {
    // The spawn argument is a persona REF — a filename in `.cotal/agents` (the unique spawn KEY), or
    // a path via `--config`. It is NOT the mesh identity: the identity comes from inside the file
    // (`name:`), so a persona can be filed descriptively (review-critic.md) yet present under a
    // free-form name (socrates) — the same model `cotal spawn` already uses. You always spawn by
    // filename (unique on disk); two files can't collide on the key.
    const ref = opts.name.trim();
    if (!ref) return { ok: false, error: "name required" };
    // A bare ref maps to `.cotal/agents/<ref>.md`, so it must be a safe token (no path traversal); a
    // `--config` path is validated by existsSync below instead.
    if (!opts.config) {
      const refErr = this.nameError(ref);
      if (refErr) return { ok: false, error: refErr };
    }
    const agent = opts.agent ?? defaultAgentType(DEFAULT_CONNECTOR);

    // Materialize the requested connector up front — the ONE async step in the spawn path (a lazy
    // `cotal ext` manifest import on the published binary). It runs BEFORE the capacity/reserve span
    // below so that span stays fully SYNCHRONOUS and atomic. On the manifest binary this also honors a
    // live `cotal ext remove`: a removed connector is rejected here even if an earlier spawn already
    // imported it. A broken/missing connector fails loud here with a clear name + install hint.
    let connector: Connector;
    try {
      connector = await this.resolveConnector(agent);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }

    // Capacity check first (cheap, fail-fast). Everything from here to the reserve below is
    // SYNCHRONOUS (existsSync / registry / accessSync / readFileSync — no await), so the gate stays
    // atomic: the capacity snapshot and the reserve land in one tick (P4a/P4c), and two concurrent
    // spawns can't overshoot the ceiling or pick the same name.
    const cooling = this.coolingCount(); // prune expired stamps, then count live cooling slots
    if (this.agents.size + this.reserved.size + cooling >= MAX_AGENTS)
      return { ok: false, error: `at capacity (${MAX_AGENTS} agents incl. in-flight + cooling); despawn one or wait` };

    // Resolve the persona file (fail loud — NO silent default-ACL fallback). A missing persona used
    // to mint DEFAULT creds (read `general` only, default-deny publish, no capabilities), so a
    // typo'd / renamed / spawned-by-display-name agent became live with silently-wrong ACLs — a
    // behavioral/security bug. Fail loud instead, matching `cotal spawn` (loadAgentFile throws).
    let configPath: string;
    if (opts.config) {
      configPath = agentFilePath(this.workspaceRoot, opts.config);
      if (!existsSync(configPath)) return { ok: false, error: `agent file not found: ${configPath}` };
    } else {
      configPath = agentFilePath(this.workspaceRoot, ref);
      if (!existsSync(configPath))
        return { ok: false, error: `no persona "${ref}" - ${configPath} not found; create it or pass --config (see \`cotal personas list\`)` };
    }

    // Harness preflight before reserving a slot or minting — a missing `claude`/`opencode` binary
    // fails here with a clear name, not obscurely at process spawn. No fallback. All synchronous, so
    // the reserve gate stays atomic. (The connector itself was resolved up top, before the capacity gate.)
    const missing = (connector.requires ?? []).filter((bin) => !resolveOnPath(bin));
    if (missing.length)
      return { ok: false, error: `${agent} harness needs ${missing.join(", ")} on PATH - not found` };
    // Resume is a connector capability: reject an unsupported resume HERE, before the reserve/mint, so
    // it can never provision creds + durables and then throw at buildLaunch (mint-then-orphan). Same
    // reject-before-side-effects window as the harness preflight above; buildLaunch stays the backstop.
    if (opts.resume && !connector.supportsResume)
      return { ok: false, error: `${agent} connector does not support resuming an existing session (resume)` };

    // Resolve the launch profile: IDENTITY (free-form `name:`) + role + read/post ACL + capabilities
    // + model/variant. Either from a fully-resolved manifest launch object (`opts.resolved`, whose `config`
    // is a materialized transient persona — the file is NOT the access authority), or from the
    // persona file. The number rides the IDENTITY (socrates → socrates-2), not the file ref — a
    // redelivered identical spawn yields a fresh numbered agent (MAX_AGENTS bounds the blast radius).
    let identityName: string;
    let role: string | undefined;
    let subscribe: string[] | undefined;
    let allowSubscribe: string[];
    let allowPublish: string[] | undefined;
    let capabilities: string[] | undefined;
    let model = opts.model;
    let variant = opts.variant;
    let launchOptions = opts.launchOptions;
    let prompt = opts.prompt;
    if (opts.resolved) {
      // A manifest launch is the access + identity authority: imperative overrides arriving
      // alongside `resolved` are a caller contract error, not something to merge (no fallbacks).
      if (opts.subscribe || opts.allowSubscribe || opts.allowPublish || opts.prompt || opts.shareTools || opts.identity)
        return { ok: false, error: "a manifest launch (resolved) rejects imperative overrides (identity/subscribe/allow*/prompt/shareTools)" };
      const r = opts.resolved;
      identityName = r.name;
      role = opts.role ?? r.role;
      subscribe = r.subscribe;
      allowSubscribe = r.allowSubscribe?.length ? r.allowSubscribe : r.subscribe;
      allowPublish = r.allowPublish;
      capabilities = r.capabilities;
      model = opts.model ?? r.model;
      variant = opts.variant ?? r.variant;
      launchOptions = mergeLaunchOptions(r.launchOptions, opts.launchOptions);
      prompt = r.prompt; // the guard above rejected an imperative prompt — one source

    } else {
      let def: AgentDef;
      try {
        def = loadAgentFile(configPath);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      // Identity: the `--name` override wins over the file's `name:` — foreground parity (there,
      // `requested = values.name ?? def.name`). The override is minted into the creds and rides
      // COTAL_NAME below, so the presence identity and its credential can't diverge.
      identityName = opts.identity ?? def.name;
      role = opts.role ?? def.role;
      // Flags > persona file — the same precedence as foreground `cotal spawn`, so the two launch
      // paths of the merged grammar can't diverge. One source feeds BOTH the minted creds and the
      // connector env below.
      subscribe = opts.subscribe ?? def.subscribe;
      // Defaulted the same way the loader/provisioner do — minted into the creds (the broker
      // boundary); runtime durable joins are re-authorized against the committed ACL by the daemon.
      allowSubscribe = opts.allowSubscribe ?? def.allowSubscribe ?? subscribe ?? ["general"];
      allowPublish = opts.allowPublish ?? def.allowPublish;
      capabilities = def.capabilities;
      variant = opts.variant ?? def.variant;
      launchOptions = mergeLaunchOptions(def.launchOptions, opts.launchOptions);
    }
    const idErr = this.nameError(identityName);
    if (idErr) return { ok: false, error: opts.resolved ? `launch agent: ${idErr}` : `persona ${configPath}: ${idErr}` };
    // The alias-reuse gate (#29 piece 3): a name whose previous agent is still retiring REFUSES
    // legibly (never a silent suffix), and the refusal re-drives the FULL durable teardown so
    // "retry the spawn" is also the nudge. It routes through `deprovision` (not `requestRetirement`
    // alone) so a retry re-drives the standing-authority revoke (INT-2) AND the broker cleanup before
    // any hold-clear (C): the alias must not free while the durable teardown or the revoke is still
    // outstanding. All the teardown ops are idempotent, and the rail request is single-flighted.
    const held = this.retiring.get(identityName);
    if (held !== undefined) {
      void this.deprovision({ id: held.agentId, name: identityName, lifecycleUid: held.lifecycleUid, userOwner: held.userOwner, secretPaths: held.secretPaths }).catch(() => {});
      return {
        ok: false,
        error: `the name "${identityName}" is reserved pending retirement: its previous agent's despawn started that lifecycle's teardown (footprint + standing-authority revoke + auth-side retirement), and the name frees only when all of it completes${held.lastError !== undefined ? ` (last attempt: ${held.lastError})` : ""}. NEXT: wait a moment and retry this spawn (retrying re-drives the whole teardown), or pick another name.`,
      };
    }
    if (variant && !connector.supportsModelVariant)
      return { ok: false, error: `${agent} connector does not support model variants (variant)` };

    // #4 A4 (panel): the roster the allocation consults must reflect the initial presence snapshot,
    // or a spawn immediately after manager boot races an already-live unmanaged peer and re-opens the
    // very collision black-hole this closes. Await the snapshot (bounded internally, fail-safe on an
    // empty mesh) before allocating; the broker/auth remain the authority downstream. Deliberately
    // unconditional: a half-wired endpoint without the seam must fail loud here, not silently
    // allocate off a pre-snapshot roster.
    await this.ep.waitForPresenceSnapshot();
    // M6 (P2 item 2 spawn-as-action): a HARD-PINNED name — an imperative `--name`/identity override
    // or a manifest-declared name (opts.resolved) — that collides with a LIVE/provisioning/reserved
    // incarnation REFUSES loud at accept, BEFORE any reserve/mint/bind (pin 1), never a silent `-2`
    // suffix (so an address-by-triple caller's pinned name can't be re-pointed). A PERSONA-DERIVED
    // base name (no pin) keeps uniqueName's collision numbering, so multi-peer `spawn reviewer` twice
    // still yields reviewer + reviewer-2. The retiring-hold refuse (~2472) is orthogonal and already fired.
    const hardPinned = opts.identity !== undefined || opts.resolved !== undefined;
    let name: string;
    if (hardPinned) {
      // The collision check consults THE SAME liveness source uniqueName uses ({@link nameInUse}:
      // this manager's agents/reserved/retiring PLUS the roster-live set) - a hard-pinned name
      // colliding with ANY live incarnation (managed, unmanaged foreground/connector, or another
      // manager's agent) refuses cleanly at accept, rather than minting the collision and black-
      // holing on the broker/auth refusal (item 3: a pinned name live under another manager MUST refuse).
      if (this.nameInUse(identityName))
        return { ok: false, error: `the name "${identityName}" is hard-pinned (${opts.resolved ? "manifest-declared" : "--name/identity override"}) but is already held by a live incarnation (managed here, an unmanaged foreground/connector session, or another manager's agent); a pinned same-name collision refuses at accept - pick another name or despawn the existing one` };
      name = identityName;
    } else {
      name = this.uniqueName(identityName);
    }
    this.reserved.add(name);
    // Transcript mirroring (opt-in: `--events` / COTAL_EVENTS_DEFAULT=1) → grant the agent pub
    // on its OWN transcript channel; auth-mode publish is default-deny, so without the grant the mirror's
    // publish is rejected. Ask the resolved connector for the channel — the SAME one it publishes to, so
    // the grant and the publish can't drift, and the literal stays out of core. Uses the spawned `name`
    // (post-uniqueName) so the grant matches the actual identity. Mirroring is OPTIONAL per connector
    // (like prompt): if it's requested for a connector that doesn't mirror, fail loud — never silently
    // skip the grant (that would surface later as a confusing auth-mode publish rejection).
    const events = opts.events ?? process.env.COTAL_EVENTS_DEFAULT === "1";
    if (events) {
      if (!connector.eventChannel) {
        this.reserved.delete(name); // release the just-reserved name on this fail-fast path
        return { ok: false, error: `connector "${connector.name}" does not support event publishing, but --events was requested` };
      }
      allowPublish = [...(allowPublish ?? []), connector.eventChannel(name)];
    }
    // F2 (Unit B): a STATIC managed spawn REFUSES endpoint capabilities, fail-closed IN CODE (not
    // a doc note): the static terminal has no obligation-drain/frontier steps yet, so an accepted-
    // but-uncompleted endpoint obligation could execute AFTER its uid is declared retired. The
    // refusal sits at spawn-accept, before any provisioning, over the same records a persona or
    // manifest self-claim would ride in on — capabilities cannot slip past it into the grant path.
    if (this.auth && !this.userMode) {
      const claims: Record<string, unknown>[] = [opts as unknown as Record<string, unknown>, (opts.resolved ?? {}) as unknown as Record<string, unknown>];
      if (claims.some((c) => c.endpointCapabilities !== undefined)) {
        this.reserved.delete(name);
        return { ok: false, error: "a static managed spawn refuses endpointCapabilities (Unit B F2): the static lifecycle terminal carries no obligation-drain/frontier steps, so endpoint-rail grants are not containable in static mode" };
      }
    }
    // Set once the agent's creds + durables are minted; cleared the moment a live slot takes ownership
    // (`agents.set`, after which freeSlot deprovisions on exit). If it survives to `finally`, the spawn
    // threw AFTER minting (buildLaunch / runtime.spawn) — tear the orphan down so no footprint leaks (#159 B).
    // Set once the agent's footprint (durables + creds, or the user-mode grant + secret files)
    // exists; cleared when a live slot takes ownership. If it survives to `finally`, the spawn threw
    // AFTER provisioning (buildLaunch / runtime.spawn) — the orphan-rollback tears it down. Carries
    // `userOwner` for a user-mode spawn so that rollback runs the revoke+shred branch, not just the
    // static durable teardown (the freelance found this window leaking the managed grant + files).
    let provisioned: { id: string; name: string; lifecycleUid: string; userOwner?: string; secretPaths?: ManagedAgent["secretPaths"] } | undefined;
    try {
      // A stable nkey identity assigned at spawn: the public key is the agent's card.id (threaded via
      // COTAL_ID); the seed is retained to mint matching creds later.
      const identity = newIdentity();
      // The incarnation's lifecycle UID (SPEC 13.1), minted ONCE per spawn: every lifecycle-keyed
      // broker resource (dm_/dlv_/chathist_ durables, ACL row, memberships) and the teardown
      // credential carry it, so a same-name successor's footprint is name-disjoint by construction.
      const lifecycleUid = mintLifecycleUid();
      // ACCEPT SEAM (P2 item 2 spawn-as-action): the incarnation identity is minted and NOTHING has
      // been provisioned yet — the action serve path binds the goal + replies the acceptance HERE. A
      // throw (bind conflict / duplicate goalId) aborts the spawn before provisioning: the catch below
      // returns the failure and the finally releases the reserve, so a refused accept leaves zero
      // footprint (pin 1). Blocking callers (roster boot) pass no hooks and this is a no-op.
      // The ALLOCATED agent's addressing triple (the acceptance floor names what was actually
      // allocated, never the requested-but-unallocated name). Static/open key on DEV_OWNER + the
      // freshly-minted nkey; user mode keys on the derived owner (opts.owner, else a u_-owner spawner)
      // + the alias — derived HERE where the mode and owner source are in scope.
      const agentTriple = this.userMode
        ? { owner: opts.owner ?? (spawner && parsePrincipalKey(spawner)?.owner.startsWith("u_") ? parsePrincipalKey(spawner)!.owner : DEV_OWNER), actor: name, uid: lifecycleUid }
        : { owner: DEV_OWNER, actor: identity.id, uid: lifecycleUid };
      await hooks?.onAccepted?.({ name, identity, lifecycleUid, agentTriple });
      // In auth mode, mint the agent's creds from the space signing key and write them where the
      // spawned session reads them (COTAL_CREDS path). Open mesh → no creds. Scope = the resolved
      // subscribe/allowSubscribe (read) + allowPublish (post, default-deny).
      let credsPath: string | undefined;
      let userLaunch: { owner: string; actor: string; sentinelCredsPath: string; bearerCmd: string[] } | undefined;
      let userOwner: string | undefined;
      if (this.userMode) {
        const prep = await this.provisionUserAgent(name, {
          spawner,
          specOwner: opts.owner,
          subscribe,
          allowSubscribe,
          allowPublish,
          role,
          capabilities,
          label: ref,
          lifecycleUid,
        });
        if ("error" in prep) {
          this.reserved.delete(name);
          return { ok: false, error: prep.error };
        }
        userLaunch = prep.launch;
        userOwner = prep.owner;
        provisioned = { id: principalKey(prep.owner, name).key, name, lifecycleUid, userOwner: prep.owner, secretPaths: prep.files };
      } else if (this.auth) {
        // Unit B (§13.1): reserve + activate this incarnation's DURABLE identity BEFORE any
        // broker footprint — the F3 outer spawn intent first (slot row, phase `provisioning`),
        // then the SHARED core activation saga (reserve uid -> gate frozen -> head CAS -> reopen
        // LAST) over the key-pinned executor. The wire AUTHORITY principal is the incarnation-
        // unique nkey (F5-bind); the alias is protected by the name-keyed slot + freeSlot hold.
        await this.withLifecycleExecutor({ owner: DEV_OWNER, actor: identity.id, lifecycleUid, alias: name }, (t) =>
          activateStaticLifecycle(t, { owner: DEV_OWNER, alias: name, actor: identity.id, lifecycleUid, managerInstance: this.managerLifecycleUid, ownerInstanceId: this.managerInstanceId }),
        );
        // From here the DURABLE registration exists: arm the rollback BEFORE minting, so a throw
        // between activation and provisioning still drives the exact-op static terminal (the
        // finally's deprovision tolerates absent files; the broker teardown is idempotent).
        provisioned = { id: identity.id, name, lifecycleUid };
        // Pre-create the agent's bind-only chat (+ DM + role TASK) durables and mint its scoped creds
        // — the shared onboarding step (provisionAgent). It runs on a short-lived PROVISIONER connection
        // (NOT the supervisor's long-lived endpoint), so the DM/DLV consumer-create surface exists only
        // for the provisioning window, never as a standing grant on the always-on daemon (residual 2).
        // F5(b): the credential is BOUNDED (`expiresAt`) — the manager push-renews it ahead of expiry.
        const exp = Math.floor(Date.now() / 1000) + MANAGED_STATIC_TTL_SEC;
        const creds = await this.withProvisioner((prov) =>
          provisionAgent(prov, this.auth!, identity, {
            subscribe,
            allowSubscribe,
            allowPublish,
            role,
            capabilities,
            lifecycleUid,
            expiresAt: exp,
          }),
        );
        // Ledger BEFORE materialization (§13.1): record the credentialId on the slot, append the
        // `cred.<uid>.<credId>` row, and only then write the credential where anything can read
        // it — a credential is never materialized before its ledger row exists.
        const credentialId = rawDigest(creds).replace("sha256:", "sha256-");
        await this.withLifecycleExecutor({ owner: DEV_OWNER, actor: identity.id, lifecycleUid, alias: name }, async (t) => {
          await recordSlotCredential(t, DEV_OWNER, name, lifecycleUid, credentialId);
          await appendStaticCredentialRow(t, { lifecycleUid, credentialId, holderPrincipal: principalKey(DEV_OWNER, identity.id).key, exp });
        });
        // Store first (the source of truth), then materialize: `buildLaunch` hands the CHILD this
        // file path, so the cred must exist as a file regardless of the store behind the seam. The
        // manager's ONE store (injected for hosted, workstation FS locally).
        const secrets = this.secrets;
        // LIFECYCLE-KEYED (SPEC 13.1 on the FS): the incarnation's cred file embeds its uid, so a
        // replayed/stale teardown can never address a same-name successor's credential.
        credsPath = agentLifecycleSecretFilePaths(this.workspaceRoot, name, lifecycleUid).creds;
        await secrets.put(agentSecretKeyForFile(credsPath), creds);
        await materializeSecretToFile(secrets, agentSecretKeyForFile(credsPath), credsPath);
        provisioned = { id: identity.id, name, lifecycleUid, secretPaths: { creds: credsPath } }; // footprint now exists — the finally rolls it back if the spawn throws
      }
      // Personal MCP servers the operator opted to share with manager-spawned agents of this type
      // (cotal config; default none → isolated, the memory-safe default this guards), narrowed by
      // an optional --share-tools selection (absent → all declared, the pre-merge behavior).
      const mcpServers = connectorServers(
        loadCotalConfig(this.workspaceRoot),
        agent,
        parseShareSelection(opts.shareTools),
      );
      // Per-agent cwd overrides the manager's shared workspace root, so agents can be rooted at
      // arbitrary folders/repos. A relative path resolves against the workspace root; omitted → the
      // agent shares the workspace root (the prior, unchanged behavior).
      const cwd = opts.cwd ? resolve(this.workspaceRoot, opts.cwd) : this.workspaceRoot;
      const configSha256 = this.fileDigest(configPath);
      const manifestPath = opts.launchRef
        ? join(this.workspaceRoot, ".cotal", "run", `${opts.launchRef.runId}.json`)
        : undefined;
      const manifestSha256 = manifestPath ? this.fileDigest(manifestPath) : undefined;
      const spec = connector.buildLaunch({
        space: this.space,
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
        servers: this.servers,
        configPath,
        model,
        variant,
        launchOptions,
        // Fork an existing session into the mesh. Taken straight from `opts.resume` (the imperative
        // control arg), never from `opts.resolved` — so the manifest launch path carries no resume by
        // construction. An unsupported connector throws here before any process is spawned.
        resume: opts.resume,
        // Initial prompt: the `--prompt` flag, or the manifest entry's `prompt:` on a resolved launch.
        prompt,
        // The SAME access set the creds were minted from (above) — forwarded so the session's
        // runtime read/post set matches its credentials. Without this a manifest-spawned agent
        // (materialized persona has no access frontmatter) falls back to `["general"]`, which its
        // scoped creds deny, and it joins nothing.
        subscribe,
        allowSubscribe,
        allowPublish,
        capabilities,
        events,
        mcpServers,
        // So a connector that keeps per-agent local state can root it at the workspace, not the
        // (possibly per-agent) launch cwd below. The cwd itself rides runtime.spawn, not the launch.
        workspaceRoot: this.workspaceRoot,
      });
      const handle = this.runtime.spawn(name, spec, cwd);
      hooks?.onLaunched?.(); // P2 item 2: the "launched" progress edge (process spawned, pre-presence)
      const managed: ManagedAgent = {
        name,
        role,
        agent,
        id: userLaunch ? principalKey(userLaunch.owner, name).key : identity.id,
        lifecycleUid,
        // The lifecycle-keyed family this spawn just materialized (absent on an open mesh) — the
        // recorded truth teardown/preservation/health consume, never re-derived by name.
        secretPaths: provisioned?.secretPaths,
        ...(userLaunch ? { userOwner } : { seed: identity.seed }),
        spawner: spawner ?? this.ep.ref().id,
        authorityParent: userLaunch && spawner && parsePrincipalKey(spawner) ? spawner : undefined,
        startedAt: Date.now(),
        handle,
        control: spec.control,
        launch: {
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
            : { kind: "persona", ref, configPath, configSha256 },
          cwd,
          model,
          variant,
          subscribe,
          allowSubscribe,
          allowPublish,
          capabilities,
          events,
          shareTools: opts.shareTools,
          forkSource: opts.resume,
          // Opaque values may contain secrets. Preserve only their keys and require the referenced
          // persona/manifest to resolve the values again; imperative overrides have no safe payload.
          unresolvedLaunchOptionKeys:
            opts.launchOptions && Object.keys(opts.launchOptions).length
              ? Object.keys(opts.launchOptions).sort()
              : undefined,
        },
      };
      // Unit B: the DURABLE slot takes the `active` phase before the in-memory row takes the
      // name — a crash between the two leaves an active-but-unadopted slot the boot sweep
      // terminalizes (never an untracked orphan). Static auth only; a failed CAS fails the spawn
      // (the finally's rollback then drives the exact-op terminal).
      if (this.auth && !this.userMode) {
        await this.withLifecycleExecutor({ owner: DEV_OWNER, actor: managed.id, lifecycleUid, alias: name }, async (t) => {
          const slot = await readStaticSlot(t, DEV_OWNER, name);
          if (slot === undefined || slot.row.lifecycleUid !== lifecycleUid || slot.row.phase !== "provisioning")
            throw new Error(`the static slot for "${name}" is ${slot === undefined ? "absent" : `${slot.row.phase} at uid ${slot.row.lifecycleUid}`}, not this spawn's provisioning intent; refusing to take the slot`);
          await casStaticSlot(t, { ...slot.row, phase: "active" }, slot.revision);
        });
      }
      this.agents.set(name, managed);
      // The live slot now owns teardown — freeSlot deprovisions this identity on exit — so the
      // orphan-rollback in `finally` no longer applies to it.
      provisioned = undefined;
      // #159 B1: reply on a REAL outcome, not a timer. Wait for the agent to actually join the mesh
      // (presence) → started, the child to exit → failed (with its last output; already reaped), or
      // neither in time → uncertain. `✓ started` therefore means "it joined", never just "a process
      // launched".
      const readiness = await this.awaitReadiness(managed);
      // Deliberately stopped mid-launch: reaped by onExit, and the despawn/stop path owns the
      // goal terminal. Return BEFORE the failed/uncertain arms so this emits no competing
      // outcome and does not re-arm an exit watcher on an agent already gone.
      if (!readiness.ok && readiness.deliberate) { hooks?.onTerminalDeferred?.(); return { ok: false, error: readiness.detail }; }
      if (!readiness.ok && !readiness.uncertain) { await hooks?.onOutcome?.({ kind: "failed", data: { error: readiness.detail } }); return { ok: false, error: readiness.detail }; } // failed → already reaped
      // Started OR uncertain: the agent stays managed, so wire the ongoing exit reaper (it reaps a later
      // death — including one that follows an `uncertain` verdict, which deliberately does NOT deprovision).
      this.watchExit(managed);
      if (!readiness.ok) { await hooks?.onOutcome?.({ kind: "uncertain" }); return { ok: false, error: readiness.detail }; } // uncertain — non-success, but kept
      // Reply with the id the slot actually carries (user-mode: the owner.actor principal —
      // presence, ps, and the manifest ownership ledger all key on it; the throwaway static nkey
      // would never match and down -f would treat the agent as foreign).
      // `lifecycleUid` rides the reply so callers that record this spawn (the manifest ledger) can
      // later address the incarnation's lifecycle-keyed artifacts without re-deriving by name.
      // OMIT an absent role: the goal terminal commits this data through the strict
      // canonicalJson (undefined never coerces to null, SPEC 13.6), so a role-less spawn would
      // otherwise fail its succeeded terminal. The CLI/connector already render an absent role as
      // "no role", so dropping the key preserves the reply (P2 item 2, surfaced by readiness:live).
      const okData = { name, agent, id: managed.id, mode: handle.kind, lifecycleUid, ...(role !== undefined ? { role } : {}) };
      await hooks?.onOutcome?.({ kind: "succeeded", data: okData });
      return { ok: true, data: okData };
    } catch (e) {
      // Failure after reserve (provision / launch threw): the slot was never live, so no cold-start
      // was paid — the reserved rollback (finally) is enough, no cooling stamp.
      return { ok: false, error: (e as Error).message };
    } finally {
      this.reserved.delete(name);
      // Minted but never handed to a live slot (buildLaunch / runtime.spawn threw after mint) → tear the
      // orphan down (detached, fail-loud) so a failed spawn leaves no creds/durables behind (#159 B).
      if (provisioned) {
        const orphan = provisioned;
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
    const release = this.beginLifecycle(true);
    if (!release) return { ok: false, agents: [], error: this.maintenanceError() };
    const batchReservations: string[] = [];
    try {
      if (inventory.version !== "cotal-manager-resume/v1")
        return { ok: false, agents: [], error: `unsupported manager resume inventory version ${String(inventory.version)}` };
      if (inventory.space !== this.space)
        return { ok: false, agents: [], error: `resume inventory belongs to space "${inventory.space}", not "${this.space}"` };
      const seen = new Set<string>();
      const principals = new Set<string>();
      await this.ep.waitForPresenceSnapshot();
      const livePrincipals = new Set(this.ep.getRoster()
        .filter((presence) => presence.status !== "offline")
        .map((presence) => presence.card.id));
      if (this.agents.size + this.reserved.size + this.coolingCount() + inventory.agents.length > MAX_AGENTS)
        return { ok: false, agents: [], error: `resume inventory would exceed manager capacity (${MAX_AGENTS})` };
      for (const entry of inventory.agents) {
        if (seen.has(entry.name))
          return { ok: false, agents: [], error: `resume inventory contains duplicate agent name "${entry.name}"` };
        seen.add(entry.name);
        let principal: string;
        try {
          principal = entry.identity.mode === "user"
            ? principalKey(entry.identity.owner, entry.identity.actor).key
            : principalKey(DEV_OWNER, entry.identity.id).key;
        } catch (e) {
          return { ok: false, agents: [], error: `invalid retained principal for ${entry.name}: ${(e as Error).message}` };
        }
        if (principals.has(principal))
          return { ok: false, agents: [], error: `resume inventory contains duplicate principal "${principal}"` };
        principals.add(principal);
        if (livePrincipals.has(principal))
          return { ok: false, agents: [], error: `retained principal "${principal}" is already live and this runtime cannot authoritatively adopt it` };
        if (this.agents.has(entry.name) || this.reserved.has(entry.name))
          return { ok: false, agents: [], error: `retained agent "${entry.name}" is already managed or reserved` };
      }
      for (const entry of inventory.agents) {
        this.reserved.add(entry.name);
        batchReservations.push(entry.name);
      }
      const prepared = new Map<string, PreparedResume>();
      const preflight: Array<{ name: string; reply: ControlReply }> = [];
      for (const entry of inventory.agents) {
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
      const agents: Array<{ name: string; reply: ControlReply }> = [];
      for (let i = 0; i < inventory.agents.length; i++) {
        const entry = inventory.agents[i];
        const reply = await this.resumePreservedAgent(entry, false, true, prepared);
        agents.push({ name: entry.name, reply });
        if (!reply.ok) {
          for (const skipped of inventory.agents.slice(i + 1))
            agents.push({ name: skipped.name, reply: { ok: false, error: `not launched because ${entry.name} failed` } });
          return { ok: false, agents, error: reply.error };
        }
      }
      if (this.resumeAttemptId) this.resumeAwaitingCommit = true;
      return { ok: true, agents };
    } finally {
      for (const name of batchReservations) this.reserved.delete(name);
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
        resolve(agentLifecycleSecretFilePaths(this.workspaceRoot, entry.name, entry.identity.lifecycleUid).creds),
        resolve(agentSecretFilePaths(this.workspaceRoot, entry.name).creds),
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
        const stored = await this.secrets.get(agentSecretKeyForFile(expected));
        if (stored === undefined) throw new Error("the credential is not in the secret store");
        credentialText = stored;
        const actual = idFromCreds(credentialText);
        if (actual !== entry.identity.id)
          throw new Error(`retained credential identity ${actual} does not match inventory principal ${entry.identity.id}`);
      } catch (e) {
        throw new Error(`retained credential for ${entry.name} is unusable: ${(e as Error).message}`);
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
      const lifecycleFiles = agentLifecycleSecretFilePaths(this.workspaceRoot, entry.name, entry.identity.lifecycleUid);
      const legacyFiles = agentSecretFilePaths(this.workspaceRoot, entry.name);
      const recordedToken = resolve(entry.identity.actorToken.path);
      const recordedSentinel = resolve(entry.identity.sentinelCredential.path);
      const recordedHealth = resolve(entry.identity.health.path);
      const matchesFamily = (f: { actorToken: string; sentinelCreds: string; health: string }): boolean =>
        recordedToken === resolve(f.actorToken) && recordedSentinel === resolve(f.sentinelCreds) && recordedHealth === resolve(f.health);
      if (!matchesFamily(lifecycleFiles) && !matchesFamily(legacyFiles))
        throw new Error(`retained identity references for ${entry.name} are not one manager-owned secret family: all of actor-token, sentinel, and health must be the lifecycle-<uid> triple or the legacy name-keyed triple under ${agentCredsDir(this.workspaceRoot)} (no mixed families, no foreign health path)`);
      const secrets = this.secrets;
      const actorToken = await secrets.get(agentSecretKeyForFile(recordedToken));
      const sentinelCreds = await secrets.get(agentSecretKeyForFile(recordedSentinel));
      if (actorToken === undefined || sentinelCreds === undefined)
        throw new Error("the retained actor token / sentinel credential is not in the secret store");
      const adopted = await provider.validateRetainedAgent({
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
            process.execPath,
            ...process.execArgv,
            process.argv[1],
            provider.agentBearerCommand,
            "--dir", userAuthStateDir(this.workspaceRoot, this.space),
            "--space", this.space,
            "--owner", entry.identity.owner,
            "--actor", entry.identity.actor,
            "--token-file", entry.identity.actorToken.path,
            "--health-file", entry.identity.health.path,
          ],
        },
      };
    } catch (e) {
      throw new Error(`retained user principal ${entry.identity.owner}.${entry.identity.actor} could not be reused: ${(e as Error).message}`);
    }
  }

  /** Validate/relaunch one retained inventory entry. Called only through resumePreserved so all
   * records pass the same preflight before the first child is exposed. */
  private async resumePreservedAgent(
    entry: ManagerResumeAgent,
    preflightOnly = false,
    batchReserved = false,
    prepared?: Map<string, PreparedResume>,
  ): Promise<ControlReply> {
    const release = this.beginLifecycle(batchReserved);
    if (!release) return { ok: false, error: this.maintenanceError() };
    try {
      if (entry.space !== this.space)
        return { ok: false, error: `retained agent ${entry.name} belongs to space "${entry.space}", not "${this.space}"` };
      if (entry.launch.runtime !== this.runtime.kind)
        return { ok: false, error: `retained agent ${entry.name} requires runtime "${entry.launch.runtime}", current manager uses "${this.runtime.kind}"` };
      const nameErr = this.nameError(entry.name);
      if (nameErr) return { ok: false, error: nameErr };
      if (this.agents.has(entry.name) || (!batchReserved && this.reserved.has(entry.name)))
        return { ok: false, error: `retained agent "${entry.name}" is already managed or reserved; same-principal resume never auto-numbers` };
      if (!batchReserved && this.agents.size + this.reserved.size + this.coolingCount() >= MAX_AGENTS)
        return { ok: false, error: `at capacity (${MAX_AGENTS} agents incl. in-flight + cooling); same-principal resume refused` };
      const cached = prepared?.get(entry.name);
      if (!preflightOnly && cached) {
        try {
          // Do not trust the earlier batch preflight across another agent's sequential readiness wait.
          await this.validateRetainedAuthority(entry);
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
        return this.launchPreparedResume(entry, cached, batchReserved);
      }
      try {
        const cwd = lstatSync(entry.launch.cwd);
        if (!cwd.isDirectory() || cwd.isSymbolicLink())
          return { ok: false, error: `retained cwd is not a real directory: ${entry.launch.cwd}` };
      } catch (e) {
        return { ok: false, error: `retained cwd unavailable: ${entry.launch.cwd} (${(e as Error).message})` };
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
        return { ok: false, error: (e as Error).message };
      }
      const missing = (connector.requires ?? []).filter((bin) => !resolveOnPath(bin));
      if (missing.length)
        return { ok: false, error: `${connector.name} harness needs ${missing.join(", ")} on PATH - not found` };
      if (entry.launch.variant && !connector.supportsModelVariant)
        return { ok: false, error: `${connector.name} connector does not support model variants (variant)` };

      // EVENT-GRANT PREFLIGHT ON RESUME — refuse BEFORE buildLaunch, never after.
      //
      // A retained entry carries the `allowPublish` it was provisioned with AND its `events` bit.
      // Adopting both unchecked is how a resume produces the same false-success launch the foreground
      // spawn path used to: the agent comes back with `COTAL_EVENTS` armed and a credential that was
      // never granted the event channel, so the broker denies every frame while `resume` reports
      // success. The failure is silent by construction — nothing surfaces a denied publish to the
      // operator who ran the resume.
      //
      // This is NOT connector cutover; it is the resume authority invariant the plan schedules
      // (§8/§9). It reaches a state the spawn-path fix cannot: an inventory PRESERVED BEFORE that fix
      // existed still carries the old grant list, so the hole outlives the fix on every machine that
      // has a preserved cut on disk.
      //
      // Compared against the connector's OWN `eventChannel`, never a hardcoded prefix — the same
      // rule the manager's spawn path follows, so the two cannot drift.
      if (entry.launch.events === true) {
        if (!connector.eventChannel)
          return { ok: false, error: `${connector.name} connector does not support event publishing (events)` };
        const required = connector.eventChannel(entry.name);
        if (!(entry.launch.allowPublish ?? []).includes(required))
          return {
            ok: false,
            error:
              `retained agent ${entry.name} has events enabled but its preserved publish grant does not ` +
              `include "${required}" — it was preserved before the event-channel grant existed. Resuming ` +
              `would launch it with a mute event stream. Re-spawn it with --events, or resume it with ` +
              `events off.`,
          };
      }

      let launchOptions: Record<string, unknown> | undefined;
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
          return { ok: false, error: (e as Error).message };
        }
        if (!spec || spec.hash !== launchSource.hash)
          return { ok: false, error: `retained manifest agent ${launchSource.requested} is missing or its hash changed; refusing same-principal resume` };
        launchOptions = spec.launchOptions;
      } else {
        try {
          launchOptions = loadAgentFile(entry.launch.source.configPath).launchOptions;
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      }

      let authority: Pick<PreparedResume, "id" | "creds" | "userAuth">;
      try {
        authority = await this.validateRetainedAuthority(entry);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }

      try {
        const mcpServers = connectorServers(
          loadCotalConfig(this.workspaceRoot),
          entry.launch.connector,
          parseShareSelection(entry.launch.shareTools),
        );
        const spec = connector.buildLaunch({
          space: this.space,
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
          servers: this.servers,
          configPath: entry.launch.source.configPath,
          model: entry.launch.model,
          variant: entry.launch.variant,
          launchOptions,
          resume: entry.launch.forkSource,
          subscribe: entry.launch.subscribe,
          allowSubscribe: entry.launch.allowSubscribe,
          allowPublish: entry.launch.allowPublish,
          capabilities: entry.launch.capabilities,
          events: entry.launch.events,
          mcpServers,
          workspaceRoot: this.workspaceRoot,
        });
        const value = { spec, ...authority } satisfies PreparedResume;
        prepared?.set(entry.name, value);
        if (preflightOnly) return { ok: true, data: { name: entry.name, preflight: true } };
        return this.launchPreparedResume(entry, value, batchReserved);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    } finally {
      release();
    }
  }

  private async launchPreparedResume(
    entry: ManagerResumeAgent,
    prepared: PreparedResume,
    batchReserved: boolean,
  ): Promise<ControlReply> {
    if (!batchReserved) this.reserved.add(entry.name);
    try {
      // Unit B F5(b): recover the STATIC identity's nkey seed from the adopted credential (the
      // creds file embeds it) so the manager stays this incarnation's RENEWAL OWNER across a
      // preserve/resume — without it the adopted cred would die loud at its TTL with no remint.
      let adoptedSeed: string | undefined;
      if (entry.identity.mode === "static") {
        const stored = await this.secrets.get(agentSecretKeyForFile(resolve(entry.identity.credential.path)));
        adoptedSeed = stored === undefined ? undefined : /-----BEGIN USER NKEY SEED-----\s*([A-Z0-9]+)\s*-----END USER NKEY SEED-----/.exec(stored)?.[1];
        if (adoptedSeed === undefined)
          console.error(`! resume ${entry.name}: the adopted credential carries no readable nkey seed - the manager cannot renew it (it dies loud at its exp)`);
      }
      const handle = this.runtime.spawn(entry.name, prepared.spec, entry.launch.cwd);
      const managed: ManagedAgent = {
        name: entry.name,
        role: entry.role,
        agent: entry.launch.connector,
        id: entry.identity.mode === "user" ? principalKey(entry.identity.owner, entry.identity.actor).key : entry.identity.id,
        seed: adoptedSeed,
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
          source: entry.launch.source,
          cwd: entry.launch.cwd,
          model: entry.launch.model,
          variant: entry.launch.variant,
          subscribe: entry.launch.subscribe,
          allowSubscribe: entry.launch.allowSubscribe,
          allowPublish: entry.launch.allowPublish,
          capabilities: entry.launch.capabilities,
          events: entry.launch.events,
          shareTools: entry.launch.shareTools,
          forkSource: entry.launch.forkSource,
        },
        suppressCleanup: true,
      };
      this.agents.set(entry.name, managed);
      if (this.resumeAttemptId) this.resumedAgentNames.add(entry.name);
      const readiness = await this.awaitReadiness(managed);
      if (!readiness.ok && !readiness.uncertain) return { ok: false, error: readiness.detail };
      if (!readiness.ok) {
        this.watchExit(managed);
        this.watchResumeAdoption(managed);
        return { ok: false, error: readiness.detail };
      }
      if (!this.resumeAttemptId) managed.suppressCleanup = false;
      this.watchExit(managed);
      if (this.agents.get(managed.name) !== managed)
        return { ok: false, error: `${managed.name} exited immediately after same-principal readiness` };
      return {
        ok: true,
        data: { name: managed.name, role: managed.role, agent: managed.agent, id: managed.id, mode: handle.kind, resumed: true },
      };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      if (!batchReserved) this.reserved.delete(entry.name);
    }
  }

  private probeStaticCredential(creds: string) {
    return probeConnect(this.servers ?? DEFAULT_SERVER, { creds, timeoutMs: 5_000 });
  }

  /** An uncertain resume remains non-destructive until exact-principal AND exact-incarnation presence
   *  arrives later. Same predicate as the readiness fence: a principal-only match would let a
   *  wrong/absent-uid presence under the reused alias clear cleanup suppression on another incarnation. */
  private watchResumeAdoption(a: ManagedAgent): void {
    const wanted = this.managedPrincipal(a);
    const onPresence = (): void => {
      if (this.agents.get(a.name) !== a) {
        this.ep.off("presence", onPresence);
        return;
      }
      if (!this.ep.getRoster().some((p) => p.card.id === wanted && p.status !== "offline" && p.lifecycleUid === a.lifecycleUid)) return;
      if (!this.resumeRequired) a.suppressCleanup = false;
      this.ep.off("presence", onPresence);
    };
    this.ep.on("presence", onPresence);
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
   *  catches a join/exit that landed before we subscribed). Runtimes that stream no exit signal (external surfaces,
   *  whose `attach()` throws) race presence-vs-backstop only — better than the old "assume up". */
  private async awaitReadiness(a: ManagedAgent): Promise<{ ok: true } | { ok: false; uncertain?: boolean; deliberate?: boolean; detail: string }> {
    let session: AttachSession | undefined;
    try {
      session = a.handle.attach();
    } catch {
      /* external surfaces stream no exit — presence-or-backstop only */
    }
    const s = session;
    // Presence cards carry the wire PRINCIPAL dot-form (`<owner>.<actor>`), never a raw nkey — match
    // through managedPrincipal or a static launch can never be seen joining (every static spawn would
    // resolve "uncertain"; caught by the lifecycle e2e).
    const wanted = this.managedPrincipal(a);
    // READINESS LIFECYCLE FENCE (SPEC 13.1): match the exact principal AND the exact lifecycle uid
    // the manager minted for THIS spawn (presence carries it, §6/:315). The endpoint's own
    // register-only broker proof is gated on the CLIENT-authored `card.kind`, which a managed child
    // holding a valid agent credential could set to "endpoint" to skip - so it is defense-in-depth,
    // NOT the authority boundary. This equality is: the manager (not the child) owns the expected
    // uid, so a ghost that advertises a wrong/absent uid never reports STARTED, whatever kind it
    // claims. The manager threads the uid into EVERY mode's launch (open included), so the child
    // adopts it over a self-mint and publishes it in presence; the uid is absent only from a peer
    // the manager never launched (a pure operator/daemon connection that never registers).
    const joined = (): boolean =>
      this.ep.getRoster().some((p) => p.card.id === wanted && p.status !== "offline" && p.lifecycleUid === a.lifecycleUid);

    return await new Promise((resolve) => {
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      let unsubExit = (): void => {};
      const finish = (r: { ok: true } | { ok: false; uncertain?: boolean; deliberate?: boolean; detail: string }): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.ep.off("presence", onPresence);
        unsubExit();
        resolve(r);
      };
      const onPresence = (): void => {
        if (joined()) finish({ ok: true });
      };
      // Process exit → failed. Clear the backstop FIRST (synchronously) so it can't resolve UNCERTAIN while
      // the backlog reads async — the process is known dead, that's a failure, not an unknown. Reap through
      // onAgentExit so a child the launcher spawned in the window is reaped too.
      const onExit = (): void => {
        if (done || !s) return;
        clearTimeout(timer);
        // ┌─ DO NOT MOVE THIS READ. Its POSITION is the fix; its value is not. ──────────────────┐
        // MOVING IT BELOW `onAgentExit` MAKES READINESS STOP REPORTING GENUINE LAUNCH FAILURES.
        // That is what breaks — not a style regression, a silent loss of every `failed` terminal
        // for an agent that really did die on launch. `onAgentExit` reaches `freeSlot`, which sets
        // this SAME latch on its way through (see its "also covers exit/reap paths" comment), so a
        // read taken after that call is true for EVERY exit, deliberate or not.
        //
        // Read HERE — first statement, before the await and before `onAgentExit` — a set latch can
        // only have been set by someone else, and the only other setter on this path is
        // `stopHandle`, which latches SYNCHRONOUSLY and then kills with no suspension between. So a
        // despawn-caused exit is guaranteed observed with the latch UP and a natural exit with it
        // DOWN: the distinction holds by program order, never by winning a race.
        //
        // The same latch, read one function call apart, answers two different questions.
        //
        // TO RE-VERIFY (this is the mutation that proves it, and it is the exact regression a tidy
        // refactor produces): move this capture below `onAgentExit` and run
        // `pnpm smoke:manager-spawn-action`. M3 `process exit -> failed` must FAIL. Note that M4 —
        // the case this fix exists for — still PASSES under that mutation, so the suite this fix
        // was written against cannot catch its own regression. M3 catches it only because it
        // happens to share a file.
        // └──────────────────────────────────────────────────────────────────────────────────────┘
        const deliberate = a.terminalizing === true;
        void (async () => {
          const tail = this.tail(await s.backlog());
          this.onAgentExit(a);
          // A DELIBERATE STOP IS NOT A LAUNCH FAILURE. The despawn path owns this goal's terminal
          // and commits `cancel`; reporting `failed` here races it and, when it wins, tells the
          // caller the agent died on launch when in fact an operator cancelled it. The process
          // teardown above still runs — only the goal's OUTCOME is left to the path that caused it.
          // A deliberate stop still has to SETTLE this promise. `clearTimeout` above already
          // removed the only other resolver, so returning here leaves it pending forever and the
          // spawn's lifecycle ticket is never released — which permanently wedges every drain
          // (preparePreservation, and through it a preserving `down`). Settle it as its own
          // variant: not `failed` and not `uncertain`, so the caller emits NO terminal and the
          // despawn path keeps sole ownership of this goal's `cancel`.
          if (deliberate) {
            finish({ ok: false, deliberate: true, detail: `${a.name} was stopped before it reported ready` });
            return;
          }
          finish({ ok: false, detail: `${a.name} exited on launch${tail ? ` - last output: ${tail}` : ""}` });
        })();
      };
      timer = setTimeout(
        () =>
          finish({
            ok: false,
            uncertain: true,
            detail: `${a.name} (${a.id}): launch status uncertain - no process exit and no mesh presence within ${Math.round(this.readinessTimeoutMs / 1000)}s; it may still be booting or stuck before connector startup. Inspect with \`cotal attach ${a.name}\` / \`cotal ps\`, or stop it to clean up.`,
          }),
        this.readinessTimeoutMs,
      );
      unsubExit = s ? s.onExit(onExit) : (): void => {};
      this.ep.on("presence", onPresence);
      // Subscribe-then-check (TOCTOU): a join or an exit that already landed before we subscribed.
      if (s && a.handle.status() === "exited") onExit();
      else onPresence();
    });
  }

  /** Last non-empty line of terminal output as a single trimmed, control-char-stripped snippet
   *  (≤160 chars) — a readable one-line cause for an early-exit diagnostic, never the raw ANSI
   *  scrollback. */
  private tail(buf: Buffer): string {
    const text =
      buf
        .toString("utf8")
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "") // strip CSI escape sequences
        .replace(/[^\x20-\x7e\n]/g, "") // drop other control / non-printable bytes
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .pop() ?? "";
    return text.length > 160 ? `…${text.slice(-160)}` : text;
  }

  /** Subscribe to a managed agent's process-exit so a self-driven exit frees its slot and reaps
   *  its children (P4b/P4c). Only pty streams exit (via the attach session's `onExit`); external runtimes'
   *  attach() throws, so this is a no-op there — a self-EXITED agent under those runtimes is reaped
   *  by nothing until it's explicitly despawned (graceful-stop runs on despawn, not self-exit). The
   *  cap still holds (a lingering corpse counts toward it); runtime-agnostic exit-reaping (a real
   *  per-runtime `status()` → exited-sweep at the availability gate) is a tracked follow-up. */
  private watchExit(a: ManagedAgent): void {
    try {
      const session = a.handle.attach();
      session.onExit(() => this.onAgentExit(a));
      // Close the TOCTOU between the early-exit probe's unsubscribe and this subscribe: if the child
      // exited in that gap, the `onExit` above never fires (a late subscriber can't hear a past event),
      // so the agent would leak (never reaped, never deprovisioned). Re-check status right after
      // subscribing and reap it now if it already went. onAgentExit is idempotent (freeSlot's guard).
      if (a.handle.status() === "exited") this.onAgentExit(a);
    } catch {
      /* runtime doesn't stream an exit signal — nothing to wire */
    }
  }

  /** Prune expired cooling stamps (drop those at/before now) and return the live count — the
   *  recycle floor's contribution to the ceiling (P4c). Lazy: pruned only when the gate consults it. */
  private coolingCount(): number {
    const now = Date.now();
    this.cooling = this.cooling.filter((stamp) => stamp > now);
    return this.cooling.length;
  }

  private async opStop(args: Record<string, unknown>, caller: string, admin: boolean): Promise<ControlReply> {
    const name = String(args.name ?? "").trim();
    const a = this.agents.get(name);
    if (!a) return { ok: false, error: `no agent "${name}"` };
    return this.despawnCore(a, caller, admin, args.graceful !== false);
  }

  /** The ONE named-terminal core both doors share (P2 item 1, checklist 8): the ctl named `stop`
   *  and the v0.4 targeted `despawn` are the same terminal — authorize by the shared policy
   *  ({@link authorizeNamed}: own-child / owner-domain on privileged, any on admin), stop, track.
   *  The ep door runs the SAME two pieces separately so a policy denial surfaces as the §13.3
   *  `permission-denied` (never a generic failure). */
  private async despawnCore(a: ManagedAgent, caller: string, admin: boolean, graceful: boolean): Promise<ControlReply> {
    const denied = await this.authorizeNamed(a, caller, admin);
    if (denied) return { ok: false, error: denied };
    return this.despawnAuthorized(a, graceful, !admin);
  }

  /** The post-authorization terminal effect (both doors). `trackNonAdmin` mirrors the ctl door's
   *  `trackStoppedHandle(a, !admin)` disposition. */
  private despawnAuthorized(a: ManagedAgent, graceful: boolean, trackNonAdmin: boolean): ControlReply {
    this.stopHandle(a, graceful);
    this.trackStoppedHandle(a, trackNonAdmin);
    void this.cancelAgentGoal(a.name, graceful ? "graceful" : "terminate"); // M4: cancel a live spawn goal
    return { ok: true, data: { name: a.name, stopped: true, graceful } };
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

  /** Open a short-lived PROVISIONER connection, run the onboarding ops on it, and drain it (closure (ii),
   *  residual 2). The DM/DLV consumer-create surface — the irreducible onboarding power — lives only for
   *  this window, never as a standing grant on the long-lived supervisor. A provision-only endpoint
   *  (no presence/consume/channel-watch) connected with memory-only `provisioner` creds; it sets its own
   *  `inboxPrefix` so JS-API replies land on the `_INBOX_<id>.>` the provisioner cred subscribes. */
  /** Run one static §13.1 lifecycle OPERATION over an ephemeral, key-pinned `lifecycle-executor`
   *  connection (Unit B): the credential's grants name exactly ONE incarnation's head/uid/gate/
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
    const nc = await connect({ servers: this.servers ?? DEFAULT_SERVER, ...standaloneConnectOpts({ creds, /* not yet wired to a recorded transport */ tls: false }), maxReconnectAttempts: 0 });
    try {
      const kvm = new Kvm(nc);
      const recordsKv = await kvm.open(recordsBucket(this.space));
      const authKv = await kvm.open(epAuthBucket(this.space));
      return await fn(staticLifecycleTransport(recordsKv, authKv));
    } finally {
      await nc.drain().catch(() => nc.close());
    }
  }

  /** Run one §13.1 ENDPOINT-SERVE credential operation (P2 item 1, 1a-serve) over an ephemeral,
   *  key-pinned `endpoint-serve-executor` connection: the credential's grants name exactly the
   *  manager instance's `epgate`/`epcred` keys plus its registration's two records keys, so the
   *  gate CAS, the mint fence, and the spec/governance writes ride a one-shot scoped authority —
   *  NEVER the manager's standing seed/supervisor connection (the panel's "no seed shortcut"). */
  private async withEndpointServeExecutor<T>(fn: (kvs: { recordsKv: KV; authKv: KV; nc: NatsConnection }) => Promise<T>): Promise<T> {
    if (!this.auth) throw new Error("withEndpointServeExecutor: no space auth (an open mesh has no service registry)");
    const identity = newIdentity();
    const creds = await mintCreds(this.auth, identity, "endpoint-serve-executor", {
      endpointServeExecutor: { endpoint: MANAGER_ENDPOINT, instanceId: this.managerInstanceId },
    });
    const nc = await connect({ servers: this.servers ?? DEFAULT_SERVER, ...standaloneConnectOpts({ creds, /* not yet wired to a recorded transport */ tls: false }), maxReconnectAttempts: 0 });
    try {
      const kvm = new Kvm(nc);
      return await fn({ recordsKv: await kvm.open(recordsBucket(this.space)), authKv: await kvm.open(epAuthBucket(this.space)), nc });
    } finally {
      await nc.drain().catch(() => nc.close());
    }
  }

  /** 1d open-mesh counterpart of {@link withEndpointServeExecutor}: an OPEN mesh has no
   *  credential system, so there is no scoped executor to mint - the same §13.1 gate/records
   *  writes ride a bare one-shot connection (the broker enforces nothing on an open mesh; the
   *  ceremony still produces the real gate, epoch, and registration the serve rails run on). */
  private async withOpenServeConnection<T>(fn: (kvs: { recordsKv: KV; authKv: KV; nc: NatsConnection }) => Promise<T>): Promise<T> {
    if (this.auth) throw new Error("withOpenServeConnection: an auth mesh must use the scoped endpoint-serve executor");
    const nc = await connect({ servers: this.servers ?? DEFAULT_SERVER, maxReconnectAttempts: 0 });
    try {
      const kvm = new Kvm(nc);
      // An open mesh may be a RAW broker (no `cotal up` provisioning ran), and `Kvm.open` binds
      // lazily without checking the stream exists — create-or-verify the §13.12 authority stores
      // first (the same mode-neutral treatment {@link registerManagerService} gives the contract
      // store), or the first gate write dies "stream not found".
      await ensureAuthorityStores(await jetstreamManager(nc), kvm, this.space);
      return await fn({ recordsKv: await kvm.open(recordsBucket(this.space)), authKv: await kvm.open(epAuthBucket(this.space)), nc });
    } finally {
      await nc.drain().catch(() => nc.close());
    }
  }

  /** The served manager-level health summary (1a's one read-only command). */
  private managerStatusData(): ManagerStatus {
    return {
      instanceId: this.managerInstanceId,
      runtime: this.runtime.kind,
      agentCount: this.agents.size,
      uptimeMs: Date.now() - this.startedAtMs,
    };
  }

  /** P2 item 1: register the manager as an ordinary v0.4 `service` endpoint and serve its typed
   *  command surface on the ep rails - since 1d the manager's ONLY control door. On an AUTH mesh
   *  the whole credential path is the SAME one an ordinary endpoint traverses (the enforcement
   *  test that keeps "ordinary" honest): provision the §13.1 issuance gate, drive the
   *  registration BARRIER's gate CAS, then release the serve credential only on the mint FENCE's
   *  revision-pinned CAS win — all over the scoped one-shot executor ({@link
   *  withEndpointServeExecutor}), never a seed-signed shortcut. Holding the signing seed only
   *  AUTHORIZES the reserved single-label name (`manager`, operator name authority, DEV_OWNER).
   *  On an OPEN mesh the same gate/registration/serve-grant ceremony runs over bare one-shot
   *  connections and NO credential is ever minted: there is no credential system to issue from,
   *  so the gate legitimately keeps an empty `epcred` family (the §13.1 fence is issuance-only)
   *  and the serve connection is bare — the broker enforces nothing on an open mesh, exactly the
   *  old open-mesh ctl trust ("open = single-trusted-host"). */
  private async registerManagerService(): Promise<void> {
    const auth = this.auth;
    // The §13.7 contract store is REGISTRATION's dependency, ensured here MODE-NEUTRALLY (1c.2c):
    // it used to ride the static-only lifecycle reconcile, so a USER-mode manager registered
    // against an absent stream and its artifact publish died no-responders (live-repro'd). A
    // provisioner one-shot creates-or-verifies it (config-B immutability incl. the shadowed-legacy
    // refuse) before the executor publishes a single artifact.
    {
      // Open mesh: the bare connection holds the rights (there is no credential system to mint from).
      const provCreds = auth ? await mintCreds(auth, newIdentity(), "provisioner") : undefined;
      const provNc = await connect({ servers: this.servers ?? DEFAULT_SERVER, ...standaloneConnectOpts({ creds: provCreds, /* not yet wired to a recorded transport */ tls: false }), maxReconnectAttempts: 0 });
      try {
        // P2 item 2: the manager now WRITES goal facts (EPF) + progress events (EPE), so the §13.12
        // endpoint streams must exist. Nothing provisioned them before spawn-as-action (no endpoint
        // wrote to EPF/EPE), so the manager ensures the full set here over the provisioner (whose
        // STREAM.CREATE now covers them), idempotently - createEndpointStreams is a superset of
        // ensureContractStore + ensureAuthorityStores, fail-loud on drift. Auth + open both run this.
        await createEndpointStreams(await jetstreamManager(provNc), new Kvm(provNc), this.space);
      } finally {
        await provNc.drain().catch(() => provNc.close());
      }
    }
    const iid = this.managerInstanceId;
    const artifacts = managerClusterArtifacts();
    // In-memory §13.7 content store: the manager is this document's AUTHOR, so registration and
    // serve authorization verify against the exact artifacts it publishes from memory. The DURABLE
    // `epc` contract-store publication (for third-party digest fetches) runs below inside the same
    // executor, BEFORE the registration that advertises the digests.
    const store = new Map<string, unknown>([
      [artifacts.rootDigest, artifacts.document],
      [artifacts.closureDigest, artifacts.manifest],
    ]);
    const readClusterArtifact = (digest: string): unknown => store.get(digest);
    // §13.9 name authority, static mode: `manager` is a core single-label name requiring OPERATOR
    // authority — the manager holds the space signing seed, so it self-authorizes exactly its own
    // name for exactly DEV_OWNER (never a general authority; any other (name, owner) refuses).
    const authority: ServiceNameAuthority = {
      authorize: (name, owner) => ({ authorized: name === MANAGER_ENDPOINT && owner === DEV_OWNER, revision: 0 }),
    };
    // The STABLE serve identity (P2 item 3): the PERSISTED serve nkey, reused across restart so the
    // gate binds the SAME principal (§13.1 serving-principal binding) - provisionEndpointGateOpen
    // stays idempotent and verified eviction has a stable target. Renewals re-mint the same nkey
    // with a fresh bounded exp; a restart re-provisions the same (idempotent) gate + re-registers.
    const serveIdentity = this.managerServeIdentity;
    const servePrincipal = principalKey(DEV_OWNER, serveIdentity.id).key;
    // must-5 (b): the STABLE goal-writer identity — a SIBLING credential in the same §13.1 family
    // (not the gate's bound serving principal), minted here so the run block can family-stage it.
    this.goalWriterIdentity = newIdentity();
    // P2 item 6: the STABLE session-LEDGER identity — another SIBLING in the SAME §13.1 family, so
    // the takeover barrier revokes a deposed manager's ledger cred alongside its goal-writer. The
    // per-session serving creds join the same family, each with its own fresh identity.
    this.sessionLedgerIdentity = newIdentity();
    const run = async ({ recordsKv, authKv, nc: execNc }: { recordsKv: KV; authKv: KV; nc: NatsConnection }) => {
      // §13.7 contract-artifact publication (1c): every schema root + its closure manifest, plus
      // the cluster document + ITS manifest, land in the EPC store BEFORE the registration that
      // advertises their digests — so a caller can always fetch-verify-compile a registered
      // digest (the item-5 generic-invoke read path). Create-only + content-addressed: a retry
      // or a same-artifact republish is an idempotent lost-CAS. The registration itself still
      // verifies against the in-memory copies (the manager is the author).
      const storeCtx = await contractStoreContext(execNc, this.space);
      for (const value of [...managerContractArtifactValues(), artifacts.document, artifacts.manifest])
        await publishContractArtifact(storeCtx, contractArtifactCanonicalBytes(value));
      // §13.1 pre-registration (checklist 1): the issuance gate, born open@gen0 bound to the serve
      // principal — provisioned ONCE, on the FIRST registration. On a RESTART (P2 item 3) the gate
      // already EXISTS (advanced past gen0 by the prior registration), so re-provisioning the gen0
      // row would conflict "foreign content"; the persisted instanceId makes this a TAKEOVER, and
      // registerServiceInstance below freezes + re-registers the EXISTING gate (advancing the epoch
      // after it verify-evicts the superseded family). The serve principal is the SAME persisted one,
      // so the gate's principal binding is unchanged either way.
      if ((await serveIssuanceGateKv(authKv, this.space, { endpoint: MANAGER_ENDPOINT, instanceId: iid }).observe()) === null)
        await provisionEndpointGateOpen(authKv, { endpoint: MANAGER_ENDPOINT, instanceId: iid, principal: servePrincipal });
      // P2 item 3 (slice 3a): on an AUTH mesh a RE-registration (restart of the persisted instanceId)
      // must VERIFY-EVICT the superseded serve family BEFORE the epoch advances (§13.1 "old authority
      // dies before new authority is visible"). Inject the SCOPED delivery-admin evictor; the OPEN
      // mesh mints no serve family, so no evictor (the empty-family path never consults it and a
      // restart there works evictor-free). NO-ORACLE = LOUD: with no reachable delivery daemon the
      // evictor THROWS naming the cure, so PHASE 2 fails closed with the delivery-daemon fix in the
      // error text — a crash-restart never silently skips eviction (no-fallbacks).
      const barrier = endpointRegistrationBarrier(authKv, this.space, {
        endpoint: MANAGER_ENDPOINT, instanceId: iid, opId: mintLifecycleUid(),
        ...(auth ? { evict: makeManagerEndpointEvictor({ space: this.space, servers: this.servers ?? DEFAULT_SERVER, auth, log: (line) => console.error(line) }) } : {}),
      });
      const spec = { endpoint: MANAGER_ENDPOINT, owner: DEV_OWNER, clusterDigests: [artifacts.closureDigest], protocol: { v: 1 as const } };
      const { registrationRevision } = await registerServiceInstance(recordsKv, {
        space: this.space, spec, instanceId: iid, registrant: { owner: DEV_OWNER }, authority, barrier, readClusterArtifact,
      });
      // processEpoch comes from the GATE (checklist 4: never derived from the uid string); the
      // fence below is also the mint's §13.1 release CAS.
      const fence = serveIssuanceGateKv(authKv, this.space, { endpoint: MANAGER_ENDPOINT, instanceId: iid });
      const observed = await fence.observe();
      if (observed === null) throw new Error(`the issuance gate for ${MANAGER_ENDPOINT}/${iid} vanished after registration`);
      const grant = await authorizeServeGrant(recordsKv, {
        space: this.space, endpoint: MANAGER_ENDPOINT, instanceId: iid, epoch: observed.processEpoch,
        holder: { owner: DEV_OWNER }, authority, readClusterArtifact,
        readProcessEpoch: async () => {
          const g = await fence.observe();
          if (g === null) throw new Error(`no issuance gate for ${MANAGER_ENDPOINT}/${iid}`);
          return g.processEpoch;
        },
      });
      // P2 item 3 (class scatter): write this instance's CONVERGED svc status so it is a §13.5
      // scatter member — `freezeExpectedSet` skips any instance whose status is absent or lags the
      // current registration. Instance-side `ready` at the just-registered spec revision, epoch-fenced
      // to the gate's processEpoch (the same leader-served reader `authorizeServeGrant` used); on a
      // restart it CAS-updates the predecessor's status forward (the advanced epoch supersedes the old
      // one). Key-pinned to this instance's own status key on the SAME executor.
      await writeServiceStatus(recordsKv, {
        endpoint: MANAGER_ENDPOINT, instanceId: iid, epoch: observed.processEpoch,
        status: { state: SERVICE_READY, epoch: observed.processEpoch, observedSpecRevision: registrationRevision },
        readProcessEpoch: async () => {
          const g = await fence.observe();
          if (g === null) throw new Error(`no issuance gate for ${MANAGER_ENDPOINT}/${iid}`);
          return g.processEpoch;
        },
      });
      // Open mesh: NO mint - the §13.1 fence is issuance-only and nothing is ever issued, so the
      // gate keeps an empty `epcred` family; the serve connection below stays bare.
      const creds = auth ? await mintCreds(auth, serveIdentity, "endpoint-serve", { serveIssuance: fence, endpointServe: grant }) : undefined;
      // must-5 (b): mint + family-stage the goal-writer credential HERE, over this executor's
      // authKv (the fence is live), so its credId lands in `epcred.<e>.<iid>` and the takeover
      // barrier revokes it. Open mesh: no mint (no credential system; the goal-writer conn is bare).
      const goalWriterCreds = auth ? await this.mintAndStageGoalWriter(authKv) : undefined;
      // P2 item 6: mint + family-stage the session-LEDGER credential HERE too (same executor, same
      // fence, same §13.1 family), so takeover revokes a deposed manager's ledger connection. The
      // per-session SERVING credentials are minted later, one per redemption, into the SAME family.
      // Open mesh: no mint (no credential system; the ledger connection stays bare).
      const sessionLedgerCreds = auth ? await this.mintAndStageSessionLedger(authKv) : undefined;
      return { grant, creds, goalWriterCreds, sessionLedgerCreds };
    };
    const { grant, creds, goalWriterCreds, sessionLedgerCreds } = await (auth ? this.withEndpointServeExecutor(run) : this.withOpenServeConnection(run));
    this.goalWriterCreds = goalWriterCreds;
    this.sessionLedgerCreds = sessionLedgerCreds;
    // The serve connection presents the CURRENT credential on every (re)connect (the state object
    // is captured by the authenticator), so a fence-traversing renewal is adopted by reconnect
    // without re-registration. Reconnects stay unbounded: the serve rails are this instance's
    // registered surface for its whole incarnation.
    const state = { handle: undefined as unknown as EpServeHandle, nc: undefined as unknown as NatsConnection, identity: serveIdentity, grant, creds };
    const enc = new TextEncoder();
    const nc = await connect({
      servers: this.servers ?? DEFAULT_SERVER,
      // Open mesh: a bare serve connection (no credential exists; the broker enforces nothing).
      ...(creds !== undefined ? { authenticator: (nonce?: string) => credsAuthenticator(enc.encode(state.creds!))(nonce) } : {}),
      inboxPrefix: `_INBOX_${serveIdentity.id}`,
      maxReconnectAttempts: -1,
    });
    nc.closed().then((err) => { if (err) console.error(`! manager service endpoint connection closed: ${err.message}`); });
    try {
      // The 1b typed surface + the derived `describe`. The descriptor stays PUBLIC in static
      // mode: the broker grant (who holds each command's request-publish row) is the
      // load-bearing authority tier, and a static single-operator mesh leaks nothing by listing
      // command names; the trusted per-caller `view(caller)` scoping joins the user-mode
      // registration follow-up (where actorScope is the trusted source). Every ordinary handler
      // runs the SHARED admission chokepoint ({@link serveGated}).
      state.handle = serveEndpoint(nc, this.space, grant, this.managerServiceDefs(), { public: true }, {
        // The FRESH target resolver (§13.3) for the targeted commands (`despawn`/`attach`): the
        // manager's live managed set IS the current-mapping authority for its own agents (the
        // durable slot rows mirror it). Static mode carries no mapping-revision dimension, so
        // the revision is the constant 0 — a caller that pins a revision pins 0.
        resolveTarget: (t) => {
          if (t.owner === DEV_OWNER) {
            for (const a of this.agents.values()) if (!a.userOwner && a.id === t.actor) return { lifecycleUid: a.lifecycleUid, mappingRevision: 0 };
            return undefined;
          }
          const key = principalKey(t.owner, t.actor).key;
          for (const a of this.agents.values()) if (a.userOwner && a.id === key) return { lifecycleUid: a.lifecycleUid, mappingRevision: 0 };
          return undefined;
        },
      });
    } catch (e) {
      await nc.drain().catch(() => nc.close());
      throw e;
    }
    state.nc = nc;
    this.serviceServe = state;
    console.error(`manager service endpoint registered: ${MANAGER_ENDPOINT}/${iid} (epoch ${grant.epoch}, registrationRevision ${grant.registrationRevision})`);
  }

  /** P2 item 2 must-5 (b): mint the standing `goal-writer` credential and STAGE it into this
   *  instance's §13.1 revocation family (`epcred.<e>.<iid>`), over the passed executor's `authKv`
   *  (the scoped `endpoint-serve-executor`, which holds the epcred write grant). The GRANT profile
   *  stays goal-writer-only (Q2 — disjoint from the serve credential); only the FAMILY membership
   *  is shared, so the registration barrier's existing enumerate+revoke+evict catches the
   *  goal-writer on takeover/retire with NO barrier code change. Used both at registration (the run
   *  block's `authKv`) and at renewal (a fresh executor's), re-minting the SAME stable nkey with a
   *  fresh bounded exp — each issuance writes a DISTINCT ledger row (per-JWT credentialId digest). */
  private async mintAndStageGoalWriter(authKv: KV): Promise<string> {
    const auth = this.auth!;
    const identity = this.goalWriterIdentity!;
    // The issuance gate + §13.1 revocation family are keyed by the REGISTRATION instanceId
    // (the persisted logical id, item 3's split), NOT the per-process lifecycleUid — the barrier
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
      credentialId: rawDigest(creds).replace("sha256:", "sha256-"),
      credentialKey: identity.id,
      holderPrincipal: principalKey(DEV_OWNER, identity.id).key,
      endpoint: MANAGER_ENDPOINT, lifecycleUid: iid, sourceChain: ["root"], state: "active", exp,
      generation: observed.generation, processEpoch: observed.processEpoch,
      registrationRevision: observed.registrationRevision, nameAuthorityRevision: observed.nameAuthorityRevision,
    });
    return creds;
  }

  /** P2 item 2 (spawn-as-action): stand up the standing self-mediated goal-writer connection +
   *  ActionContext. Mode-dual, mirroring {@link registerManagerService}: an AUTH mesh uses the
   *  scoped `goal-writer` credential already minted + family-STAGED inside registration's run block
   *  ({@link mintAndStageGoalWriter} — DISJOINT grant from the serve cred, SHARED §13.1 revocation
   *  family); an OPEN mesh uses a bare connection (no credential system to mint from - the broker
   *  enforces nothing). The connection presents the CURRENT credential on every (re)connect (a
   *  renewal is adopted without reconnecting the whole endpoint); the ActionContext bonds its
   *  KV + JS + JSM to this one connection and space (SPEC 13.4), so a composition mixup cannot splice
   *  goal state across brokers. */
  private async startGoalWriter(): Promise<void> {
    const identity = this.auth ? this.goalWriterIdentity! : newIdentity();
    const enc = new TextEncoder();
    // The mutable holder captured by the authenticator (mirrors the serve connection): a half-TTL
    // renewal updates `gw.creds` and the next (re)connect presents the refreshed credential.
    const gw: { nc: NatsConnection; ctx: ActionContext; creds?: string; identity: Identity; gate?: EpIssuanceGate } =
      { nc: undefined as unknown as NatsConnection, ctx: undefined as unknown as ActionContext, creds: this.auth ? this.goalWriterCreds : undefined, identity };
    const nc = await connect({
      servers: this.servers ?? DEFAULT_SERVER,
      ...(this.auth ? { authenticator: (nonce?: string) => credsAuthenticator(enc.encode(gw.creds!))(nonce) } : {}),
      inboxPrefix: `_INBOX_${identity.id}`,
      maxReconnectAttempts: -1,
    });
    nc.closed().then((err) => { if (err) console.error(`! manager goal-writer connection closed: ${err.message}`); });
    gw.nc = nc;
    // The (i) fence resolver (SPEC 13.6 P2 item 3): resolve an executing instance's CURRENT gate
    // epoch. This manager reconciles only ITS OWN goals (security pin 4), so it resolves its own
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
    this.goalWriter = gw;
    console.error(`manager goal-writer standing (endpoint ${MANAGER_ENDPOINT}, ${this.auth ? "scoped cred, §13.1 family-staged" : "open/bare"})`);
  }

  /** Drain the goal-writer connection (best-effort, both exit paths). */
  private async stopGoalWriter(): Promise<void> {
    const gw = this.goalWriter;
    if (!gw) return;
    this.goalWriter = undefined;
    try { await gw.nc.drain(); } catch { try { gw.nc.close(); } catch { /* best effort */ } }
  }

  /** P2 item 6: mint the standing `session-ledger` credential and STAGE it into this instance's
   *  §13.1 revocation family (`epcred.<e>.<iid>`), over the passed executor's `authKv` — EXACTLY the
   *  {@link mintAndStageGoalWriter} pattern, under the same open-and-commit fence.
   *
   *  This credential carries the DEDICATED sessions-bucket ledger rows and no session rail at all.
   *  It therefore takes no epoch pin: §13.6 makes it the durable revocation authority that must
   *  outlive the serving endpoint, so scoping it to one serving epoch would defeat its purpose. The
   *  epoch lives where it belongs, on the per-session serving credentials, which are minted per
   *  redemption into this same family. Re-minting the SAME nkey on renewal writes a DISTINCT ledger
   *  row (per-JWT credentialId digest). */
  private async mintAndStageSessionLedger(authKv: KV): Promise<string> {
    const auth = this.auth!;
    const identity = this.sessionLedgerIdentity!;
    // Registration instanceId (item 3's persisted logical id), not the per-process lifecycleUid:
    // the barrier enumerates `epcred.<e>.<managerInstanceId>`, so the ledger cred joins that family.
    const iid = this.managerInstanceId;
    const fence = serveIssuanceGateKv(authKv, this.space, { endpoint: MANAGER_ENDPOINT, instanceId: iid });
    const observed = await fence.observe();
    if (observed === null)
      throw new Error(`the issuance gate for ${MANAGER_ENDPOINT}/${iid} vanished; the session-ledger cred cannot join its §13.1 revocation family`);
    const creds = await mintCreds(auth, identity, "session-ledger");
    const exp = inspectCredHealth(creds).exp;
    if (exp === undefined)
      throw new Error(`the session-ledger credential for ${MANAGER_ENDPOINT}/${iid} is unbounded; the §13.1 ledger row requires an expiry`);
    // The §13.1 open-and-commit fence (see {@link mintAndStageGoalWriter}): stage + revision-pinned
    // commit against the gate this mint's grant was scoped from, releasing only on the win.
    await commitSiblingIssuance(fence, observed, {
      credentialId: rawDigest(creds).replace("sha256:", "sha256-"),
      credentialKey: identity.id,
      holderPrincipal: principalKey(DEV_OWNER, identity.id).key,
      endpoint: MANAGER_ENDPOINT, lifecycleUid: iid, sourceChain: ["root"], state: "active", exp,
      generation: observed.generation, processEpoch: observed.processEpoch,
      registrationRevision: observed.registrationRevision, nameAuthorityRevision: observed.nameAuthorityRevision,
    });
    return creds;
  }

  /** P2 item 6: stand up the ONE §13.6 session plane on its own standing connection. Mode-dual,
   *  mirroring {@link startGoalWriter}: an AUTH mesh presents the scoped `session-ledger` cred
   *  already minted + family-staged inside registration's run block ({@link mintAndStageSessionLedger});
   *  an OPEN mesh uses a bare connection (no credential system to mint from). The connection presents
   *  the CURRENT credential on every (re)connect, so a half-TTL renewal is adopted without reconnecting.
   *
   *  The offer SIGNER is a per-incarnation in-memory keypair: the static collapsed path mints AND
   *  redeems the offer in one call ({@link ManagerSessionPlane.establishAttach}), so the manager
   *  self-signs and self-verifies its own §13.6 grants and the keypair never leaves the process — a
   *  holder never verifies the signature (it presents the grant back over the rail; the broker's
   *  per-session caller cred is the holder's real fence). The plane's ledger lives in the DEDICATED
   *  sessions bucket (createEndpointStreams provisioned it at registration). */
  private async startSessionPlane(): Promise<void> {
    const identity = this.auth ? this.sessionLedgerIdentity! : newIdentity();
    const enc = new TextEncoder();
    // The mutable holder captured by the authenticator (mirrors the goal-writer): a half-TTL renewal
    // updates `sw.creds` and the next (re)connect presents the refreshed credential.
    const sw: { nc: NatsConnection; creds?: string } =
      { nc: undefined as unknown as NatsConnection, creds: this.auth ? this.sessionLedgerCreds : undefined };
    const nc = await connect({
      servers: this.servers ?? DEFAULT_SERVER,
      ...(this.auth ? { authenticator: (nonce?: string) => credsAuthenticator(enc.encode(sw.creds!))(nonce) } : {}),
      inboxPrefix: `_INBOX_${identity.id}`,
      maxReconnectAttempts: -1,
    });
    nc.closed().then((err) => { if (err) console.error(`! manager session-ledger connection closed: ${err.message}`); });
    sw.nc = nc;
    const serveEpoch = this.serviceServe?.grant.epoch;
    if (serveEpoch === undefined)
      throw new Error("the manager session plane needs the serve grant epoch; registerManagerService must run first");
    const ledgerKv = await openSessionLedgerKv(nc, sessionsBucket(this.space));
    const signer = newArtifactSigner();
    const keyId = `mgr-sessions-${identity.id.slice(0, 12)}`;
    const anchor: SignerAnchor = {
      keyId, publicKey: signer.publicKey, owner: MANAGER_ENDPOINT, roles: ["sessions"],
      scope: { sessions: [MANAGER_ENDPOINT] }, validFrom: Date.now() - 60_000, validTo: Date.now() + SESSION_GRANT_MAX_TTL_MS,
    };
    this.sessionPlane = new ManagerSessionPlane({
      space: this.space,
      // The session's serving identity is the persisted REGISTRATION instanceId (item 3), not the
      // per-process lifecycleUid: a restarted manager re-registers the SAME logical instanceId with
      // an ADVANCED epoch, so a client re-attaches by the same instance while the epoch fences the
      // old incarnation's sessions (item 6's restart-refusal composed with item 3's addressing).
      serving: { instanceId: this.managerInstanceId, epoch: serveEpoch },
      signer: { keyId, keyPair: signer }, resolveAnchor: (id) => (id === keyId ? anchor : undefined),
      ledgerKv, ttlMs: SESSION_GRANT_MAX_TTL_MS,
      servingCredential: this.sessionServingCredentials(),
      ...(this.maxSessions !== undefined ? { maxSessions: this.maxSessions } : {}),
    });
    this.sessionLedgerConn = sw;
    console.error(`manager session plane standing (endpoint ${MANAGER_ENDPOINT}, epoch ${serveEpoch}, ${this.auth ? "scoped session-ledger cred, §13.1 family-staged" : "open/bare"})`);
  }

  /**
   * The per-session SERVING credential seam (P2 item 6, SPEC 13.6): the manager mints, gate-stages,
   * connects and revokes ONE credential per live session, replacing a standing credential that held
   * `eps.manager.*.<epoch>.{in,out}` and so reached every live session's bytes at its epoch.
   *
   * Each session gets its OWN nkey identity, so the §13.1 barrier's evict-by-holderPrincipal reaches
   * it individually, and each is staged into `epcred.manager.<instanceId>` — the SAME family the
   * ledger and goal-writer creds join. That is how manager takeover still kills a deposed manager's
   * sessions: the barrier enumerates the family, revokes every row, and evicts every holder, so the
   * per-session creds die with the incarnation exactly as the standing one did, with the blast
   * radius of a leaked credential cut from "every session at this epoch" to "one dead session".
   *
   * OPEN MESH: no credential system exists to mint from, so the seam mints nothing and opens a bare
   * connection. That is not a degraded auth path — an open mesh has no broker enforcement at all —
   * and it is still per-session: the connection and the ledger row are still one-per-session, so
   * teardown behaves identically in both modes.
   */
  private sessionServingCredentials(): SessionServing {
    const iid = this.managerInstanceId;
    const gate = async <T>(fn: (authKv: KV) => Promise<T>): Promise<T> =>
      this.withEndpointServeExecutor(({ authKv }) => fn(authKv));
    return {
      mint: async (grant) => {
        // Open mesh: no auth to mint from. The id still names the session so the ledger row and the
        // teardown path are identical in both modes.
        if (!this.auth) return { id: `${grant.sessionId}.s`, creds: "", exp: grant.exp };
        const identity = newIdentity();
        const creds = await mintCreds(this.auth, identity, "session-serving", {
          sessionServing: { endpoint: grant.endpoint, sessionId: grant.sessionId, epoch: grant.serving.epoch },
          expiresAt: Math.floor(grant.exp / 1000), // grant.exp is ms; the JWT exp is seconds
        });
        const health = inspectCredHealth(creds);
        if (health.exp === undefined)
          throw new Error(`the session-serving credential for ${grant.sessionId} is unbounded; a per-session credential never outlives its session (SPEC 13.6)`);
        this.sessionServingKeys.set(rawDigest(creds).replace("sha256:", "sha256-"), identity.id);
        return { id: rawDigest(creds).replace("sha256:", "sha256-"), creds, exp: grant.exp };
      },
      observeGate: async (_endpoint, instanceId) => {
        // Open mesh: nothing is minted and nothing is staged, so there is no gate to pin (see
        // ServingGatePin.gate — the stage refuses loudly if this is ever missing on an auth mesh).
        if (!this.auth) return { key: epgateKey(MANAGER_ENDPOINT, instanceId), revision: 0 };
        return gate(async (authKv) => {
          const observed = await serveIssuanceGateKv(authKv, this.space, { endpoint: MANAGER_ENDPOINT, instanceId }).observe();
          if (observed === null)
            throw new Error(`the issuance gate for ${MANAGER_ENDPOINT}/${instanceId} vanished; a session credential never stages against a missing gate (SPEC 13.1)`);
          // The WHOLE observation rides the pin: the stage's fence compares every field of it, which
          // is what lets a lost CAS be classified rather than blanket-refused.
          return { key: epgateKey(MANAGER_ENDPOINT, instanceId), revision: observed.revision, gate: observed };
        });
      },
      stage: async (grant, cred, pin) => {
        if (!this.auth) return; // open mesh: nothing minted, so nothing to make revocable
        const key = this.sessionServingKeys.get(cred.id);
        if (key === undefined)
          throw new Error(`no minted identity for session credential ${cred.id}; the stage cannot record a holder it did not mint (SPEC 13.1)`);
        // THE REDEMPTION'S OWN PIN IS THE FENCE, and it is never re-read into something newer here:
        // `commitSiblingIssuance` CASes on this observation's revision and, on a loss, refuses unless
        // the gate is still identical to it in every field but the revision. A barrier
        // (freeze, or reopen at a successor coordinate) is therefore always a refusal, while another
        // session's identical-bytes commit touch is not — per-session credentials all serialize on
        // this one gate key, so refusing on that would fail live sessions for contention rather than
        // for a barrier. A read is never a fence (SPEC 13.1); the pinned CAS is.
        const observed = pin.gate;
        if (observed === undefined)
          throw new Error(`the redemption of session ${grant.sessionId} carries no gate observation for ${MANAGER_ENDPOINT}/${iid}; a session credential never stages unfenced (SPEC 13.1)`);
        await gate(async (authKv) => {
          const fence = serveIssuanceGateKv(authKv, this.space, { endpoint: MANAGER_ENDPOINT, instanceId: iid });
          await commitSiblingIssuance(fence, observed, {
            credentialId: cred.id,
            credentialKey: key,
            holderPrincipal: principalKey(DEV_OWNER, key).key,
            endpoint: MANAGER_ENDPOINT, lifecycleUid: iid,
            // The lineage records that this credential exists because a session was redeemed, so a
            // ledger reader can tell a per-session row from a standing one (SPEC 13.6 sourceChain).
            sourceChain: [`session.${grant.sessionId}`], state: "active",
            exp: Math.floor(cred.exp / 1000),
            generation: observed.generation, processEpoch: observed.processEpoch,
            registrationRevision: observed.registrationRevision, nameAuthorityRevision: observed.nameAuthorityRevision,
          });
        });
      },
      open: async (cred) => {
        // FAIL LOUD: there is deliberately no shared connection to fall back to. Serving a session
        // without its own credential is exactly the standing-writer shape this design removes.
        const opts = this.auth ? standaloneConnectOpts({ creds: cred.creds, /* not yet wired to a recorded transport */ tls: false }) : {};
        return connect({ servers: this.servers ?? DEFAULT_SERVER, ...opts, maxReconnectAttempts: -1 });
      },
      revoke: async (credentialId) => {
        if (!this.auth) return; // open mesh: nothing was minted
        await gate(async (authKv) => {
          await markLedgerRowRevoked(authKv, epcredRowKey(MANAGER_ENDPOINT, iid, credentialId));
        });
        this.sessionServingKeys.delete(credentialId);
      },
    };
  }

  /** Tear the session plane down (best-effort, both exit paths): end every live bridge with the
   *  honest `manager-restart` reason (this incarnation is going away; any successor takes a new epoch
   *  and refuses these grants), then drain each session's own connection and the ledger connection. */
  private async stopSessionPlane(): Promise<void> {
    const plane = this.sessionPlane;
    const sw = this.sessionLedgerConn;
    this.sessionPlane = undefined;
    this.sessionLedgerConn = undefined;
    // `drain` awaits each session's teardown (connection close, terminal row, credential revoke);
    // `endAll` alone would let the process exit with per-session connections still open.
    try { await plane?.drain("manager-restart"); } catch { /* best effort */ }
    if (sw) { try { await sw.nc.drain(); } catch { try { sw.nc.close(); } catch { /* best effort */ } } }
  }

  /** P2 item 2 must-5 Q-B — the boot reconcile: a fresh incarnation (a manager restart takes a NEW
   *  instanceId, so the in-memory acceptance map starts empty) inherits the endpoint's accepted-but-
   *  unterminal goals from any predecessor. Enumerate the durable index over a scoped PROVISIONER
   *  (records CONSUMER.CREATE; the goal-writer holds NO enumeration grant, exactly the ruling) and
   *  settle each orphan so an accepted goal is NEVER dropped across a restart. Open mesh: a bare
   *  connection (the broker enforces nothing). Runs ONCE at start, BEFORE spawn-as-action begins
   *  accepting (the `goalReconcileDone` gate), so it never races a live goal's acceptance. Never
   *  fatal — a reconcile failure is logged and the gate opens either way. */
  private async reconcileGoalIndex(): Promise<void> {
    const gw = this.goalWriter;
    if (!gw) { this.goalReconcileDone = true; return; }
    try {
      let entries: { ref: GoalRef; iid: string }[] = [];
      const nc = this.auth
        ? await connect({ servers: this.servers ?? DEFAULT_SERVER, ...standaloneConnectOpts({ creds: await mintCreds(this.auth, newIdentity(), "provisioner"), /* not yet wired to a recorded transport */ tls: false }), maxReconnectAttempts: 0 })
        : await connect({ servers: this.servers ?? DEFAULT_SERVER, maxReconnectAttempts: 0 });
      try {
        const kvm = new Kvm(nc);
        await ensureAuthorityStores(await jetstreamManager(nc), kvm, this.space);
        entries = await listGoalIndex(await kvm.open(recordsBucket(this.space)), MANAGER_ENDPOINT);
      } finally {
        await nc.drain().catch(() => nc.close());
      }
      // Single-manager item 2: EVERY inherited entry belongs to a DEAD predecessor (only one manager
      // at a time), so all are reconciled. The `iid` field is the hook item-3's multi-instance sweep
      // filters on (skip a goal whose accepting `iid` is a still-LIVE sibling — never settle its goal).
      for (const { ref, iid } of entries) {
        if (this.goalAcceptances.has(ref.goalId)) continue; // never settle a goal THIS incarnation drives
        try { await this.reconcileOneGoal(ref, iid); }
        catch (e) { console.error(`! goal reconcile for ${ref.goalId}: ${(e as Error).message}`); }
      }
      if (entries.length) console.error(`goal-index boot reconcile: swept ${entries.length} inherited goal(s)`);
    } catch (e) {
      console.error(`! goal-index boot reconcile failed: ${(e as Error).message} - accepted goals from a predecessor may stay unsettled until the next restart`);
    } finally {
      this.goalReconcileDone = true;
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
    // only to epoch-scope the terminal subject and is gone with it (SPEC:1394).
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
    const t = setTimeout(() => { settle().catch((e) => console.error(`! goal reconcile settle ${ref.goalId}: ${(e as Error).message}`)); }, remaining + 100);
    t.unref?.();
  }

  /** P2 item 2: publish a goal PROGRESS event on the caller-scoped epe subtree, over the SERVE
   *  connection (which holds the `epe.<e>.<iid>.<epoch>.>` egress grant; the goal-writer deliberately
   *  does not). The terminal rides a final event `phase:"terminal"` (Q1 — the caller follows epe to
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
      console.error(`! goal progress emit for ${ref.goalId} failed: ${(e as Error).message}`);
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
   *  terminal through the issuance gate's own CAS), deliberately deferred as substrate territory.
   *  An earlier revision of this comment claimed the residual was "closed by item-3 slice 3.0,
   *  never a permanent residual". That asserted a closure that does not exist. */
  private async assertGoalWriterEpochCurrent(epoch: number): Promise<void> {
    const gate = this.goalWriter?.gate;
    if (!gate) return; // no goal-writer standing yet
    const observed = await gate.observe();
    if (observed === null)
      throw new EpEnvelopeError("expired", `the manager's issuance gate for ${MANAGER_ENDPOINT}/${this.managerInstanceId} is gone; a retired incarnation never commits a goal terminal (SPEC 13.1/13.6)`);
    if (observed.processEpoch !== epoch)
      throw new EpEnvelopeError("expired", `the manager's issuance gate epoch is ${observed.processEpoch} but this goal was accepted under epoch ${epoch}; a superseded incarnation never commits a goal terminal (must-5 (a) own-gate belt, SPEC 13.6)`);
  }

  /** Serve `spawn`/`launch` as an ACTION (P2 item 2). Authz already ran in {@link serveGated}. The
   *  accept path runs INLINE on the handler ({@link startAgent} with hooks): the goal binds + the
   *  acceptance replies the moment the identity is minted, BEFORE any provision (pin 1); progress and
   *  the terminal are driven OFF-handler, so the ~30s readiness wait no longer blocks the reply.
   *  Returns the acceptance floor payload {name, owner, actor, uid, goalId, fingerprint, executor}
   *  (the ALLOCATED identity). goalId = the request id (env.id, Q3). */
  private async serveSpawnGoal(ctx: EpServeContext, run: (hooks: SpawnHooks) => Promise<ControlReply>): Promise<SpawnAcceptance> {
    const gw = this.goalWriter;
    if (!gw) throw new EpEnvelopeError("unavailable", "the manager goal-writer connection is not standing; spawn-as-action cannot accept (SPEC 13.6)");
    // must-5 Q-B: refuse to accept until the boot reconcile of inherited goals completes, so a fresh
    // acceptance never races the sweep (settling a live goal mid-flight would steal its real terminal).
    if (!this.goalReconcileDone)
      throw new EpEnvelopeError("unavailable", "the manager is still reconciling accepted goals at boot; retry shortly (SPEC 13.6)");
    const goalId = ctx.request.id;
    const { fingerprint } = submissionFingerprint(ctx.request as unknown, ctx.subject);
    const ref = goalRefOf(ctx.subject, goalId);
    const executor = { lifecycleUid: this.managerInstanceId, epoch: this.serviceServe?.grant.epoch ?? 0 };
    const epoch = executor.epoch;
    const acceptedAt = Date.now();

    // Idempotent same-goalId retry (a client re-send): serve the IDENTICAL acceptance without
    // re-running the accept path — so a HARD-PINNED retry does not trip the M6 same-name refuse and no
    // name is re-allocated. Same-incarnation rides the live map; the create-only bindGoal in onAccepted
    // still fences a CONCURRENT same-goalId race (the loser aborts and serves the winner's acceptance).
    const prior = this.goalAcceptances.get(goalId);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint)
        throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" was accepted under a different submission; one goalId never carries two specs (SPEC 13.6)`);
      return prior;
    }

    let resolveAccept!: (a: SpawnAcceptance) => void;
    let rejectAccept!: (e: unknown) => void;
    const acceptP = new Promise<SpawnAcceptance>((res, rej) => { resolveAccept = res; rejectAccept = rej; });
    let acceptance: SpawnAcceptance | undefined;
    // H1: set the instant the terminal path is ENTERED, not when it succeeds — the post-accept
    // fallback below must fire only when `onOutcome` never ran at all, never as a second attempt
    // behind a commit that threw.
    let terminalEntered = false;

    // The terminal commits OFF-handler on the goal-writer connection (manager-only authority; a
    // caller cannot publish it). TWO COMPOSED FENCES (defense in depth): must-5 (a) reads THIS
    // incarnation's OWN gate epoch and REFUSES a superseded commit (the currency belt), and (b)
    // barrier-revoke evicts this connection on takeover. The terminal lands on the ONE subject
    // SPEC:1394 reserves; first-terminal-fact-wins is global, so a committed outcome is visible
    // to every reader in every incarnation. On success the reconcile-index entry is cleared.
    //
    // Named rather than inlined into the hooks below so the H1 post-accept fallback drives THIS
    // path — one commit site, so the progress event, the index clear and the `agentGoals` cleanup
    // cannot drift between a normal outcome and a recovered one.
    const onOutcome = async (o: { kind: "succeeded" | "failed" | "uncertain"; data?: unknown }): Promise<void> => {
      terminalEntered = true; // entered, not succeeded — see the catch below
      try {
        await this.assertGoalWriterEpochCurrent(epoch); // must-5 (a): a superseded corpse never commits
        let fact;
        if (o.kind === "succeeded") {
          this.emitGoalProgress(ref, epoch, { phase: "presence" });
          ({ fact } = await commitGoalResult(gw.ctx, { ref, now: Date.now(), cause: "complete", state: "succeeded", data: o.data, committer: { instanceId: this.managerInstanceId, epoch } }));
        } else if (o.kind === "failed") {
          ({ fact } = await commitGoalResult(gw.ctx, { ref, now: Date.now(), cause: "complete", state: "failed", data: o.data, committer: { instanceId: this.managerInstanceId, epoch } }));
        } else {
          ({ fact } = await settleGoalUncertain(gw.ctx, { ref, now: Date.now(), committer: { instanceId: this.managerInstanceId, epoch } }));
        }
        this.emitGoalProgress(ref, epoch, { phase: "terminal", state: fact.state, ...(fact.data !== undefined ? { data: fact.data } : {}) });
        await clearGoalIndex(gw.ctx, ref); // must-5 Q-B: terminal reached - the successor never reconciles it
        if (acceptance) this.agentGoals.delete(acceptance.name); // goal terminal - no cancel path left
      } catch (e) {
        // THE NARROWER LEG, LEFT OPEN DELIBERATELY. If the COMMIT ITSELF throws (the currency belt
        // refused a superseded commit, or the broker failed) there is genuinely no terminal, and the
        // H1 fallback must NOT retry it: a retry either loses the same way or overwrites a real
        // supersession refusal with a manufactured outcome. That is why `terminalEntered` is set on
        // ENTRY. This leg is infrastructure-class and converges through the reconcile index at the
        // next boot, which is why the index is NOT cleared above on this path. Do not "close" it
        // here with a retry loop.
        console.error(`! goal terminal commit for ${goalId} failed: ${(e as Error).message}`);
      }
    };

    const bg = run({
      onAccepted: async ({ name, agentTriple }) => {
        // must-5 Q-B: record the goal in the reconcile index BEFORE the bind (index-CAS-before-bind),
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
        const idx = await recordGoalIndex(gw.ctx, ref, executor.lifecycleUid, { name, actor: agentTriple.actor, uid: agentTriple.uid });
        // A create loss is an idempotent retry ONLY for the same incarnation. A FOREIGN iid means a
        // sibling instance accepted this goalId (the live vector is a client retry over ANYCAST, not
        // a journal consumer): this attempt provisions nothing and answers with the winner's floor,
        // or refuses if that instance never persisted one.
        if (!idx.recorded && idx.existing.iid !== executor.lifecycleUid) {
          acceptance = this.acceptanceFromIndex(idx.existing, goalId, fingerprint, executor);
          resolveAccept(acceptance);
          throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" was accepted by instance "${idx.existing.iid}"; that instance's acceptance is served and this attempt provisions nothing (SPEC 13.6)`);
        }
        // Bind AFTER the accept-path checks (M6/capacity/persona) + identity mint, BEFORE any provision:
        // a create-only CAS per goalId (pin 1 — a refused accept above left zero bind, zero reserve).
        const b = await bindGoal(gw.ctx, ref, fingerprint);
        if (!b.bound) {
          if (b.existing.fingerprint !== fingerprint)
            throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" is already bound to a different submission; one goalId never carries two specs (SPEC 13.6)`);
          // Lost a concurrent same-goalId race: serve the winner's acceptance and abort THIS provision
          // (no second spawn). The throw unwinds to the finally, which releases this attempt's reserve.
          acceptance = this.goalAcceptances.get(goalId) ?? await this.cachedSpawnAcceptance(ref, goalId, fingerprint, executor);
          resolveAccept(acceptance);
          // Unwind the provision (the acceptance is already served); the code is discarded by the
          // caller (acceptance !== undefined), so it just aborts this attempt's side-effects.
          throw new EpEnvelopeError("failed-precondition", `goal "${goalId}" is already accepted; the cached acceptance is served`);
        }
        await createGoal(gw.ctx, ref, {
          fingerprint,
          command: ctx.subject.command,
          caller: { id: `${ctx.subject.caller.owner}.${ctx.subject.caller.actor}`, lifecycleUid: ctx.subject.caller.uid },
          // The ACCEPTING incarnation's epoch: half of the terminal's attribution pair (§13.6).
          acceptedEpoch: epoch,
          requestId: goalId,
          sourceSeq: 0,
          acceptedAt,
          readinessDeadlineMs: this.readinessTimeoutMs,
        });
        acceptance = { name, owner: agentTriple.owner, actor: agentTriple.actor, uid: agentTriple.uid, goalId, fingerprint, executor };
        this.goalAcceptances.set(goalId, acceptance);
        this.agentGoals.set(name, ref); // M4: a despawn of this name mid-goal drives the cancel path
        resolveAccept(acceptance);
        this.emitGoalProgress(ref, epoch, { phase: "handoff" });
      },
      onLaunched: () => this.emitGoalProgress(ref, epoch, { phase: "launched" }),
      onOutcome,
      // Claim the terminal WITHOUT committing one: the despawn/stop that ended this launch owns
      // it and commits `cancel`. This only stops the non-ok reply below from manufacturing a
      // `failed` that would race that `cancel` (first-terminal-fact-wins).
      onTerminalDeferred: () => { terminalEntered = true; },
    });
    bg.then((reply) => {
      // Refused BEFORE onAccepted (M6 hard-pin collision, capacity, persona-not-found) — no goal bound.
      if (acceptance === undefined) { rejectAccept(new EpEnvelopeError("failed-precondition", reply.error ?? "spawn refused at accept")); return; }
      // H1: `run` CATCHES its own body (a throw in buildLaunch/runtime.spawn) and RESOLVES `{ok:false}`
      // rather than rejecting, so a post-accept failure arrives here, not in the catch below, and
      // reaches none of the onOutcome sites. Without this the goal stays accepted-but-unanswered:
      // the caller follows epe to a terminal that never comes, and the reconcile index that would
      // settle it is only swept at BOOT, so a manager that stays up never converges it.
      if (reply.ok === false && !terminalEntered) return onOutcome({ kind: "failed", data: { error: reply.error ?? "spawn failed after accept" } });
    }).catch((e) => {
      if (acceptance === undefined) { rejectAccept(e); return; }
      // Same obligation for a genuine rejection (one that escaped `run`'s own catch).
      if (!terminalEntered) return onOutcome({ kind: "failed", data: { error: (e as Error)?.message ?? String(e) } });
      console.error(`! spawn-as-action async body for ${goalId}: ${(e as Error)?.message ?? String(e)}`);
    }).catch((e) => console.error(`! goal terminal fallback for ${goalId}: ${(e as Error)?.message ?? String(e)}`));
    return acceptP;
  }

  /** H2: an acceptance served from a WINNER'S durable acceptance floor (the goal-index entry it
   *  wrote before its own ack). Refuses `unavailable` rather than inventing one — see
   *  {@link cachedSpawnAcceptance} for why an empty identity is never an acceptable answer. */
  private acceptanceFromIndex(entry: GoalIndexEntry, goalId: string, fingerprint: string, executor: { lifecycleUid: string; epoch: number }): SpawnAcceptance {
    if (entry.allocated === undefined)
      throw new EpEnvelopeError("unavailable", `goal "${goalId}" was accepted by instance "${entry.iid}", which persisted no acceptance floor; its allocated identity is not readable from here (SPEC 13.6)`);
    return { name: entry.allocated.name, owner: DEV_OWNER, actor: entry.allocated.actor, uid: entry.allocated.uid, goalId, fingerprint, executor };
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
   *  `unavailable`, never a hollow success. */
  private async cachedSpawnAcceptance(ref: GoalRef, goalId: string, fingerprint: string, executor: { lifecycleUid: string; epoch: number }): Promise<SpawnAcceptance> {
    const entry = await readGoalIndex(this.goalWriter!.ctx, ref);
    if (entry?.allocated !== undefined) return this.acceptanceFromIndex(entry, goalId, fingerprint, executor);
    // The index is CLEARED at terminal, so a settled goal legitimately has no entry: fall back to
    // the terminal's data, which carries the same identity for exactly that case.
    const result = await readGoalResult(this.goalWriter!.ctx, ref);
    const d = (result?.data ?? {}) as { name?: string; id?: string; lifecycleUid?: string };
    if (typeof d.name === "string" && d.name.length > 0 && typeof d.id === "string" && d.id.length > 0 && typeof d.lifecycleUid === "string" && d.lifecycleUid.length > 0)
      return { name: d.name, owner: DEV_OWNER, actor: d.id, uid: d.lifecycleUid, goalId, fingerprint, executor };
    throw new EpEnvelopeError("unavailable", `goal "${goalId}" is already accepted but its allocated identity is not readable (no acceptance floor, and no terminal carrying one); retry (SPEC 13.6)`);
  }

  /** M4 (settle race): a despawn MID-GOAL drives the goal's cancel terminal - transition to
   *  `cancelling`, then commit the `cancel` cause on the goal-writer connection. First-terminal-fact
   *  wins: if the readiness outcome already committed (succeeded/failed/uncertain) the transition or
   *  the create-only commit loses gracefully and the readiness terminal stands. Fire-and-forget from
   *  despawn (the process teardown is authoritative for the agent; this settles the GOAL honestly).
   *  Cancel rides the despawn's own authorizeNamed reach (pin 5) - there is no cancel-by-goalId. */
  private async cancelAgentGoal(name: string, mode: "graceful" | "terminate"): Promise<void> {
    const gw = this.goalWriter;
    const ref = this.agentGoals.get(name);
    if (!gw || !ref) return;
    this.agentGoals.delete(name);
    const epoch = this.serviceServe?.grant.epoch ?? 0;
    try {
      await this.assertGoalWriterEpochCurrent(epoch); // must-5 (a): a superseded corpse never commits a cancel terminal either
      await transitionGoal(gw.ctx, ref, "cancelling", { fields: { cancelMode: mode } });
      const r = await commitGoalResult(gw.ctx, { ref, now: Date.now(), cause: "cancel", data: { cancelledBy: "despawn" }, committer: { instanceId: this.managerInstanceId, epoch } });
      this.emitGoalProgress(ref, epoch, { phase: "terminal", state: r.fact.state, ...(r.fact.data !== undefined ? { data: r.fact.data } : {}) });
      await clearGoalIndex(gw.ctx, ref); // must-5 Q-B: terminal reached - the successor never reconciles it
    } catch {
      // the goal already terminalized (the readiness outcome won the settle race) - nothing to cancel.
    }
  }

  /** The static F1 terminal for one departed incarnation (Unit B): delegates the gate/head CAS
   *  sequence to the shared core saga over the executor transport; the footprint teardown (creds
   *  file + broker durables/ACL) runs INSIDE the barrier as its cleanup step. On completion the
   *  wire principal joins {@link retiredPrincipals} (the F5 refusal index) and the name hold
   *  clears (ABA-guarded by uid). A PRE-UNIT-B lifecycle (no slot row — spawned before the
   *  durable registry existed) has nothing to terminalize: its footprint teardown runs directly
   *  and the hold clears, the honest upgrade path. */
  private async driveStaticRetirement(a: { id: string; name: string; lifecycleUid: string; secretPaths?: ManagedAgent["secretPaths"] }): Promise<void> {
    const opId = retireOpId(a.lifecycleUid);
    const cleanup = async (): Promise<void> => {
      const secrets = this.secrets;
      const files = a.secretPaths ?? agentLifecycleSecretFilePaths(this.workspaceRoot, a.name, a.lifecycleUid);
      if (files.creds) {
        await secrets.delete(agentSecretKeyForFile(files.creds));
        rmSync(files.creds, { force: true });
      }
      await this.deprovisionBroker(a);
    };
    try {
      await this.withLifecycleExecutor({ owner: DEV_OWNER, actor: a.id, lifecycleUid: a.lifecycleUid, alias: a.name }, async (t) => {
        const slot = await readStaticSlot(t, DEV_OWNER, a.name);
        if (slot === undefined || slot.row.lifecycleUid !== a.lifecycleUid) {
          // No durable registration for THIS incarnation: a pre-Unit-B spawn (or a slot already
          // replaced by a successor — then this stale teardown must not touch the registry at all).
          await cleanup();
          return;
        }
        await runStaticTerminal(
          t,
          { owner: DEV_OWNER, alias: a.name, actor: a.id, lifecycleUid: a.lifecycleUid, opId },
          { cleanup, log: (line) => console.error(`static retirement ${a.name}: ${line}`) },
        );
      });
      this.retiredPrincipals.add(principalKey(DEV_OWNER, a.id).key);
      const cur = this.retiring.get(a.name);
      if (cur && cur.lifecycleUid === a.lifecycleUid) this.retiring.delete(a.name); // ABA-guarded hold clear
    } catch (e) {
      const h = this.retiring.get(a.name);
      if (h && h.lifecycleUid === a.lifecycleUid)
        h.lastError = `the static retirement did not complete (${(e as Error).message}); the name stays held - a same-name spawn retries the same terminal (op ${opId})`;
      console.error(`static retirement ${a.name} (${a.id}): ${(e as Error).message}`);
    }
  }

  /** F5(b) push renewal of ONE live managed-static credential (Unit B): re-mint the SAME nkey
   *  identity with the SAME scope (recorded on the managed row at spawn) and a fresh bounded
   *  exp, ledger the new credentialId (slot record first, then the row, then the file — a
   *  credential is never materialized before its ledger row exists), and re-sign the SAME
   *  lifecycle-keyed file the agent endpoint's source seam re-reads. Never advances the epoch,
   *  never routes through any barrier (renewal is the THIRD transition). */
  private async renewManagedStaticCred(a: ManagedAgent): Promise<void> {
    if (!this.auth || !a.seed || !a.secretPaths?.creds) throw new Error("renewManagedStaticCred: not a renewable managed-static agent");
    // THIS CHECK IS THE AUTHORITATIVE ONE. The renewal sweep's own `a.terminalizing` filter is an
    // optimisation that has already-awaited by the time it matters; removing or weakening this line
    // promotes that filter into the whole guard, with nothing failing at the moment of the change.
    //
    // CONFIRMED, OPEN, AND UNGATED. This check runs at ENTRY and there are FOUR awaits before the
    // two writes below (`secrets.put` and `materializeSecretToFile`). A despawn landing in that
    // window latches `terminalizing` and the retirement cleanup deletes exactly those two things —
    // same secret key, same path — so an in-flight renewal RE-CREATES a valid bounded credential
    // after teardown removed it, and `appendStaticCredentialRow` lands in the window too, which is
    // the worse half: a stale file is recoverable by re-running cleanup, a durable credential row
    // is the journal asserting the credential is legitimate.
    //
    // Reproduced by `smoke:renewal-terminal-race` (`renewal-terminal-race.smoke.ts`), which asserts
    // the DURABLE ROW rather than the file — the file is timing-dependent, the row is a KV read.
    // That suite is deliberately NOT in `smoke:ci`: it is expected RED until this is fixed, and
    // gating a known red trains readers to treat the gate as noisy. So the absence of a red here
    // is not evidence this is closed; run that suite.
    //
    // Reproduced on the FIRST attempt that reached the race, and that suite cannot produce a second:
    // the alias frees only when teardown completes, and the defect is that teardown does not, so
    // every later attempt is refused at spawn. That is a limit of the probe, NOT of the world — a
    // FRESH ALIAS PER ATTEMPT makes a rate measurable. Do not read hits-over-attempts off that file
    // as written; it is a number that is not a count.
    //
    // The fix is to make the WRITES conditional on the same latch the teardown orders against,
    // never to retry: the correct outcome is "no credential", never "a credential minted later".
    if (a.terminalizing) throw new Error("renewManagedStaticCred: the lifecycle is terminalizing; no credential is minted after the terminal begins");
    const exp = Math.floor(Date.now() / 1000) + MANAGED_STATIC_TTL_SEC;
    // The SAME permission scope the spawn minted (recorded on the managed row): allowSubscribe/
    // allowPublish/role/capabilities are the JWT-shaping inputs; `subscribe` (the active read
    // set) shapes durable membership only and is not a mint input.
    const creds = await mintCreds(this.auth, { id: a.id, seed: a.seed }, "agent", {
      allowSubscribe: a.launch.allowSubscribe,
      allowPublish: a.launch.allowPublish,
      role: a.role,
      capabilities: a.launch.capabilities,
      lifecycleUid: a.lifecycleUid,
      expiresAt: exp,
    });
    const credentialId = rawDigest(creds).replace("sha256:", "sha256-");
    await this.withLifecycleExecutor({ owner: DEV_OWNER, actor: a.id, lifecycleUid: a.lifecycleUid, alias: a.name }, async (t) => {
      await recordSlotCredential(t, DEV_OWNER, a.name, a.lifecycleUid, credentialId);
      await appendStaticCredentialRow(t, { lifecycleUid: a.lifecycleUid, credentialId, holderPrincipal: principalKey(DEV_OWNER, a.id).key, exp });
    });
    const secrets = this.secrets;
    await secrets.put(agentSecretKeyForFile(a.secretPaths.creds), creds);
    await materializeSecretToFile(secrets, agentSecretKeyForFile(a.secretPaths.creds), a.secretPaths.creds);
    console.error(`managed cred renewal ${a.name}: re-signed for the same identity (exp +${MANAGED_STATIC_TTL_SEC}s); the agent endpoint's source re-read adopts it`);
  }

  /** The Unit B reconciliation (F3 "no active orphan"): ensure the authority stores, then sweep
   *  every durable slot row and act by the TOTAL resume table — `provisioning`/`terminalizing`
   *  re-drive the exact-op terminal; an `active` row survives ONLY when a LIVE managed agent this
   *  process owns backs it at the same uid (`adopted`), else its process is gone and it
   *  terminalizes; `retired` rows seed the F5 refusal index. Two call sites: the BOOT sweep
   *  (`postAdoption=false`, under the lease before control serving) DEFERS active-non-adopted
   *  slots while a resume is still pending (adoption runs after it); the POST-ADOPTION sweep
   *  (`postAdoption=true`, inside finalizeResume while `resumeRequired` still fences ordinary
   *  spawns) terminalizes any active slot the resume did not claim. */
  private async reconcileStaticLifecycles(postAdoption = false): Promise<void> {
    if (!this.auth) return;
    const identity = newIdentity();
    const creds = await mintCreds(this.auth, identity, "provisioner");
    const nc = await connect({ servers: this.servers ?? DEFAULT_SERVER, ...standaloneConnectOpts({ creds, /* not yet wired to a recorded transport */ tls: false }), maxReconnectAttempts: 0 });
    const slotRows: StaticManagedSlotRow[] = [];
    try {
      const jsm = await jetstreamManager(nc);
      const kvm = new Kvm(nc);
      await ensureAuthorityStores(jsm, kvm, this.space);
      const recordsKv = await kvm.open(recordsBucket(this.space));
      const t = staticLifecycleTransport(recordsKv, recordsKv /* auth reads unused in the sweep */);
      const keys = await recordsKv.keys(`${STATIC_SLOT_PREFIX}.${DEV_OWNER}.>`);
      const aliases: string[] = [];
      for await (const k of keys) aliases.push(k.split(".").slice(2).join("."));
      for (const alias of aliases) {
        const slot = await readStaticSlot(t, DEV_OWNER, alias);
        if (slot !== undefined) slotRows.push(slot.row);
      }
    } finally {
      await nc.drain().catch(() => nc.close());
    }
    for (const row of slotRows) {
      if (row.phase === "retired") {
        // A retirement is a GLOBAL refusal fact — seed the F5 index for EVERY retired incarnation
        // regardless of which instance owned it, so a sibling-retired incarnation's copied credential
        // is refused at this control surface too. Ownership gates only the DESTRUCTIVE sweep below.
        this.retiredPrincipals.add(principalKey(row.owner, row.actor).key);
        continue;
      }
      // 3b-2 RECONCILE OWNERSHIP (multi-manager-per-space): a manager adjudicates ONLY the non-retired
      // rows THIS logical instance owns. A SIBLING manager's active/provisioning row is LEFT UNTOUCHED —
      // sweep-terminalizing it would destroy the sibling's live agent (the historical all-agents-kill
      // hazard, now cross-instance). A legacy row (pre-3b-2, no owner recorded) predates multi-manager,
      // so this manager is its legitimate single-manager-past successor and reconciles it. An orphaned
      // sibling row is reclaimed only by an explicit operator CAS takeover (ruling 1), never here.
      if (row.ownerInstanceId !== undefined && row.ownerInstanceId !== this.managerInstanceId) continue;
      // ADOPTION is genuine membership: a slot backed by a live managed agent THIS process owns
      // at the SAME uid is never an orphan (empty at boot; exactly the adopted set at the
      // post-adoption sweep — the fix for the F3 resume hole).
      const live = this.agents.get(row.alias);
      const adopted = live !== undefined && live.lifecycleUid === row.lifecycleUid;
      // Boot sweep with a resume PENDING: an active slot may yet be adopted (the resume path runs
      // AFTER this boot sweep), so DEFER it — the post-adoption sweep terminalizes any the resume
      // did not claim. provisioning/terminalizing NEVER defer (they are crashed operations, never
      // an agent to adopt). At `postAdoption` (or a non-resume boot) nothing defers.
      if (!postAdoption && row.phase === "active" && !adopted && this.resumeRequired) continue;
      const action = planStaticSlotResume(row, adopted);
      if (action === "none") continue;
      console.error(`static reconcile ${row.alias}: slot is ${row.phase} with no live managed owner${postAdoption ? " after resume adoption" : ""} - driving its exact-op terminal (uid ${row.lifecycleUid})`);
      await this.driveStaticRetirement({ id: row.actor, name: row.alias, lifecycleUid: row.lifecycleUid });
    }
  }

  /** The F5(a) membership gate (Unit B, the F5-bind design): decide a control caller by its
   *  AUTHENTICATED wire principal. A LIVE managed slot passes (unless terminalizing); a RETIRING
   *  hold or a RETIRED static incarnation refuses even with a tier-valid JWT (the
   *  copied-credential vector — its subject can never collide with a successor's, so this match
   *  is non-forgeable); any OTHER principal is not a managed lifecycle (an operator instrument:
   *  the credential tier governs, exactly as before). Never name alone, never a payload field. */
  private lifecycleMembershipRefusal(caller: string): string | undefined {
    for (const a of this.agents.values()) {
      if (this.managedPrincipal(a) === caller)
        return a.terminalizing
          ? `the caller's lifecycle ${a.lifecycleUid} is terminalizing; control is refused from the first terminal step (F5)`
          : undefined;
    }
    for (const [name, hold] of this.retiring) {
      const held = hold.userOwner ? hold.agentId : principalKey(DEV_OWNER, hold.agentId).key;
      if (held === caller)
        return `the caller's lifecycle ${hold.lifecycleUid} (name "${name}") is retiring; a retiring incarnation's credential holds no control authority (F5)`;
    }
    if (this.retiredPrincipals.has(caller))
      return "the caller's lifecycle is retired; a retired incarnation's credential holds no control authority (F5)";
    return undefined;
  }

  private async withProvisioner<T>(fn: (prov: CotalEndpoint) => Promise<T>): Promise<T> {
    if (!this.auth) throw new Error("withProvisioner: no space auth (an open mesh has no scoped creds)");
    const identity = newIdentity();
    const creds = await mintCreds(this.auth, identity, "provisioner");
    const prov = new CotalEndpoint({
      space: this.space,
      servers: this.servers,
      channels: [],
      creds,
      card: { id: identity.id, name: "provisioner", role: "provisioner", kind: "endpoint" },
      registerPresence: false,
      watchPresence: false,
      watchChannels: false,
      consume: false,
    });
    await prov.start();
    try {
      return await fn(prov);
    } finally {
      await prov.stop();
    }
  }

  /** Purge the space's retained message backlog (chat, optionally DMs). Privileged — the manager mints a
   *  short-lived "purger" cred (same destructive grant as `cotal history clear`, isolated off the
   *  supervisor); regular agents are denied STREAM.PURGE under auth. Cleanup only: leaves live agents and
   *  the TASK queue alone. */
  private async opPurge(args: Record<string, unknown>, _caller: string): Promise<ControlReply> {
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
      return { ok: false, error: (e as Error).message };
    }
  }

  /** Persist a peer-defined persona as config. After this, `start name` auto-discovers
   *  .cotal/agents/<name>.md and the connector applies its persona/model at spawn.
   *
   *  CONTENT vs POLICY (P6): the write path accepts ONLY content from args — {name, model,
   *  persona}. role/publish/capabilities/owner are POLICY and have no slot here, so a peer can
   *  never grant itself a capability or claim ownership by redefining. A fresh name is created with
   *  owner = caller (the creator). Redefining an EXISTING file overwrites ONLY model + persona and
   *  preserves everything else — and is allowed on the privileged tier only if `file.owner == caller`,
   *  else admin is required. Fail-closed: an ownerless file (legacy / operator-written) is admin-only. */
  private opDefinePersona(args: Record<string, unknown>, caller: string, admin: boolean): ControlReply {
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, error: "name required" };
    const nameErr = this.nameError(name);
    if (nameErr) return { ok: false, error: nameErr };
    const persona = String(args.persona ?? "").trim();
    if (!persona) return { ok: false, error: "persona required" };
    const model = args.model ? String(args.model) : undefined;
    const path = agentFilePath(this.workspaceRoot, name);
    let def: AgentDef;
    if (existsSync(path)) {
      // Redefine: load, authorize by ownership, then overwrite ONLY content; preserve all policy.
      try {
        def = loadAgentFile(path);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      if (!admin && def.owner !== caller) {
        const owner = def.owner ? `owned by ${def.owner}` : "operator-owned (legacy file - no agent owner)";
        return { ok: false, error: `not authorized to redefine ${name}: ${owner}; only its owner or an operator can` };
      }
      // PATCH content: overwrite model only when provided, so a persona-only redefine can't wipe an existing model.
      if (model !== undefined) def.model = model;
      def.persona = persona;
    } else {
      // Fresh name: create with content + owner = caller. The privileged tier suffices (creating a
      // brand-new persona isn't admin-only); the creator becomes its owner.
      def = { name, model, persona, owner: caller };
    }
    try {
      saveAgentFile(path, def);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    return { ok: true, data: { name, path } };
  }

  /** The post-authorization attach effect (P2 item 6): mint the holder-bound §13.6 offer, redeem it
   *  through the ONE session plane (one-use CAS + presenter-equality), and stand up the PTY bridge —
   *  atomically. The reply is the SIGNED grant (no ws:// URL, non-bearer, never logged); the caller
   *  redeems it over the mesh with a per-session rails-only cred it mints itself. Only streamable
   *  backends (pty/host) attach; an external runtime's attach() throws with per-runtime guidance. */
  private async attachAuthorized(a: ManagedAgent, caller: { owner: string; actor: string; uid: string }): Promise<ControlReply> {
    if (!this.sessionPlane) return { ok: false, error: "the manager session plane is not available (the manager is not fully started)" };
    // A name is a reusable slot and the authorization above can await (user mode reads the ledger).
    // The ep target is incarnation-pinned, so `a` cannot BE a successor — but the slot it names can
    // have been stopped and refilled while we waited, and everything below must act on the
    // incarnation this caller was actually authorized for, never on whoever holds the name now.
    if (this.agents.get(a.name) !== a)
      return { ok: false, error: `agent "${a.name}" was replaced during authorization - retry` };
    // Never establish a session over a dead agent — a doomed session (the caller would get an
    // immediate process-exit at best, a confusing empty terminal at worst). Refuse honestly.
    if (a.handle.status() !== "running") return { ok: false, error: `agent "${a.name}" is not running (${a.handle.status()}); nothing to attach` };
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
      return { ok: false, error: (e as Error).message };
    }
    // establishAttach releases the claim it was handed on every exit; nothing to unwind here.
    const { grant } = await this.sessionPlane.establishAttach(caller, { name: a.name, lifecycleUid: a.lifecycleUid }, session, slot);
    return { ok: true, data: { grant } };
  }

  /** P2 item 6: the console's mesh §13.6 session establisher (backing `POST /session/<name>` on the
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

  /** Managed agents cross-referenced with live presence (the manager sees the roster). */
  /** `ownerFilter`: restrict to agents whose spawn-time stored `userOwner` equals it (the ps/status
   *  owner-domain bound); undefined = unbounded. {@link NO_OWNER_MATCHES} matches nothing. */
  private list(ownerFilter?: string) {
    const roster = new Map(this.ep.getRoster().map((p) => [p.card.name, p]));
    return [...this.agents.values()].filter((a) => ownerFilter === undefined || a.userOwner === ownerFilter).map((a) => {
      // USER MODE: a detached agent's bearer-refresh death is silent everywhere except here — its
      // bearer command writes each attempt's outcome to the health file, and `ps` renders it
      // FAIL-CLOSED: a failed record is the failure + repair sentence; a missing/malformed or
      // stale record on a live agent is auth-unknown/auth-stale, NEVER silently healthy.
      const health = a.userOwner
        ? agentAuthState(a.secretPaths?.health ?? agentLifecycleSecretFilePaths(this.workspaceRoot, a.name, a.lifecycleUid).health)
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
        mesh: roster.get(a.name)?.status ?? "absent",
        // The incarnation coordinate (SPEC 13.1) — with `id`, exactly what a v0.4 caller needs to
        // build a targeted (`despawn`/`attach`) request against THIS incarnation.
        lifecycleUid: a.lifecycleUid,
        ...(health && health.state !== "ok" ? { authHealth: health.state, authReason: health.reason } : {}),
      };
    });
  }
}
