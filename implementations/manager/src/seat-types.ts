import type { ControlEndpoint, EpErrorCode, FirstCommand, GoalRef, Identity, InlinePersona, IssuedBinding, LaunchModes, LaunchOpts, MeshLaunchAgent, PersonaEndpoint } from "@cotal-ai/core";
import type { AgentHandle } from "./runtime/index.js";
import type { ContinuityAssignment } from "./launch.js";
import type { FreeSlotCause, ForkProvenance, ManagerResumeAgent } from "./manager.js";

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
  /** Mode choices (the `--mode` flags), checked against the connector's catalog before launch. */
  modes?: LaunchModes;
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
  /** The one-time claim `transcript-receive` issued for carried bytes of {@link resume}, and
   *  the agent the CLI found them with. Imperative control args only, like `resume`. */
  resumeClaim?: string;
  resumeAgent?: string;
  /** Publish the session's AG-UI event plane to its own principal-keyed event channel. Defaults to
   *  on when the connector declares one; `false` (`--no-events`) is the explicit opt-out. */
  events?: boolean;
  eventPayloads?: boolean;
  /** Launch the harness asking before it uses a tool. Refused before provisioning on a connector
   *  that does not declare `supportsAskPermissions`. */
  askPermissions?: boolean;
  /** Publish the model's reasoning on the event plane. Refused before provisioning on a connector
   *  that does not declare `supportsReasoningEvents`, and on a launch without the event plane. */
  reasoningEvents?: boolean;
  /** `opStart` sets this when a non-owner, non-admin caller omits `events` and the event plane
   *  is disarmed. The reply includes it so the caller sees the downgrade. */
  eventsNotice?: string;
  /** Initial prompt auto-submitted at session start (the `--prompt` flag), forwarded verbatim to
   *  the connector. Imperative launches only — a manifest launch carries its own `resolved.prompt`
   *  and rejects this flag alongside it (one source, no merge). */
  prompt?: string;
  /** A harness command or skill the seat runs as its first turn, under the id the spawn's acceptance
   *  names (SPEC 13.22). Imperative launches only, and never recorded on the launch, so no restart
   *  runs it again. */
  firstCommand?: FirstCommand;
  /** The seat labels itself from its first message (`LaunchOpts.autoName`). Imperative launches only,
   *  and only on this host: a delegated runtime refuses it. A relaunch never passes it again. */
  autoName?: boolean;
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
  /** The §13.2 rail this spawn rode. Wire harness refusals name `--on`; direct in-process
   *  `startAgent` (roster / `--spawn`, `route` undefined) keeps the local reason only. */
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

export interface ManagedLaunch {
  source: ManagerResumeAgent["launch"]["source"];
  /** The runtime kind this seat was launched on. Absent means the manager's own runtime. */
  runtime?: string;
  cwd: string;
  model?: string;
  variant?: string;
  modes?: LaunchModes;
  prompt?: string;
  subscribe?: string[];
  allowSubscribe: string[];
  allowPublish?: string[];
  capabilities?: string[];
  /** The persona's endpoint commands, as minted. Renewal re-mints their rows. */
  endpoints?: PersonaEndpoint[];
  events: boolean;
  eventPayloads?: boolean;
  /** Recorded only when true, so every relaunch of the seat asks as its spawn did. */
  askPermissions?: true;
  reasoningEvents?: true;
  shareTools?: readonly string[];
  forkSource?: string;
  /** Read from {@link resumeRecordPath} once the seat has written it, then kept. */
  resumed?: ForkProvenance;
  /** A carried resume's claim: the digest the manager staged, which the seat's fork record
   *  must name before {@link resumed} is set, the host it came from, and when it was staged. */
  carried?: { transcriptSha256: string; host: string; transferredAt: string };
  /** The connector's {@link LaunchSpec.resumeRecordPath} for this seat's fork. */
  resumeRecordPath?: string;
  sessionId?: string;
  unresolvedLaunchOptionKeys?: string[];
}

export interface ManagedAgent {
  name: string;
  /** The display name the seat last showed in its own presence, when `set-name` made it differ from
   *  {@link name}, the alias every manager key and, in user mode, the actor stay on. Kept with the
   *  seat so a relaunch starts with it (`LaunchOpts.displayName`). */
  displayName?: string;
  role?: string;
  agent: string;
  /** The seat-private Claude home a carried resume launches in. Removed when the seat is freed. */
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
  /** Set while the manager has logged this seat off the mesh but still holds its slot.
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
  /** The id the seat's first command is queued under, when the spawn named one. */
  firstCommand?: { id: string };
  executor: { lifecycleUid: string; epoch: number };
}
