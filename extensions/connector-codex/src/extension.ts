/**
 * The Codex connector: launches a host-mode peer that embeds the Cotal endpoint and drives a
 * `codex app-server` thread over JSON-RPC (see host.ts). A mesh message becomes a real
 * Codex turn — wake an idle thread (`turn/start`) or steer a directed message into one already
 * running (`turn/steer`) — and the cotal_* tools are served by the host over a loopback MCP
 * endpoint, so the session is a full lateral peer at parity with the other connectors. Presence
 * is read off the app-server event stream; with a terminal the host attaches the real Codex TUI,
 * and without one it prints an activity feed. Self-registers on import; the manager resolves it
 * by agent type "codex".
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadAgentFile, registry, type Connector, type LaunchOpts, type LaunchSpec, type ModelCatalog, type ModelInfo } from "@cotal-ai/core";
import { aclEnv, connectorLaunchOptions, controlEndpoint, launchEnv, eventChannel, userAuthEnv } from "@cotal-ai/connector-core";

/** Env the codex child genuinely needs beyond the OS allow-list: the API key (API-key auth) and
 *  the operator's CODEX_HOME override (the host resolves auth.json from it). Forwarded BY NAME,
 *  never `...process.env` (P3). ChatGPT-plan auth rides auth.json under HOME/CODEX_HOME. */
const CODEX_ENV_KEYS = ["OPENAI_API_KEY", "CODEX_HOME"] as const;

/** The bundled host loop (self-contained — core + connector-core inlined, see package.json's
 *  bundle script) run with this same node; from SOURCE (dev), the `.ts` entry through tsx. */
const FROM_BUILD = import.meta.url.includes("/dist/");
const HOST_ENTRY = fileURLToPath(new URL(`./${FROM_BUILD ? "host.js" : "host-main.ts"}`, import.meta.url));
const HOST_COMMAND = FROM_BUILD
  ? process.execPath
  : fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

/** Discovery env for `listModels`: the operator's own codex (their CODEX_HOME/auth), with the
 *  mesh identity scrubbed so a catalog probe can never look like a managed session. */
function discoveryEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("COTAL_")) delete env[k];
  return env;
}

interface CodexModelEntry {
  id?: string;
  model?: string;
  displayName?: string;
  hidden?: boolean;
  supportedReasoningEfforts?: { reasoningEffort?: string; description?: string }[];
}

/** Query the model catalog over a short-lived `codex app-server` (`model/list` — there is no
 *  `codex models` subcommand). Times out rather than hanging the manager's selector UI. */
async function listCodexModels(): Promise<ModelCatalog> {
  const child = spawn("codex", ["app-server"], { env: discoveryEnv(), stdio: ["pipe", "pipe", "ignore"] });
  const kill = (): void => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  };
  try {
    const result = await new Promise<{ data?: CodexModelEntry[] }>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error("codex app-server model/list timed out (10s)")), 10_000);
      let buf = "";
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (d: string) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg: { id?: number; result?: unknown; error?: { message?: string } };
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.id === 1) {
            child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "model/list", params: {} }) + "\n");
          } else if (msg.id === 2) {
            clearTimeout(timer);
            if (msg.error) reject(new Error(msg.error.message ?? "model/list failed"));
            else resolvePromise((msg.result ?? {}) as { data?: CodexModelEntry[] });
          }
        }
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`codex app-server exited (${code}) before model/list answered`));
      });
      child.stdin!.write(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "cotal", title: "Cotal", version: "0.0.0" } } }) + "\n",
      );
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
    });
    const models: ModelInfo[] = (result.data ?? [])
      .filter((m) => !m.hidden && (m.model || m.id))
      .map((m) => ({
        id: m.model ?? m.id!,
        provider: "openai",
        ...(m.displayName ? { name: m.displayName } : {}),
        ...(m.supportedReasoningEfforts?.length
          ? {
              variants: m.supportedReasoningEfforts
                .filter((e) => typeof e.reasoningEffort === "string")
                .map((e) => ({ name: e.reasoningEffort!, ...(e.description ? { options: { description: e.description } } : {}) })),
            }
          : {}),
      }));
    return { source: "codex app-server model/list", models };
  } finally {
    kill();
  }
}

export const codexConnector: Connector = {
  kind: "connector",
  name: "codex",
  eventChannel, // the shared `events.<owner>.<actor>` mapping (connector-core), via the contract
  requires: ["codex"],
  supportsModelVariant: true, // variant = Codex reasoning effort (minimal|low|medium|high|xhigh)
  // There is no first-run gate to press through here: the host joins the mesh FIRST (app-server,
  // credentials, tools) and only then hands the terminal to Codex, so the honest thing to tell
  // someone staring at a blank terminal is that the pause is the mesh, and the UI is coming.
  launchHint: "joining the mesh, then Codex opens",
  listModels: listCodexModels,

  buildLaunch(opts: LaunchOpts): LaunchSpec {
    // Resuming isn't wired: a thread brought up with `thread/resume` does not carry the cotal_*
    // MCP surface. Verified against codex-cli 0.145.0 — the resume succeeds and the turn runs,
    // but the model answers "mesh_ping tool unavailable" — so a resumed agent would come up mute
    // on the mesh (silent degradation). Throw until a resumed thread gets its configured MCP
    // servers. (`codex exec resume` is a same-thread HIJACK and is never an option.)
    if (opts.resume)
      throw new Error(
        "codex connector: resuming an existing session (resume) is not supported — a resumed codex " +
          "thread comes up without the cotal_* MCP tools, so the agent would be mute on the mesh",
      );
    // Tool-sharing isn't wired: rendering operator MCP servers into the per-agent codex config
    // means resolving `${VAR}` secret refs into a child config surface; that expansion story is a
    // separate feature. Throw rather than silently ignore (no fallbacks).
    if (opts.mcpServers && Object.keys(opts.mcpServers).length > 0)
      throw new Error("codex connector: tool-sharing (connectors.codex.mcpServers) is not implemented");

    const env: Record<string, string> = {
      ...launchEnv({ providerKeys: CODEX_ENV_KEYS }),
      ...aclEnv(opts),
      ...userAuthEnv(opts),
      COTAL_SPACE: opts.space,
      COTAL_NAME: opts.name,
    };
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.lifecycleUid) env.COTAL_LIFECYCLE_UID = opts.lifecycleUid;
    if (opts.creds) env.COTAL_CREDS = opts.creds;
    if (opts.servers) env.COTAL_SERVERS = opts.servers;
    if (opts.events === true) env.COTAL_EVENTS = "1"; // gate the host's transcript mirror
    // The event WAL's state root (`agui-events.md:676-687`), forwarded on every launch path so the
    // root is present before the connector that consumes it cuts over. No `?? process.cwd()`
    // fallback: this root exists precisely to keep durable per-agent state out of a working
    // directory that can point at any repo, and a default would silently reintroduce that.
    if (opts.workspaceRoot) env.COTAL_WORKSPACE_ROOT = opts.workspaceRoot;
    if (opts.prompt) env.COTAL_CODEX_PROMPT = opts.prompt; // auto-submitted first turn
    // The host picks TUI vs headless from its own stdout, and COTAL_CODEX_TUI overrides that. The
    // child's env is an ALLOW-LIST, so without forwarding it by name the override would silently
    // do nothing.
    //
    // It is read from whichever process builds the launch, and that is NOT always the operator's
    // shell: a detached spawn is built inside the MANAGER, so the manager's environment is what
    // decides there (one setting for every codex agent it supervises), while a foreground spawn
    // reads the shell that ran it. Passing it through the spawn request instead would make it a
    // per-agent launch option, which is a bigger surface than a display toggle earns; the split is
    // documented in docs/connect-codex.md rather than half-wired.
    const tuiPref = process.env.COTAL_CODEX_TUI?.trim();
    if (tuiPref) env.COTAL_CODEX_TUI = tuiPref;

    // Where the host roots the per-agent CODEX_HOME (`.cotal/codex/<name>`): the manager's
    // workspace, or the launch dir for a standalone spawn — never the per-agent cwd, which can
    // point at any repo (parity with the OpenCode connector's data root).
    env.COTAL_CODEX_HOME = opts.workspaceRoot ?? process.cwd();

    // An agent file carries identity (read in-session via COTAL_AGENT_FILE) plus persona (the
    // host injects it as thread developerInstructions) and model/variant defaults.
    let model = opts.model;
    let variant = opts.variant;
    if (opts.configPath) {
      const path = resolve(opts.configPath);
      env.COTAL_AGENT_FILE = path;
      const def = loadAgentFile(path);
      model ??= def.model;
      variant ??= def.variant;
    }
    if (model) env.COTAL_MODEL = model;
    if (variant) env.COTAL_VARIANT = variant; // reasoning effort; unvalidated here, like the CLI itself
    // Opaque connector options → codex `-c key=value` config overrides on the app-server child,
    // RAW passthrough (the spawn capability is the trust boundary, not the key set — see
    // connectorLaunchOptions). The key-shape guard admits top-level config keys only (no dotted
    // paths). The host appends its autonomy defaults (approval_policy, sandbox_mode) and the
    // model/effort selectors ONLY for keys the operator didn't set, so an explicit --opt wins.
    const overrides: Record<string, unknown> = {};
    let hasOverrides = false;
    for (const [k, v] of connectorLaunchOptions("codex", opts.launchOptions)) {
      // A `-c` value is TOML text. Scalars render faithfully (`String(v)`); an object/array from
      // a persona's launchOptions mapping would render "[object Object]" — a silently garbled
      // override — so non-scalars are refused (write the TOML inline-table text yourself if you
      // need one, e.g. --opt 'sandbox_workspace_write={network_access=true}').
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")
        throw new Error(
          `codex connector: launch option "${k}" must be a string, number, or boolean TOML value (got ${
            v === null ? "null" : Array.isArray(v) ? "array" : typeof v
          })`,
        );
      // `mcp_servers` is where this agent's own mesh voice is wired up. The host refuses it too,
      // but refusing HERE is what the operator actually sees: at spawn, instead of an agent that
      // launches and dies. (Dotted keys can't reach this loop — the key grammar rejects `.` — so
      // a top-level inline table is the shape that would otherwise merge against ours.)
      if (k === "mcp_servers" || k.startsWith("mcp_servers."))
        throw new Error(
          `codex connector: launch option "${k}" is reserved — mcp_servers is how this agent reaches ` +
            `the mesh, so it cannot be set through launch options. Drop it from this spawn; there is ` +
            `no supported way to give a codex agent extra MCP servers yet (tool-sharing, ` +
            `connectors.codex.mcpServers, is not implemented).`,
        );
      overrides[k] = v;
      hasOverrides = true;
    }
    if (hasOverrides) env.COTAL_CODEX_CONFIG = JSON.stringify(overrides);

    // Local control endpoint: the manager sends a cooperative {op:"shutdown"} here on a
    // signal-less runtime. Minted here, held in memory by the manager, served by the host.
    const control = controlEndpoint(opts.space, opts.name);
    env.COTAL_CONTROL_SOCKET = control.path;
    env.COTAL_CONTROL_TOKEN = control.token;

    return { command: HOST_COMMAND, args: [HOST_ENTRY], env, control };
  },
};

registry.register(codexConnector);
