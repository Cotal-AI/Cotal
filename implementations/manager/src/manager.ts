import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  CotalEndpoint,
  DEFAULT_SERVER,
  agentFilePath,
  authDir,
  clearSpaceHistory,
  findCotalRoot,
  loadAgentFile,
  loadSpaceAuth,
  mintCreds,
  newIdentity,
  provisionAgent,
  registry,
  saveAgentFile,
} from "@cotal-ai/core";
import type { AgentDef, Connector, ControlReply, ControlRequest, SpaceAuth } from "@cotal-ai/core";
import {
  createRuntime,
  type AgentHandle,
  type Runtime,
  type RuntimeMode,
} from "./runtime/index.js";
import { AttachEndpoint } from "./attach-endpoint.js";

export interface ManagerOptions {
  space: string;
  servers?: string;
  name?: string;
  /** Spawn backend. `auto` (default) → pty, or tmux when already inside tmux. */
  runtime?: RuntimeMode;
  workspaceRoot?: string;
  /** Port for the console + attach HTTP/WS endpoint (loopback). 0 → ephemeral. */
  consolePort?: number;
}

interface ManagedAgent {
  name: string;
  role?: string;
  agent: string;
  /** Stable id (nkey public key) the manager assigned this agent at spawn. */
  id: string;
  /** Private nkey seed, kept so a later step can mint matching creds for this id. */
  seed: string;
  startedAt: number;
  handle: AgentHandle;
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
  private readonly attach: AttachEndpoint;
  private ep!: CotalEndpoint;
  /** Space trust material when the mesh runs in auth mode (`.cotal/auth` present);
   *  the manager mints per-agent creds from it at spawn. Undefined when the mesh is open. */
  private auth?: SpaceAuth;

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
    this.ep.serveControl("manager", (req) => this.handle(req));
  }

  async stop(): Promise<void> {
    await this.ep.stop();
    await this.attach.stop();
  }

  private async handle(req: ControlRequest): Promise<ControlReply> {
    const args = req.args ?? {};
    switch (req.op) {
      case "start":
        return this.opStart(args);
      case "stop":
        return this.opStop(args);
      case "definePersona":
        return this.opDefinePersona(args);
      case "purge":
        return this.opPurge(args);
      case "attach":
        return this.opAttach(args);
      case "ps":
        return { ok: true, data: this.list() };
      case "status": {
        const name = String(args.name ?? "");
        const a = this.list().find((x) => x.name === name);
        return a ? { ok: true, data: a } : { ok: false, error: `no agent "${name}"` };
      }
      default:
        return { ok: false, error: `unknown op: ${req.op}` };
    }
  }

  /** Agent names become `.cotal/agents/<name>.md` paths and mesh identities, so they must be bare
   *  tokens, never a path — blocks traversal / arbitrary writes from a model-supplied name. */
  private nameError(name: string): string | undefined {
    return /^[A-Za-z0-9_-]+$/.test(name)
      ? undefined
      : `unsafe name ${JSON.stringify(name)} (allowed: letters, digits, _ -)`;
  }

  /** Spawn a teammate by name (loads `.cotal/agents/<name>.md`), as if a peer asked via the
   *  control plane. Used to pre-spawn the demo's experts at startup so the manager owns them. */
  async startByName(name: string): Promise<ControlReply> {
    return this.opStart({ name });
  }

  /** Resolve once `name` shows up on the mesh roster (presence registered), or after `timeoutMs`.
   *  Lets the pre-spawn loop stagger heavy agent cold-starts so they don't all boot at once. */
  async waitForPresence(name: string, timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.ep.getRoster().some((p) => p.card.name === name)) return true;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return false;
  }

  private async opStart(args: Record<string, unknown>): Promise<ControlReply> {
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, error: "name required" };
    const nameErr = this.nameError(name);
    if (nameErr) return { ok: false, error: nameErr };
    if (this.agents.has(name)) return { ok: false, error: `agent "${name}" already running` };
    const agent = args.agent ? String(args.agent) : "cotal";

    // Resolve an agent file from the manager's own workspace — an explicit
    // --config must exist; otherwise discover .cotal/agents/<name>.md if present.
    let configPath: string | undefined;
    if (args.config) {
      configPath = agentFilePath(this.workspaceRoot, String(args.config));
      if (!existsSync(configPath)) return { ok: false, error: `agent file not found: ${configPath}` };
    } else {
      const f = agentFilePath(this.workspaceRoot, name);
      if (existsSync(f)) configPath = f;
    }
    // --role overrides the file; the file fills it in for bookkeeping otherwise.
    let role = args.role ? String(args.role) : undefined;
    // A stable nkey identity assigned at spawn: the public key is the agent's card.id
    // (threaded via COTAL_ID); the seed is retained to mint matching creds later.
    const identity = newIdentity();
    let handle: AgentHandle;
    try {
      const connector = registry.resolve<Connector>("connector", agent);
      const def = configPath ? loadAgentFile(configPath) : undefined;
      if (!role) role = def?.role;
      // In auth mode, mint the agent's creds from the space signing key and write them
      // where the spawned session reads them (COTAL_CREDS path). Open mesh → no creds.
      // The publish allow-list is the file's `publish:`, falling back to `channels:`.
      let credsPath: string | undefined;
      if (this.auth) {
        // Pre-create the agent's bind-only DM (+ role TASK) durables and mint its scoped
        // creds — the shared onboarding step (provisionAgent), the manager just supplies its
        // own connected endpoint as the privileged provisioner.
        const creds = await provisionAgent(this.ep, this.auth, identity, {
          channels: def?.publish ?? def?.channels,
          role,
        });
        credsPath = join(authDir(this.workspaceRoot), "creds", `${name}.creds`);
        mkdirSync(dirname(credsPath), { recursive: true });
        writeFileSync(credsPath, creds, { mode: 0o600 });
      }
      const spec = connector.buildLaunch({
        space: this.space,
        name,
        role,
        id: identity.id,
        creds: credsPath,
        servers: this.servers,
        configPath,
        resume: args.resume ? String(args.resume) : undefined,
      });
      handle = this.runtime.spawn(name, spec, this.workspaceRoot);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    this.agents.set(name, {
      name,
      role,
      agent,
      id: identity.id,
      seed: identity.seed,
      startedAt: Date.now(),
      handle,
    });
    return { ok: true, data: { name, role, agent, id: identity.id, mode: handle.kind } };
  }

  private opStop(args: Record<string, unknown>): ControlReply {
    const name = String(args.name ?? "").trim();
    const a = this.agents.get(name);
    if (!a) return { ok: false, error: `no agent "${name}"` };
    const graceful = args.graceful !== false;
    a.handle.stop({ graceful });
    this.agents.delete(name);
    return { ok: true, data: { name, stopped: true, graceful } };
  }

  /** Purge the space's retained message backlog (chat, optionally DMs). Privileged — the
   *  manager mints its own "manager" creds (same as `cotal history clear`); regular agents are
   *  denied STREAM.PURGE under auth. Cleanup only: leaves live agents and the TASK queue alone. */
  private async opPurge(args: Record<string, unknown>): Promise<ControlReply> {
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
   *  .cotal/agents/<name>.md and the connector applies its persona/model at spawn. */
  private opDefinePersona(args: Record<string, unknown>): ControlReply {
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, error: "name required" };
    const nameErr = this.nameError(name);
    if (nameErr) return { ok: false, error: nameErr };
    const persona = String(args.persona ?? "").trim();
    if (!persona) return { ok: false, error: "persona required" };
    const def: AgentDef = {
      name,
      role: args.role ? String(args.role) : undefined,
      model: args.model ? String(args.model) : undefined,
      persona,
    };
    const path = agentFilePath(this.workspaceRoot, name);
    try {
      saveAgentFile(path, def);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    return { ok: true, data: { name, path } };
  }

  private opAttach(args: Record<string, unknown>): ControlReply {
    const name = String(args.name ?? "").trim();
    const a = this.agents.get(name);
    if (!a) return { ok: false, error: `no agent "${name}"` };
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
