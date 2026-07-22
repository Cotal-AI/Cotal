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
  loadAgentFile,
  loadCotalConfig,
  mintCreds,
  mintLifecycleUid,
  mkSecretDir,
  newIdentity,
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
  CONTROL_PRIVILEGED,
  CONTROL_SELF_SERVICE,
  CONTROL_ADMIN,
  CONTROL_AUTH_ADMIN,
  controlServiceSubject,
} from "@cotal-ai/core";
import { agentActorTokenKey, agentAuthState, agentCredsDir, agentCredsKey, agentSecretFilePaths, agentSentinelCredsKey, authDir, connectorInstallHint, DEFAULT_CONNECTOR, defaultAgentType, DELIVERY_CREDS_KEY, findCotalRoot, hasUserAuthState, loadMeshes, loadSpaceAuth, manifestExtensionNames, materializeFromManifest, materializeSecretToFile, MEMBERSHIP_RW_CREDS_KEY, mergeLaunchOptions, remintDaemonCreds, resolveOnPath, userAuthStateDir, workspaceSecretStore, writeRenewalRecord, type RenewalRecord } from "@cotal-ai/workspace";
import type { AgentDef, AttachSession, Connector, ConnectorModelCatalog, ControlReply, ControlRequest, ControlTier, LaunchSpec, ManagerLeaseInfo, MeshLaunchAgent, Presence, SecretStore, SpaceAuth } from "@cotal-ai/core";
import {
  createRuntime,
  type AgentHandle,
  type Runtime,
  type RuntimeMode,
} from "./runtime/index.js";
import { AttachEndpoint } from "./attach-endpoint.js";
import { launchSpecForRun, materializePersona, launchAgentToStartOpts } from "./launch.js";
import { authorizeLaunch, authorizeNamedControl } from "./authorize.js";
import { controlShutdown } from "./control-shutdown.js";
import { parseResumeCommitArgs, parseResumeControlArgs, parseResumeFinalizeArgs } from "./resume.js";

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
  /** Port for the console + attach HTTP/WS endpoint (loopback). 0 → ephemeral. */
  consolePort?: number;
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
    transcript: boolean;
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
  /** Mirror the session's transcript to `tr-<name>`. Defaults to off; `true` (the
   *  `--transcript` flag) opts in. */
  transcript?: boolean;
  /** Initial prompt auto-submitted at session start (the `--prompt` flag), forwarded verbatim to
   *  the connector. Imperative-only: never set from `resolved` (a manifest carries no prompt). */
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
  transcript: boolean;
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
}

/**
 * The agent supervisor: a long-lived mesh node that owns agent process lifecycle.
 * It serves control requests on the "manager" service and spawns/kills agents
 * through a pluggable {@link Runtime} (pty by default). It does NOT proxy agent
 * mesh traffic — terminal I/O streams over its own attach endpoint instead.
 */
export class Manager {
  private readonly space: string;
  private readonly servers: string | undefined;
  private readonly name: string;
  private readonly workspaceRoot: string;
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
  private retiring = new Map<string, { opId: string; lifecycleUid: string; owner: string; actor: string; agentId: string; userOwner?: string; startedAt: number; lastError?: string; standingAuthorityLive?: boolean }>();
  /** SINGLE-FLIGHT guard for {@link requestRetirement} (audit #1): one in-flight rail round-trip per
   *  (name, lifecycleUid). The detached `deprovision` call and every same-name-spawn nudge for THAT
   *  lifecycle JOIN the same promise instead of stacking independent requests that dual-enter the
   *  barrier; a fresh trigger after it settles re-drives. Keyed by (name, uid) — NOT name alone — so a
   *  same-name SUCCESSOR (which can spawn after the hold clears but before this flight's `nc.close`
   *  yield settles) never joins the predecessor's rail request and skips its own retirement. */
  private retiringFlight = new Map<string, Promise<void>>();
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
    this.attach = new AttachEndpoint(
      (name) => this.maintenanceState === "active" && !this.resumeRequired ? this.agents.get(name)?.handle : undefined,
      () => this.list(),
      // Initial /feed replay for a connecting console: the current peer roster.
      () => [{ event: "roster", data: this.ep?.getRoster() ?? [] }],
      opts.consolePort ?? 0,
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
    // itself creds from the same signing key it uses for the agents it spawns.
    // Space-KEYED: this manager is bound to exactly one space, so it must load THAT space's account.
    // A root-wide load would let a manager for space B mint B's agents into space A's account the
    // moment a root holds more than one.
    this.auth = loadSpaceAuth(authDir(this.workspaceRoot), this.space);
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
      // own launch chain (the operator command IS its launcher), so it mints its incarnation's
      // uid here - one per supervisor process, never reused across restarts.
      lifecycleUid: mintLifecycleUid(),
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
    // Singleton guard: exactly one manager per space. Acquire the lease (atomic CAS create); if a live
    // manager already holds it, REFUSE to start (fail loud) rather than become a second supervisor that
    // queue-splits control with the incumbent. A crashed holder's lease auto-expires (bucket TTL).
    this.leaseInfo = { holder: this.ep.ref().id, runtime: this.runtime.kind, root: resolve(this.workspaceRoot), pid: process.pid };
    try {
      this.leaseRevision = await this.ep.acquireManagerLease(this.leaseInfo);
    } catch (e) {
      // A live holder ⇒ refuse (the singleton point). Anything else (e.g. a KV/JS error) is a real
      // failure to surface, not a silent "held" — keep the cause so it isn't misread as a conflict.
      const held = await this.ep.readManagerLease().catch(() => undefined);
      await this.ep.stop();
      await this.attach.stop();
      throw new Error(
        held
          ? `a manager already serves space "${this.space}" (id ${held.holder}, ${held.runtime}, pid ${held.pid}, root ${held.root}) - stop it first; one manager per space`
          : `could not acquire the manager lease for space "${this.space}": ${(e as Error).message}`,
      );
    }
    this.leaseTimer = setInterval(() => { void this.renewLease(); }, MANAGER_LEASE_TTL_MS / 2);
    this.leaseTimer.unref?.();
    // Serve all three control tiers (P2a): self-service (no-name self stop/despawn), privileged
    // (start / own-child stop-despawn-attach / own definePersona), and admin (purge / cross-agent
    // stop-despawn-attach / cross-agent definePersona). The cred layer grants self-service to every
    // agent, privileged only to spawn-capable ones, and admin only to the manager's own profile
    // (no agent ever reaches it); the handler then routes by op↔tier (fail-closed on mismatch) so a
    // misrouted op is rejected before anything acts.
    // `boundReply` (closure (i)): each tier replies ONLY into the requester's own subtree
    // (`${reqSubject}.reply.…`), never the per-id `_INBOX`. This both keeps the confused-deputy guard
    // (a caller can't redirect a reply onto a peer's lane) AND lets the manager cred drop its position-1
    // inbox publish wildcard — callers subscribe `ctl.<tier>.<id>.reply.>`, granted per tier they may call.
    this.ep.serveControl(CONTROL_PRIVILEGED, (req) => this.handle(req, CONTROL_PRIVILEGED), { boundReply: true });
    this.ep.serveControl(CONTROL_SELF_SERVICE, (req) => this.handle(req, CONTROL_SELF_SERVICE), { boundReply: true });
    this.ep.serveControl(CONTROL_ADMIN, (req) => this.handle(req, CONTROL_ADMIN), { boundReply: true });
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
      const results = await remintDaemonCreds(this.workspaceRoot, this.secrets);
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
    } catch (e) {
      console.error(`! credential renewal pass failed: ${(e as Error).message}`);
    } finally {
      release();
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
  private trackDeprovision(a: { id: string; name: string; lifecycleUid: string; userOwner?: string }, context = ""): void {
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
    const files = agentSecretFilePaths(this.workspaceRoot, a.name);
    const identity: ManagerResumeIdentity = a.userOwner
      ? {
          mode: "user",
          owner: principal.owner,
          actor: principal.actor,
          lifecycleUid: a.lifecycleUid,
          actorToken: { kind: "file", path: files.actorToken, sha256: this.fileDigestOrEmpty(files.actorToken) },
          sentinelCredential: { kind: "file", path: files.sentinelCreds, sha256: this.fileDigestOrEmpty(files.sentinelCreds) },
          health: { kind: "file", path: files.health },
        }
      : this.auth
        ? { mode: "static", id: principal.actor, lifecycleUid: a.lifecycleUid, credential: { kind: "file", path: files.creds, sha256: this.fileDigestOrEmpty(files.creds) } }
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
        transcript: a.launch.transcript,
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
    await this.ep.releaseManagerLease(this.leaseRevision);
    await this.ep.stop();
    await this.attach.stop();
  }

  /** Refresh the singleton lease before the bucket TTL expires it. On loss (missed the TTL, or another
   *  manager took over after a gap) FAIL CLOSED: stop serving control at once so we can't double-process
   *  with the new holder, and exit. We deliberately do NOT re-acquire (a replacement may already be live
   *  while we'd still be serving) and do NOT release the key — it now belongs to that replacement. */
  private async renewLease(): Promise<void> {
    try {
      if (!this.leaseInfo || this.leaseRevision === undefined) return;
      this.leaseRevision = await this.ep.renewManagerLease(this.leaseInfo, this.leaseRevision);
    } catch (e) {
      console.error(`! manager lost its singleton lease for space "${this.space}" (${(e as Error).message}) - shutting down to avoid two managers serving it`);
      if (this.leaseTimer) clearInterval(this.leaseTimer);
      // Tear down our managed agents' footprints too (#159 B2) — this exit path leaks them otherwise. Do
      // NOT release the lease key (it may belong to the replacement holder). Best-effort, like ep/attach.
      try {
        if (this.maintenanceState === "active" && !this.resumeRequired) await this.teardownManagedAgents();
        else await this.stopRetainedAgentsOnExit();
      } catch { /* best effort */ }
      try { await this.ep.stop(); } catch { /* best effort */ }
      try { await this.attach.stop(); } catch { /* best effort */ }
      process.exit(1);
    }
  }

  private async handle(req: ControlRequest, tier: ControlTier): Promise<ControlReply> {
    if (req.op === "finalizeResume") {
      if (tier !== CONTROL_ADMIN)
        return { ok: false, error: "finalizeResume is admin-only; not allowed on this control subject" };
      let args: { attemptId: string; durableCommitToken: string };
      try {
        args = parseResumeFinalizeArgs(req.args);
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
      this.resumeFinalized = true;
      this.resumeRequired = false;
      return { ok: true, data: { attemptId: args.attemptId, state: "active" } };
    }
    if (req.op === "commitResume") {
      if (tier !== CONTROL_ADMIN)
        return { ok: false, error: "commitResume is admin-only; not allowed on this control subject" };
      let attemptId: string;
      try {
        attemptId = parseResumeCommitArgs(req.args).attemptId;
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
    if (req.op === "resumePreserved") {
      if (tier !== CONTROL_ADMIN)
        return { ok: false, error: "resumePreserved is admin-only; not allowed on this control subject" };
      try {
        const args = parseResumeControlArgs(req.args);
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
    if (req.op === "preparePreservation" || req.op === "commitPreservation" || req.op === "abortPreservation") {
      if (tier !== CONTROL_ADMIN)
        return { ok: false, error: `${req.op} is admin-only; not allowed on this control subject` };
      if (this.resumeRequired) return { ok: false, error: this.maintenanceError() };
      const attemptId = String(req.args?.attemptId ?? "").trim();
      if (!attemptId) return { ok: false, error: `${req.op} requires attemptId` };
      try {
        if (req.op === "abortPreservation") {
          this.abortPreservation(attemptId);
          return { ok: true, data: { attemptId, state: "active" } };
        }
        const result = req.op === "preparePreservation"
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
    const release = this.beginLifecycle();
    if (!release) return { ok: false, error: this.maintenanceError() };
    try {
      return await this.handleActive(req, tier);
    } finally {
      release();
    }
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

  private async handleActive(req: ControlRequest, tier: ControlTier): Promise<ControlReply> {
    const args = req.args ?? {};
    // `req.from.id` is non-forgeable in auth mode: serveControl rejects any request whose payload
    // `from.id` doesn't match the subject sender (endpoint.ts). In open mode there are no creds, so
    // from.id is self-asserted — the spawner ledger + this routing are auth-mode guarantees,
    // advisory in open mode (consistent with "open = single-trusted-host"). Thread it to every op
    // so authz (P2c) and the spawner ledger (P4b) can act on it.
    const caller = req.from.id;
    const name = String(args.name ?? "").trim();
    // Op↔tier binding — the real enforcement per the split. The cred gates WHO can reach each
    // subject; this gates WHAT each subject will honor, fail-closed. A privileged op arriving on
    // the self-service subject (publishable by all) must be rejected or the split does nothing.
    if (tier === CONTROL_SELF_SERVICE) {
      // Self-service honors self-ops only: a no-name stop (self-despawn). Durable join/leave/list moved
      // OFF the manager onto the server-side delivery daemon's `ctl.delivery` service (the manager is
      // lifecycle-only). A named stop (belongs on privileged/admin) or anything else is a misroute.
      if (req.op !== "stop") return { ok: false, error: `op "${req.op}" not allowed on self-service control subject` };
      if (name) return { ok: false, error: "named stop not allowed on self-service subject; send it on the privileged subject" };
      return this.opStopSelf(caller, args);
    }
    const admin = tier === CONTROL_ADMIN;
    // Privileged + admin tiers. A no-name stop is a self-op and belongs on the self-service subject.
    switch (req.op) {
      case "start":
        // Spawn is a privileged-tier op; reaching it via admin is fine (admin ⊇ privileged powers).
        return this.opStart(args, caller);
      case "launch":
        // SECURITY: on a STATIC mesh, manifest launch is operator-only (admin tier). It is
        // higher-power than `start` — it boots an operator-authored, coordinated policy set from a
        // run spec and underpins the ownership ledger — so a merely spawn-capable agent (which CAN
        // publish to the privileged subject) must not reach it. Gate at the handler like `purge`;
        // the subject alone isn't a boundary because `spawn` grants privileged-subject publish and
        // dispatch is by op here. On a USER mesh, a spawn-scoped operator deploys THEIR OWN team on
        // the privileged tier: opLaunch enforces owner-equality (the spec's apply-time stamped
        // owner === the subject-pinned caller's owner) BEFORE any side effect.
        if (!admin && !this.userMode) return { ok: false, error: "launch is admin-only; not allowed on the privileged subject" };
        return this.opLaunch(args, caller, admin);
      case "stop": {
        if (!name) return { ok: false, error: "self-stop not allowed on privileged subject; send it on the self-service subject" };
        return this.opStop(args, caller, admin);
      }
      case "definePersona":
        return this.opDefinePersona(args, caller, admin);
      case "purge":
        // SECURITY: purge clears space history incl. DMs — admin-only. On the privileged tier any
        // spawn-capable agent could wipe the space, so it must not be honored there.
        if (!admin) return { ok: false, error: "purge is admin-only; not allowed on the privileged subject" };
        return this.opPurge(args, caller);
      case "attach":
        return this.opAttach(args, caller, admin);
      case "ps":
        // USER mesh, privileged tier: `ps` lists only the CALLER's own owner-domain (the admin tier
        // OR a fresh ledger `admin` scope sees all) — cross-owner agent metadata (principals,
        // personas, auth health) is operator-grade. Fail-closed: an unparseable caller sees nothing.
        // Static meshes are unchanged.
        return { ok: true, data: this.list(await this.psOwnerFilter(caller, admin)) };
      case "models":
        return this.opModels(args);
      case "status": {
        // Same owner-domain bound as `ps`: a cross-owner target reads as absent, never as metadata.
        const a = this.list(await this.psOwnerFilter(caller, admin)).find((x) => x.name === name);
        return a ? { ok: true, data: a } : { ok: false, error: `no agent "${name}"` };
      }
      default:
        return { ok: false, error: `unknown op: ${req.op}` };
    }
  }

  /** Collapsed despawn/attach authorization (P4b). The caller already reached the privileged or
   *  admin tier (cred-gated). On the admin tier any named target is allowed (operator). On the
   *  privileged tier a named target is allowed if it's the caller's OWN child (`spawner ==
   *  caller`) — and, on a user mesh, if it runs under the CALLER'S OWNER (owner-domain) or the
   *  caller's ledger row holds `admin`, read fresh. The policy is the pure
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
  ): Promise<{ owner: string; launch: { owner: string; actor: string; sentinelCredsPath: string; bearerCmd: string[] } } | { error: string }> {
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
    const files = agentSecretFilePaths(this.workspaceRoot, name);
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
      await secrets.put(agentActorTokenKey(name), grant.actorToken);
      await secrets.put(agentSentinelCredsKey(name), grant.sentinelCreds);
      await materializeSecretToFile(secrets, agentActorTokenKey(name), tokenPath);
      await materializeSecretToFile(secrets, agentSentinelCredsKey(name), sentinelPath);
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
      return { owner, launch: { owner, actor: name, sentinelCredsPath: sentinelPath, bearerCmd } };
    } catch (e) {
      // Roll back everything this attempt materialized — a refused spawn must leave no standing
      // secret, no ledger row, no durable footprint — and AWAIT the broker teardown: the caller
      // may respawn the moment it reads the refusal, and a detached teardown would race (and
      // delete) that fresh spawn's just-provisioned durables.
      await provider.revokeAgent({ dir, owner, actor: name }).catch(() => {});
      await secrets.delete(agentActorTokenKey(name)).catch(() => {});
      await secrets.delete(agentSentinelCredsKey(name)).catch(() => {});
      rmSync(tokenPath, { force: true });
      rmSync(sentinelPath, { force: true });
      rmSync(healthPath, { force: true });
      await this.deprovision({ id: principalKey(owner, name).key, name, lifecycleUid: opts.lifecycleUid, userOwner: owner }).catch((err) =>
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
    this.agents.delete(a.name);
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
      if (p) this.retiring.set(a.name, { opId: retireOpId(a.lifecycleUid), lifecycleUid: a.lifecycleUid, owner: p.owner, actor: p.actor, agentId: a.id, userOwner: a.userOwner, startedAt: Date.now() });
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
  private async deprovision(a: { id: string; name: string; lifecycleUid: string; userOwner?: string }): Promise<void> {
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
  private async driveDeprovision(a: { id: string; name: string; lifecycleUid: string; userOwner?: string }): Promise<void> {
    if (!this.auth) return; // guaranteed by deprovision; re-checked for the deprovisionBroker narrowing
    // Drop the local creds file FIRST + unconditionally — it is a usable identity on disk, useless for a
    // departed agent, so it must not survive even if the broker teardown below fails or times out. The
    // teardown mints its OWN deprovisioner cred (not this file), so removing it early is independent.
    // Migrated kinds: the store delete is the authoritative removal; the rmSync clears the FS
    // materialization (a byte-identical no-op under the local composition, real once the manager's
    // `secretStore` is a non-FS store).
    const secrets = this.secrets;
    const files = agentSecretFilePaths(this.workspaceRoot, a.name);
    await secrets.delete(agentCredsKey(a.name));
    rmSync(files.creds, { force: true });
    if (a.userOwner) {
      // USER MODE: this teardown IS revocation, not just footprint reduction — the ledger row is
      // the agent's standing mint authority, so delete it (next exchange refused, next connect
      // denied) and shred the secret/sentinel/health files. A copied actor token dies here; a
      // still-LIVE connection ends at its bearer-bound JWT expiry (≤ the agent TTL).
      await secrets.delete(agentActorTokenKey(a.name));
      await secrets.delete(agentSentinelCredsKey(a.name));
      for (const f of [files.actorToken, files.sentinelCreds, files.health]) rmSync(f, { force: true });
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
          JSON.stringify({ op: "retireLifecycle", args: { owner: target.owner, actor: target.actor, lifecycleUid: a.lifecycleUid, opId: retireOpId(a.lifecycleUid) } }),
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

  /** First free name in the series `base`, `base-2`, `base-3`, … — checked against both live and
   *  in-flight (reserved) slots. Lets a colliding spawn auto-number instead of being rejected, so
   *  callers never have to invent a unique name. */
  private uniqueName(base: string): string {
    return firstFreeName(base, (n) => this.agents.has(n) || this.reserved.has(n) || this.retiring.has(n));
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
  private opStart(args: Record<string, unknown>, caller: string): Promise<ControlReply> {
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
        transcript: typeof args.transcript === "boolean" ? args.transcript : undefined,
        cwd: args.cwd ? String(args.cwd) : undefined,
        prompt: args.prompt ? String(args.prompt) : undefined,
        subscribe,
        allowSubscribe,
        allowPublish,
        shareTools: args.shareTools !== undefined ? String(args.shareTools) : undefined,
      },
      caller,
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
   *  manager. The request carries a `{ runId, name }`, NEVER a path: the manager derives + validates
   *  `.cotal/run/<runId>.json` itself ({@link launchSpecForRun} — token-safe id, no-follow,
   *  `loadLaunchSpec`'s untrusted-input + `validateLaunchPolicy` contract), materializes the named
   *  agent's transient persona, and spawns via the same `startAgent({ resolved })` path as
   *  `supervise --launch`. The reply is enriched for the ownership ledger: the SPAWNED
   *  (collision-numbered) name + nkey id creds are filed under, plus the manifest `requested` name,
   *  `runId`, and resolved `hash`. USER mesh: a privileged-tier launch is owner-equality-authorized
   *  (spec owner === caller owner) before any side effect; the admin tier keeps operator behavior. */
  private async opLaunch(args: Record<string, unknown>, caller: string, admin: boolean): Promise<ControlReply> {
    const runId = String(args.runId ?? "").trim();
    const name = String(args.name ?? "").trim();
    if (!runId || !name) return { ok: false, error: "launch requires runId + name" };
    let spec;
    try {
      spec = launchSpecForRun(this.workspaceRoot, runId);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
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
    const reply = await this.startAgent(launchAgentToStartOpts(la, configPath, spec.owner, runId), caller);
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
  async startAgent(opts: StartAgentOpts, spawner?: string): Promise<ControlReply> {
    const release = this.beginLifecycle();
    if (!release) return { ok: false, error: this.maintenanceError() };
    try {
      return await this.startAgentActive(opts, spawner);
    } finally {
      release();
    }
  }

  private async startAgentActive(opts: StartAgentOpts, spawner?: string): Promise<ControlReply> {
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
      void this.deprovision({ id: held.agentId, name: identityName, lifecycleUid: held.lifecycleUid, userOwner: held.userOwner }).catch(() => {});
      return {
        ok: false,
        error: `the name "${identityName}" is reserved pending retirement: its previous agent's despawn started that lifecycle's teardown (footprint + standing-authority revoke + auth-side retirement), and the name frees only when all of it completes${held.lastError !== undefined ? ` (last attempt: ${held.lastError})` : ""}. NEXT: wait a moment and retry this spawn (retrying re-drives the whole teardown), or pick another name.`,
      };
    }
    if (variant && !connector.supportsModelVariant)
      return { ok: false, error: `${agent} connector does not support model variants (variant)` };

    const name = this.uniqueName(identityName);
    this.reserved.add(name);
    // Transcript mirroring (opt-in: `--transcript` / COTAL_TRANSCRIPT_DEFAULT=1) → grant the agent pub
    // on its OWN transcript channel; auth-mode publish is default-deny, so without the grant the mirror's
    // publish is rejected. Ask the resolved connector for the channel — the SAME one it publishes to, so
    // the grant and the publish can't drift, and the literal stays out of core. Uses the spawned `name`
    // (post-uniqueName) so the grant matches the actual identity. Mirroring is OPTIONAL per connector
    // (like prompt): if it's requested for a connector that doesn't mirror, fail loud — never silently
    // skip the grant (that would surface later as a confusing auth-mode publish rejection).
    const transcript = opts.transcript ?? process.env.COTAL_TRANSCRIPT_DEFAULT === "1";
    if (transcript) {
      if (!connector.transcriptChannel) {
        this.reserved.delete(name); // release the just-reserved name on this fail-fast path
        return { ok: false, error: `connector "${connector.name}" does not support transcript mirroring, but transcript was requested` };
      }
      allowPublish = [...(allowPublish ?? []), connector.transcriptChannel(name)];
    }
    // Set once the agent's creds + durables are minted; cleared the moment a live slot takes ownership
    // (`agents.set`, after which freeSlot deprovisions on exit). If it survives to `finally`, the spawn
    // threw AFTER minting (buildLaunch / runtime.spawn) — tear the orphan down so no footprint leaks (#159 B).
    // Set once the agent's footprint (durables + creds, or the user-mode grant + secret files)
    // exists; cleared when a live slot takes ownership. If it survives to `finally`, the spawn threw
    // AFTER provisioning (buildLaunch / runtime.spawn) — the orphan-rollback tears it down. Carries
    // `userOwner` for a user-mode spawn so that rollback runs the revoke+shred branch, not just the
    // static durable teardown (the freelance found this window leaking the managed grant + files).
    let provisioned: { id: string; name: string; lifecycleUid: string; userOwner?: string } | undefined;
    try {
      // A stable nkey identity assigned at spawn: the public key is the agent's card.id (threaded via
      // COTAL_ID); the seed is retained to mint matching creds later.
      const identity = newIdentity();
      // The incarnation's lifecycle UID (SPEC 13.1), minted ONCE per spawn: every lifecycle-keyed
      // broker resource (dm_/dlv_/chathist_ durables, ACL row, memberships) and the teardown
      // credential carry it, so a same-name successor's footprint is name-disjoint by construction.
      const lifecycleUid = mintLifecycleUid();
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
        provisioned = { id: principalKey(prep.owner, name).key, name, lifecycleUid, userOwner: prep.owner };
      } else if (this.auth) {
        // Pre-create the agent's bind-only chat (+ DM + role TASK) durables and mint its scoped creds
        // — the shared onboarding step (provisionAgent). It runs on a short-lived PROVISIONER connection
        // (NOT the supervisor's long-lived endpoint), so the DM/DLV consumer-create surface exists only
        // for the provisioning window, never as a standing grant on the always-on daemon (residual 2).
        const creds = await this.withProvisioner((prov) =>
          provisionAgent(prov, this.auth!, identity, {
            subscribe,
            allowSubscribe,
            allowPublish,
            role,
            capabilities,
            lifecycleUid,
          }),
        );
        // Store first (the source of truth), then materialize: `buildLaunch` hands the CHILD this
        // file path, so the cred must exist as a file regardless of the store behind the seam. The
        // manager's ONE store (injected for hosted, workstation FS locally).
        const secrets = this.secrets;
        credsPath = agentSecretFilePaths(this.workspaceRoot, name).creds;
        await secrets.put(agentCredsKey(name), creds);
        await materializeSecretToFile(secrets, agentCredsKey(name), credsPath);
        provisioned = { id: identity.id, name, lifecycleUid }; // footprint now exists — the finally rolls it back if the spawn throws
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
        // Initial prompt (imperative-only; the resolved guard above keeps manifests prompt-free).
        prompt: opts.prompt,
        // The SAME access set the creds were minted from (above) — forwarded so the session's
        // runtime read/post set matches its credentials. Without this a manifest-spawned agent
        // (materialized persona has no access frontmatter) falls back to `["general"]`, which its
        // scoped creds deny, and it joins nothing.
        subscribe,
        allowSubscribe,
        allowPublish,
        capabilities,
        transcript,
        mcpServers,
        // So a connector that keeps per-agent local state can root it at the workspace, not the
        // (possibly per-agent) launch cwd below. The cwd itself rides runtime.spawn, not the launch.
        workspaceRoot: this.workspaceRoot,
      });
      const handle = this.runtime.spawn(name, spec, cwd);
      const managed: ManagedAgent = {
        name,
        role,
        agent,
        id: userLaunch ? principalKey(userLaunch.owner, name).key : identity.id,
        lifecycleUid,
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
          transcript,
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
      this.agents.set(name, managed);
      // The live slot now owns teardown — freeSlot deprovisions this identity on exit — so the
      // orphan-rollback in `finally` no longer applies to it.
      provisioned = undefined;
      // #159 B1: reply on a REAL outcome, not a timer. Wait for the agent to actually join the mesh
      // (presence) → started, the child to exit → failed (with its last output; already reaped), or
      // neither in time → uncertain. `✓ started` therefore means "it joined", never just "a process
      // launched".
      const readiness = await this.awaitReadiness(managed);
      if (!readiness.ok && !readiness.uncertain) return { ok: false, error: readiness.detail }; // failed → already reaped
      // Started OR uncertain: the agent stays managed, so wire the ongoing exit reaper (it reaps a later
      // death — including one that follows an `uncertain` verdict, which deliberately does NOT deprovision).
      this.watchExit(managed);
      if (!readiness.ok) return { ok: false, error: readiness.detail }; // uncertain — non-success, but kept
      // Reply with the id the slot actually carries (user-mode: the owner.actor principal —
      // presence, ps, and the manifest ownership ledger all key on it; the throwaway static nkey
      // would never match and down -f would treat the agent as foreign).
      return { ok: true, data: { name, role, agent, id: managed.id, mode: handle.kind } };
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
      const expected = resolve(agentSecretFilePaths(this.workspaceRoot, entry.name).creds);
      if (resolve(entry.identity.credential.path) !== expected)
        throw new Error(`retained credential reference for ${entry.name} is not the manager-owned path ${expected}`);
      let credentialText: string;
      try {
        // The lstat guards the FS MATERIALIZATION the child will read at launch; the identity check
        // runs on the store's value — the source of truth (byte-identical here, the local FS
        // composition resolves the key to this same path).
        const st = lstatSync(expected);
        if (!st.isFile() || st.isSymbolicLink()) throw new Error("not a regular non-symlink file");
        const stored = await this.secrets.get(agentCredsKey(entry.name));
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
      // Mirror the static branch's expected-path equality: the store reads below are keyed by
      // NAME, so a retained record aimed at a foreign path would otherwise pass its digest checks
      // there while a different secret gets validated here. Canonical paths only.
      const files = agentSecretFilePaths(this.workspaceRoot, entry.name);
      if (resolve(entry.identity.actorToken.path) !== resolve(files.actorToken) ||
          resolve(entry.identity.sentinelCredential.path) !== resolve(files.sentinelCreds))
        throw new Error(`retained identity references are not the manager-owned paths under ${agentCredsDir(this.workspaceRoot)}`);
      const secrets = this.secrets;
      const actorToken = await secrets.get(agentActorTokenKey(entry.name));
      const sentinelCreds = await secrets.get(agentSentinelCredsKey(entry.name));
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
        connector = registry.resolve<Connector>("connector", entry.launch.connector);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      const missing = (connector.requires ?? []).filter((bin) => !resolveOnPath(bin));
      if (missing.length)
        return { ok: false, error: `${connector.name} harness needs ${missing.join(", ")} on PATH - not found` };
      if (entry.launch.variant && !connector.supportsModelVariant)
        return { ok: false, error: `${connector.name} connector does not support model variants (variant)` };

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
          transcript: entry.launch.transcript,
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
      const handle = this.runtime.spawn(entry.name, prepared.spec, entry.launch.cwd);
      const managed: ManagedAgent = {
        name: entry.name,
        role: entry.role,
        agent: entry.launch.connector,
        id: entry.identity.mode === "user" ? principalKey(entry.identity.owner, entry.identity.actor).key : entry.identity.id,
        // Recover the ORIGINAL incarnation uid the durables are keyed by (never a fresh mint on resume).
        lifecycleUid: entry.identity.lifecycleUid,
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
          transcript: entry.launch.transcript,
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
  private async awaitReadiness(a: ManagedAgent): Promise<{ ok: true } | { ok: false; uncertain?: boolean; detail: string }> {
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
      const finish = (r: { ok: true } | { ok: false; uncertain?: boolean; detail: string }): void => {
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
        void (async () => {
          const tail = this.tail(await s.backlog());
          this.onAgentExit(a);
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
    const denied = await this.authorizeNamed(a, caller, admin);
    if (denied) return { ok: false, error: denied };
    const graceful = args.graceful !== false;
    this.stopHandle(a, graceful);
    this.trackStoppedHandle(a, !admin);
    return { ok: true, data: { name, stopped: true, graceful } };
  }

  /** Open a short-lived PROVISIONER connection, run the onboarding ops on it, and drain it (closure (ii),
   *  residual 2). The DM/DLV consumer-create surface — the irreducible onboarding power — lives only for
   *  this window, never as a standing grant on the long-lived supervisor. A provision-only endpoint
   *  (no presence/consume/channel-watch) connected with memory-only `provisioner` creds; it sets its own
   *  `inboxPrefix` so JS-API replies land on the `_INBOX_<id>.>` the provisioner cred subscribes. */
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

  private async opAttach(args: Record<string, unknown>, caller: string, admin: boolean): Promise<ControlReply> {
    const name = String(args.name ?? "").trim();
    const a = this.agents.get(name);
    if (!a) return { ok: false, error: `no agent "${name}"` };
    // attach grants terminal read+write — same scoping as despawn: own child (and, on a user
    // mesh, the caller's owner-domain) on the privileged tier, any agent on admin.
    const denied = await this.authorizeNamed(a, caller, admin);
    if (denied) return { ok: false, error: denied };
    // Only pty streams over the WS attach endpoint. External runtimes are watched natively,
    // and each handle's attach() throws with the right per-runtime guidance.
    if (a.handle.kind !== "pty") {
      try {
        a.handle.attach();
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
    return { ok: true, data: { ws: this.attach.url(name) } };
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
        ? agentAuthState(agentSecretFilePaths(this.workspaceRoot, a.name).health)
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
        ...(health && health.state !== "ok" ? { authHealth: health.state, authReason: health.reason } : {}),
      };
    });
  }
}
