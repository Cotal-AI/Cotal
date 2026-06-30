import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import {
  CotalEndpoint,
  DEFAULT_SERVER,
  MANAGER_LEASE_TTL_MS,
  agentFilePath,
  clearSpaceHistory,
  connectorServers,
  firstFreeName,
  loadAgentFile,
  loadCotalConfig,
  mintCreds,
  mkSecretDir,
  newIdentity,
  provisionAgent,
  registry,
  saveAgentFile,
  writeSecretFile,
  subjectMatches,
  transcriptChannel,
  CONTROL_PRIVILEGED,
  CONTROL_SELF_SERVICE,
  CONTROL_ADMIN,
} from "@cotal-ai/core";
import { authDir, findCotalRoot, loadSpaceAuth, resolveOnPath } from "@cotal-ai/workspace";
import type { AgentDef, Connector, ControlReply, ControlRequest, ControlTier, ManagerLeaseInfo, MeshLaunchAgent, SpaceAuth } from "@cotal-ai/core";
import {
  createRuntime,
  type AgentHandle,
  type Runtime,
  type RuntimeMode,
} from "./runtime/index.js";
import { AttachEndpoint } from "./attach-endpoint.js";
import { launchSpecForRun, materializePersona, launchAgentToStartOpts } from "./launch.js";
import { controlShutdown } from "./control-shutdown.js";

/** Concurrency ceiling — the manager refuses to hold more than this many live + in-flight +
 *  cooling slots at once (P4a). Bounds a fork-bomb: spawn is a full agent process per call. */
const MAX_AGENTS = 50;
/** Minimum slot lifetime for rate-flooring (P4c). A slot freed (by despawn OR natural exit/reap)
 *  before living this long leaves a cooling stamp that still counts toward the ceiling until it
 *  expires — so churn (spawn↔despawn or spawn↔fast-exit) can't outrun the concurrency bound. */
const MIN_LIFETIME = 10_000;

export interface ManagerOptions {
  space: string;
  servers?: string;
  name?: string;
  /** Spawn backend. `auto` (default) → pty; tmux/cmux are explicit-only (fail loud if unimported). */
  runtime?: RuntimeMode;
  workspaceRoot?: string;
  /** Port for the console + attach HTTP/WS endpoint (loopback). 0 → ephemeral. */
  consolePort?: number;
}

/** A spawn request, typed. The control-plane `start` op parses one of these out of an
 *  untyped request; roster boot constructs them directly. Both funnel into {@link Manager.startAgent}. */
export interface StartAgentOpts {
  /** The persona REF to spawn — a filename in `.cotal/agents` (the unique spawn key), discovered as
   *  `.cotal/agents/<name>.md`. NOT the mesh identity: the spawned peer presents under the file's
   *  own `name:` (auto-numbered on collision). The file must exist (no silent default-ACL fallback). */
  name: string;
  /** Connector / agent type — resolved from the registry. Defaults to `"cotal"`. */
  agent?: string;
  role?: string;
  /** Explicit agent-file path that overrides the `name` ref for *which file to load* (identity still
   *  comes from that file's `name:`). The file must exist. */
  config?: string;
  /** Model override (the `--model` flag). Takes precedence over the agent file's `model:`. */
  model?: string;
  /** Mirror the session's transcript to `tr-<name>`. Defaults to off; `true` (the
   *  `--transcript` flag) opts in. */
  transcript?: boolean;
  /** A fully-resolved launch profile (from a mesh manifest via `supervise --launch`). When present,
   *  `startAgent` takes identity/role/ACLs/capabilities/model from here — NOT from a persona file —
   *  and `config` points at the materialized transient persona the connector reads. The persona file
   *  is never the access authority in this path. */
  resolved?: MeshLaunchAgent;
  /** Per-agent working directory to root this agent at, overriding the manager's shared
   *  workspaceRoot. Lets different agents run in different repos/folders. A relative path is
   *  resolved against the manager's workspace root. Omitted → the agent uses workspaceRoot. */
  cwd?: string;
}

interface ManagedAgent {
  name: string;
  role?: string;
  agent: string;
  /** Stable id (nkey public key) the manager assigned this agent at spawn. */
  id: string;
  /** Private nkey seed, kept so a later step can mint matching creds for this id. */
  seed: string;
  /** Authenticated id of the peer that requested this spawn (the control-plane `req.from.id`),
   *  or the manager's own id for roster/pre-spawn. Non-forgeable — set by `handle()`. The spawner
   *  ledger (P4b) keys own-children despawn + reap-on-parent-exit off this. */
  spawner: string;
  startedAt: number;
  handle: AgentHandle;
  /** This agent's local control endpoint (path + first-frame auth token), when its connector runs
   *  one. Kept in memory only (never persisted — token hygiene) so a graceful stop on a signal-less
   *  runtime (ConPTY/Windows) can send a cooperative `{op:"shutdown"}` over it instead of a hard
   *  kill that would deny the agent its clean mesh-leave. */
  control?: { path: string; token: string };
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
  private readonly runtime: Runtime;
  private readonly agents = new Map<string, ManagedAgent>();
  /** Names whose spawn is in flight (reserved synchronously before the provision await) — counted
   *  toward the ceiling so two concurrent same-name spawns can't both pass the gate (P4a). */
  private readonly reserved = new Set<string>();
  /** Expiry stamps (`startedAt + MIN_LIFETIME`) for slots that freed while still young — a
   *  count-only, lazily-pruned recycle floor (P4c). Pruned + summed into the ceiling gate. */
  private cooling: number[] = [];
  private readonly attach: AttachEndpoint;
  private ep!: CotalEndpoint;
  /** Space trust material when the mesh runs in auth mode (`.cotal/auth` present);
   *  the manager mints per-agent creds from it at spawn. Undefined when the mesh is open. */
  private auth?: SpaceAuth;
  private leaseInfo?: Omit<ManagerLeaseInfo, "since">;
  private leaseRevision?: number;
  private leaseTimer?: ReturnType<typeof setInterval>;

  constructor(opts: ManagerOptions) {
    this.space = opts.space;
    this.servers = opts.servers;
    this.name = opts.name ?? "manager";
    this.workspaceRoot = opts.workspaceRoot ?? findCotalRoot();
    this.runtime = createRuntime(opts.runtime ?? "auto", `cotal-${this.space}`);
    this.attach = new AttachEndpoint(
      (name) => this.agents.get(name)?.handle,
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
    this.auth = loadSpaceAuth(authDir(this.workspaceRoot));
    let creds: string | undefined;
    let id: string | undefined;
    if (this.auth) {
      const identity = newIdentity();
      id = identity.id;
      // Privileged profile — the manager pre-creates others' DM durables and serves ctl;
      // minting it as "agent" would silently strip those once step 5 scopes "agent".
      creds = await mintCreds(this.auth, identity, "manager");
    }
    this.ep = new CotalEndpoint({
      space: this.space,
      servers: this.servers,
      channels: [],
      creds,
      // The supervisor serves control + watches presence; it never consumes chat/dm/task
      // (no message handler). consume:false avoids binding consumers it doesn't use — and
      // under auth avoids trying to bind its own DM/task durables that nothing pre-created.
      // It still pre-creates OTHERS' durables via provisionDmInbox/provisionTaskQueue (lazy jsm).
      consume: false,
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
          ? `a manager already serves space "${this.space}" (id ${held.holder}, ${held.runtime}, pid ${held.pid}, root ${held.root}) — stop it first; one manager per space`
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
    this.ep.serveControl(CONTROL_PRIVILEGED, (req) => this.handle(req, CONTROL_PRIVILEGED));
    this.ep.serveControl(CONTROL_SELF_SERVICE, (req) => this.handle(req, CONTROL_SELF_SERVICE));
    this.ep.serveControl(CONTROL_ADMIN, (req) => this.handle(req, CONTROL_ADMIN));
    // Plane-3 (durable backstop) is NOT the manager's job — the manager only manages agent lifecycle.
    // The server-side delivery daemon hosts the fan-out writer + trusted reader, owns the durable
    // membership registry, and serves the runtime durable join/leave/list ops (on `ctl.delivery`). The
    // manager records each agent's read ACL at spawn (`commitAcl`, in provisionAgent) so the daemon can
    // re-authorize it; that is the only Plane-3 state the manager touches, and it rides minting.
  }

  async stop(): Promise<void> {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    await this.ep.releaseManagerLease(this.leaseRevision);
    await this.ep.stop();
    await this.attach.stop();
  }

  /** Refresh the singleton lease before the bucket TTL expires it. On loss (missed the TTL, or another
   *  manager took over after a gap) FAIL CLOSED: stop serving control at once so we can't double-process
   *  with the new holder, and exit. We deliberately do NOT re-acquire (a replacement may already be live
   *  while we'd still be serving) and do NOT release the key — it now belongs to that replacement. */
  private async renewLease(): Promise<void> {
    if (!this.leaseInfo || this.leaseRevision === undefined) return;
    try {
      this.leaseRevision = await this.ep.renewManagerLease(this.leaseInfo, this.leaseRevision);
    } catch (e) {
      console.error(`! manager lost its singleton lease for space "${this.space}" (${(e as Error).message}) — shutting down to avoid two managers serving it`);
      if (this.leaseTimer) clearInterval(this.leaseTimer);
      try { await this.ep.stop(); } catch { /* best effort */ }
      try { await this.attach.stop(); } catch { /* best effort */ }
      process.exit(1);
    }
  }

  private async handle(req: ControlRequest, tier: ControlTier): Promise<ControlReply> {
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
        // SECURITY: manifest launch is operator-only (admin tier). It is higher-power than `start`
        // — it boots an operator-authored, coordinated policy set from a run spec and underpins the
        // ownership ledger — so a merely spawn-capable agent (which CAN publish to the privileged
        // subject) must not reach it. Gate at the handler like `purge`; the subject alone isn't a
        // boundary because `spawn` grants privileged-subject publish and dispatch is by op here.
        if (!admin) return { ok: false, error: "launch is admin-only; not allowed on the privileged subject" };
        return this.opLaunch(args, caller);
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
        return { ok: true, data: this.list() };
      case "status": {
        const a = this.list().find((x) => x.name === name);
        return a ? { ok: true, data: a } : { ok: false, error: `no agent "${name}"` };
      }
      default:
        return { ok: false, error: `unknown op: ${req.op}` };
    }
  }

  /** Collapsed despawn/attach authorization (P4b). The caller already reached the privileged or
   *  admin tier (cred-gated). On the admin tier any named target is allowed (operator). On the
   *  privileged tier a named target is allowed ONLY if it's the caller's OWN child
   *  (`spawner == caller`) — so a spawn-capable peer can tear down what it spawned, never a peer's.
   *  Returns an error string when denied, `undefined` when allowed. */
  private authorizeNamed(target: ManagedAgent, caller: string, admin: boolean): string | undefined {
    if (admin) return undefined;
    if (target.spawner === caller) return undefined;
    return `not authorized: ${target.name} was not spawned by ${caller} (admin tier required)`;
  }

  /** Self-despawn (P2b): stop the managed agent whose id == the authenticated caller. The
   *  no-name self-op can only ever resolve to the caller's OWN managed entry (ids are unique
   *  per spawn + non-forgeable in auth mode), never a peer — so it's structurally incapable of
   *  hitting another agent. Non-managed callers (human CLI, the manager itself, observers) find
   *  no match and get a loud error, not a silent no-op. */
  private opStopSelf(callerId: string, args: Record<string, unknown>): ControlReply {
    const target = [...this.agents.values()].find((a) => a.id === callerId);
    if (!target) return { ok: false, error: `self-stop: caller ${callerId} is not a managed agent` };
    const graceful = args.graceful !== false;
    this.stopHandle(target, graceful);
    this.freeSlot(target, true); // self-despawn is rate-floored (recycle churn)
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
   *  (`graceful:false`, e.g. emergency reap) skips the cooperative step on every platform. */
  private stopHandle(a: ManagedAgent, graceful: boolean): void {
    if (graceful && process.platform === "win32" && a.control) controlShutdown(a.control);
    a.handle.stop({ graceful });
  }

  /** Drop a live agent's slot. When `floor` is set and the agent died young (lived less than
   *  MIN_LIFETIME), push a cooling stamp so the freed slot still counts toward the ceiling until it
   *  expires — flooring the RECYCLE, not the call, so both free paths (despawn + exit/reap) are
   *  covered (P4c). Floor self + own-child despawn and natural exit; NEVER admin despawn (operator
   *  emergency-kill stays unthrottled) and NEVER the reserved-rollback path (no cold-start paid). */
  private freeSlot(a: ManagedAgent, floor: boolean): void {
    if (this.agents.get(a.name) !== a) return; // already freed (exit raced despawn, etc.)
    this.agents.delete(a.name);
    if (floor && Date.now() - a.startedAt < MIN_LIFETIME) this.cooling.push(a.startedAt + MIN_LIFETIME);
  }

  /** Reap a parent's children on its exit (P4b): stop + free every agent whose `spawner` is the
   *  exited agent's id, so orphans don't ratchet the ceiling shut. Recursive — a reaped child's
   *  own children are reaped too. Exit-driven, so each freed slot is rate-floored like a despawn. */
  private reapChildrenOf(parentId: string): void {
    for (const child of [...this.agents.values()]) {
      if (child.spawner !== parentId) continue;
      this.stopHandle(child, false);
      this.freeSlot(child, true);
      this.reapChildrenOf(child.id);
    }
  }

  /** A managed agent's process exited on its own (crash, /exit, finished). Free its slot
   *  (rate-floored — exit-driven churn counts) and reap any children it spawned. Idempotent via
   *  freeSlot's identity guard, so a later graceful-stop SIGKILL firing exit again is a no-op. */
  private onAgentExit(a: ManagedAgent): void {
    this.freeSlot(a, true);
    this.reapChildrenOf(a.id);
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
    return firstFreeName(base, (n) => this.agents.has(n) || this.reserved.has(n));
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
    return this.startAgent(
      {
        name: String(args.name ?? "").trim(),
        agent: args.agent ? String(args.agent) : undefined,
        role: args.role ? String(args.role) : undefined,
        config: args.config ? String(args.config) : undefined,
        model: args.model ? String(args.model) : undefined,
        transcript: typeof args.transcript === "boolean" ? args.transcript : undefined,
        cwd: args.cwd ? String(args.cwd) : undefined,
      },
      caller,
    );
  }

  /** Boot one resolved agent from a mesh-manifest launch spec, for `cotal spawn -f` onto a RUNNING
   *  manager. The request carries a `{ runId, name }`, NEVER a path: the manager derives + validates
   *  `.cotal/run/<runId>.json` itself ({@link launchSpecForRun} — token-safe id, no-follow,
   *  `loadLaunchSpec`'s untrusted-input + `validateLaunchPolicy` contract), materializes the named
   *  agent's transient persona, and spawns via the same `startAgent({ resolved })` path as
   *  `supervise --launch`. The reply is enriched for the ownership ledger: the SPAWNED
   *  (collision-numbered) name + nkey id creds are filed under, plus the manifest `requested` name,
   *  `runId`, and resolved `hash`. */
  private async opLaunch(args: Record<string, unknown>, caller: string): Promise<ControlReply> {
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
    let configPath: string;
    try {
      configPath = materializePersona(this.workspaceRoot, runId, la);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const reply = await this.startAgent(launchAgentToStartOpts(la, configPath), caller);
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
    const agent = opts.agent ?? "cotal";

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
        return { ok: false, error: `no persona "${ref}" — ${configPath} not found; create it or pass --config (see \`cotal personas list\`)` };
    }

    // Connector + harness preflight before reserving a slot or minting — a missing connector or a
    // missing `claude`/`opencode` binary fails here with a clear name, not obscurely at process
    // spawn. No fallback. All synchronous, so the reserve gate stays atomic.
    let connector: Connector;
    try {
      connector = registry.resolve<Connector>("connector", agent);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const missing = (connector.requires ?? []).filter((bin) => !resolveOnPath(bin));
    if (missing.length)
      return { ok: false, error: `${agent} harness needs ${missing.join(", ")} on PATH — not found` };

    // Resolve the launch profile: IDENTITY (free-form `name:`) + role + read/post ACL + capabilities
    // + model. Either from a fully-resolved manifest launch object (`opts.resolved`, whose `config`
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
    if (opts.resolved) {
      const r = opts.resolved;
      identityName = r.name;
      role = opts.role ?? r.role;
      subscribe = r.subscribe;
      allowSubscribe = r.allowSubscribe?.length ? r.allowSubscribe : r.subscribe;
      allowPublish = r.allowPublish;
      capabilities = r.capabilities;
      model = opts.model ?? r.model;
    } else {
      let def: AgentDef;
      try {
        def = loadAgentFile(configPath);
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
      identityName = def.name;
      role = opts.role ?? def.role;
      subscribe = def.subscribe;
      // Defaulted the same way the loader/provisioner do — minted into the creds (the broker
      // boundary); runtime durable joins are re-authorized against the committed ACL by the daemon.
      allowSubscribe = def.allowSubscribe ?? def.subscribe ?? ["general"];
      allowPublish = def.allowPublish;
      capabilities = def.capabilities;
    }
    const idErr = this.nameError(identityName);
    if (idErr) return { ok: false, error: opts.resolved ? `launch agent: ${idErr}` : `persona ${configPath}: ${idErr}` };

    const name = this.uniqueName(identityName);
    this.reserved.add(name);
    // Transcript mirroring → `tr-<name>`: default-on when COTAL_TRANSCRIPT_DEFAULT=1 (scoped per mesh
    // by the operator's `cotal up` env) so observers can read what every managed agent actually did.
    // Auth-mode publish is default-deny, so grant the agent pub on its OWN tr-<name> (else the mirror's
    // publish is rejected). transcriptChannel() is the shared convention (core) the connectors publish to.
    const transcript = opts.transcript ?? process.env.COTAL_TRANSCRIPT_DEFAULT === "1";
    if (transcript) allowPublish = [...(allowPublish ?? []), transcriptChannel(name)];
    try {
      // A stable nkey identity assigned at spawn: the public key is the agent's card.id (threaded via
      // COTAL_ID); the seed is retained to mint matching creds later.
      const identity = newIdentity();
      // In auth mode, mint the agent's creds from the space signing key and write them where the
      // spawned session reads them (COTAL_CREDS path). Open mesh → no creds. Scope = the resolved
      // subscribe/allowSubscribe (read) + allowPublish (post, default-deny).
      let credsPath: string | undefined;
      if (this.auth) {
        // Pre-create the agent's bind-only chat (+ DM + role TASK) durables and mint its scoped creds
        // — the shared onboarding step (provisionAgent); the manager supplies its own connected
        // endpoint as the privileged provisioner.
        const creds = await provisionAgent(this.ep, this.auth, identity, {
          subscribe,
          allowSubscribe,
          allowPublish,
          role,
          capabilities,
        });
        credsPath = join(authDir(this.workspaceRoot), "creds", `${name}.creds`);
        mkSecretDir(dirname(credsPath)); // harden the creds dir before the cred lands
        writeSecretFile(credsPath, creds);
      }
      // Personal MCP servers the operator opted to share with manager-spawned agents of this type
      // (cotal config; default none → isolated, the memory-safe default this guards).
      const mcpServers = connectorServers(loadCotalConfig(this.workspaceRoot), agent);
      // Per-agent cwd overrides the manager's shared workspace root, so agents can be rooted at
      // arbitrary folders/repos. A relative path resolves against the workspace root; omitted → the
      // agent shares the workspace root (the prior, unchanged behavior).
      const cwd = opts.cwd ? resolve(this.workspaceRoot, opts.cwd) : this.workspaceRoot;
      const spec = connector.buildLaunch({
        space: this.space,
        name,
        role,
        id: identity.id,
        creds: credsPath,
        servers: this.servers,
        configPath,
        model,
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
        id: identity.id,
        seed: identity.seed,
        spawner: spawner ?? this.ep.ref().id,
        startedAt: Date.now(),
        handle,
        control: spec.control,
      };
      this.agents.set(name, managed);
      // Wire the runtime exit signal so a natural exit (crash / /exit / finished) frees the slot
      // (rate-floored) and reaps any children — keeps the ceiling from ratcheting shut with orphans.
      this.watchExit(managed);
      return { ok: true, data: { name, role, agent, id: identity.id, mode: handle.kind } };
    } catch (e) {
      // Failure after reserve (provision / launch threw): the slot was never live, so no cold-start
      // was paid — the reserved rollback (finally) is enough, no cooling stamp.
      return { ok: false, error: (e as Error).message };
    } finally {
      this.reserved.delete(name);
    }
  }

  /** Subscribe to a managed agent's process-exit so a self-driven exit frees its slot and reaps
   *  its children (P4b/P4c). Only pty streams exit (via the attach session's `onExit`); tmux/cmux
   *  attach() throws, so this is a no-op there — a self-EXITED agent under those runtimes is reaped
   *  by nothing until it's explicitly despawned (graceful-stop runs on despawn, not self-exit). The
   *  cap still holds (a lingering corpse counts toward it); runtime-agnostic exit-reaping (a real
   *  per-runtime `status()` → exited-sweep at the availability gate) is a tracked follow-up. */
  private watchExit(a: ManagedAgent): void {
    try {
      a.handle.attach().onExit(() => this.onAgentExit(a));
    } catch {
      /* runtime doesn't stream an exit signal (tmux/cmux) — nothing to wire */
    }
  }

  /** Prune expired cooling stamps (drop those at/before now) and return the live count — the
   *  recycle floor's contribution to the ceiling (P4c). Lazy: pruned only when the gate consults it. */
  private coolingCount(): number {
    const now = Date.now();
    this.cooling = this.cooling.filter((stamp) => stamp > now);
    return this.cooling.length;
  }

  private opStop(args: Record<string, unknown>, caller: string, admin: boolean): ControlReply {
    const name = String(args.name ?? "").trim();
    const a = this.agents.get(name);
    if (!a) return { ok: false, error: `no agent "${name}"` };
    const denied = this.authorizeNamed(a, caller, admin);
    if (denied) return { ok: false, error: denied };
    const graceful = args.graceful !== false;
    this.stopHandle(a, graceful);
    this.freeSlot(a, !admin); // own-child despawn is rate-floored; admin emergency-kill is not
    return { ok: true, data: { name, stopped: true, graceful } };
  }

  /** Purge the space's retained message backlog (chat, optionally DMs). Privileged — the
   *  manager mints its own "manager" creds (same as `cotal history clear`); regular agents are
   *  denied STREAM.PURGE under auth. Cleanup only: leaves live agents and the TASK queue alone. */
  private async opPurge(args: Record<string, unknown>, _caller: string): Promise<ControlReply> {
    const includeDms = args.includeDms === true;
    try {
      const creds = this.auth ? await mintCreds(this.auth, newIdentity(), "manager") : undefined;
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
        const owner = def.owner ? `owned by ${def.owner}` : "operator-owned (legacy file — no agent owner)";
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

  private opAttach(args: Record<string, unknown>, caller: string, admin: boolean): ControlReply {
    const name = String(args.name ?? "").trim();
    const a = this.agents.get(name);
    if (!a) return { ok: false, error: `no agent "${name}"` };
    // attach grants terminal read+write — same own/admin scoping as despawn: own child on the
    // privileged tier, any agent on admin.
    const denied = this.authorizeNamed(a, caller, admin);
    if (denied) return { ok: false, error: denied };
    // Only pty streams over the WS attach endpoint. tmux/cmux are watched natively, and
    // each handle's attach() throws with the right per-runtime guidance (tmux attach … /
    // switch to the cmux tab) — surface that instead of assuming tmux.
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
  private list() {
    const roster = new Map(this.ep.getRoster().map((p) => [p.card.name, p]));
    return [...this.agents.values()].map((a) => ({
      name: a.name,
      // The spawned agent's nkey — lets an operator tool (e.g. `cotal down -f`) match a ledger entry
      // by name AND id before stopping, so it never stops a same-named foreign agent.
      id: a.id,
      role: a.role,
      agent: a.agent,
      space: this.space,
      mode: a.handle.kind,
      status: a.handle.status(),
      uptimeMs: Date.now() - a.startedAt,
      mesh: roster.get(a.name)?.status ?? "absent",
    }));
  }
}
