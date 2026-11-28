/**
 * The Codex connector: launches a host-mode peer that embeds the Cotal endpoint and drives a
 * `codex app-server` thread over JSON-RPC (see host.ts). A mesh message becomes a real
 * Codex turn — wake an idle thread (`turn/start`) or steer a directed message into one already
 * started by the connector (`turn/steer`). Externally started turns defer delivery until they end.
 * The cotal_* tools are served by the host over a loopback MCP
 * endpoint, so the session is a full lateral peer at parity with the other connectors. Presence
 * is read off the app-server event stream; with a terminal the host attaches the real Codex TUI,
 * and without one it prints an activity feed. Self-registers on import; the manager resolves it
 * by agent type "codex".
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { registry, type CommandCatalog, type CommandListOpts, type Connector, type LaunchModes, type LaunchOpts, type LaunchSpec, type ModelCatalog, type ModelCatalogOpts, type ModelInfo, type ModeInfo } from "@cotal-ai/core";
import { aclEnv, nameEnv, connectorLaunchOptions, controlEndpoint, eventChannel, firstCommandEnv, launchArmsEvents, launchEnv, materialEnv } from "@cotal-ai/connector-core";
import { askAppServer } from "./app-server-once.js";
import type { CodexSkill } from "./app-server.js";
import { codexSkillEntries } from "./skills.js";

/** The bundled host loop (self-contained — core + connector-core inlined, see package.json's
 *  bundle script) run with this same node; from SOURCE (dev), the `.ts` entry through tsx. */
const FROM_BUILD = import.meta.url.includes("/dist/");
const HOST_ENTRY = fileURLToPath(new URL(`./${FROM_BUILD ? "host.js" : "host-main.ts"}`, import.meta.url));
const HOST_COMMAND = FROM_BUILD
  ? process.execPath
  : fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

/** API-key auth and an explicit operator Codex home are the ambient inputs this host supports. */
const CODEX_ENV_KEYS = ["OPENAI_API_KEY", "CODEX_HOME"] as const;

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
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: { reasoningEffort?: string; description?: string }[];
  defaultReasoningEffort?: string;
  serviceTiers?: { id: string; name: string }[];
  defaultServiceTier?: string | null;
}

/** Codex's service tier ids: the fast tier the `fast` mode turns on, and the standard tier it runs
 *  when the mode is off. */
const SERVICE_TIER = { fast: "priority", standard: "default" } as const;

/** The refusal when the fast mode and an operator `service_tier` both pick the tier. */
const TIER_CONFLICT =
  'codex connector: mode "fast" and launch option "service_tier" both set Codex\'s service tier, so ' +
  "one would silently override the other. Use --mode fast=true or fast=false for the Fast or " +
  "standard tier, or --opt service_tier=... alone for another tier, not both.";

/** The file a launch runs: the operator pin, then the path boot resolved, then the bare name. The
 *  pin is read here because discoveryEnv strips every COTAL_* key, which is what keeps a catalog
 *  probe from looking like a managed seat. A later PATH change cannot pick a different file. */
function codexBin(resolved: Readonly<Record<string, string>> | undefined): string {
  return process.env.COTAL_CODEX_BIN?.trim() || resolved?.codex || "codex";
}

/** Query the model catalog over a short-lived `codex app-server` (`model/list` — there is no
 *  `codex models` subcommand). Times out rather than hanging the manager's selector UI. */
async function listCodexModels(opts: ModelCatalogOpts = {}): Promise<ModelCatalog> {
  const bin = codexBin(opts.resolvedBinaries);
  const result = ((await askAppServer({ bin, env: discoveryEnv(), method: "model/list", params: {}, boundMs: 10_000 })) ?? {}) as { data?: CodexModelEntry[] };
  const models = (result.data ?? []).filter((m) => !m.hidden && (m.model || m.id)).map(codexModelInfo);
  return { source: "codex app-server model/list", models };
}

/** One catalog row from a `model/list` entry, with the defaults Codex names. A model that offers the
 *  fast tier gets the `fast` toggle, labeled as Codex names that tier. */
function codexModelInfo(m: CodexModelEntry): ModelInfo {
  const fast = m.serviceTiers?.find((t) => t.id === SERVICE_TIER.fast);
  const modes: ModeInfo[] | undefined = fast && [{ id: "fast", label: fast.name, kind: "toggle", default: m.defaultServiceTier === SERVICE_TIER.fast }];
  return {
    id: m.model ?? m.id!,
    provider: "openai",
    ...(m.displayName ? { name: m.displayName } : {}),
    ...(m.description ? { description: m.description } : {}),
    ...(m.isDefault === true ? { isDefault: true } : {}),
    ...(m.supportedReasoningEfforts?.length
      ? {
          variants: m.supportedReasoningEfforts
            .filter((e) => typeof e.reasoningEffort === "string")
            .map((e) => ({ name: e.reasoningEffort!, ...(e.description ? { options: { description: e.description } } : {}) })),
        }
      : {}),
    ...(typeof m.defaultReasoningEffort === "string" ? { defaultVariant: m.defaultReasoningEffort } : {}),
    ...(modes ? { modes } : {}),
  };
}

/** The service tier a launch's modes select, or undefined when they leave it to Codex. Codex lists
 *  only the `fast` toggle, so any other mode, or a value that is not true or false, is refused. */
function serviceTier(modes: LaunchModes | undefined): string | undefined {
  for (const [id, value] of Object.entries(modes ?? {})) {
    if (id !== "fast") throw new Error(`codex connector: mode ${JSON.stringify(id)} is not one Codex offers; its only mode is "fast"`);
    if (typeof value !== "boolean") throw new Error(`codex connector: mode "fast" is a toggle, so it takes true or false, not ${JSON.stringify(value)}`);
  }
  if (modes?.fast === undefined) return undefined;
  return modes.fast === true ? SERVICE_TIER.fast : SERVICE_TIER.standard;
}

/** The skills a seat started in `cwd` would run, from `skills/list` on a short-lived app-server
 *  there, in the environment a seat's host gets. A seat's Codex runs under a per-agent CODEX_HOME
 *  that loads none of the operator's config, so this one runs under an empty private home too.
 *  Listing needs no login. */
async function codexSkillCatalog(opts: CommandListOpts): Promise<CommandCatalog> {
  const home = mkdtempSync(join(tmpdir(), "cotal-codex-skills-"));
  try {
    const params = { cwds: [opts.cwd], forceReload: true };
    const env = { ...launchEnv({ providerKeys: CODEX_ENV_KEYS, envAllow: opts.envAllow }), CODEX_HOME: home };
    const r = (await askAppServer({ bin: codexBin(opts.resolvedBinaries), env, cwd: opts.cwd, method: "skills/list", params, boundMs: 10_000 })) as { data?: { skills?: CodexSkill[] }[] } | undefined;
    if (!Array.isArray(r?.data)) throw new Error("skills/list answered with no data list");
    return { supported: true, commands: codexSkillEntries(r.data.flatMap((entry) => entry.skills ?? [])) };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

export const codexConnector: Connector = {
  kind: "connector",
  name: "codex",
  setup: { kind: "connector-setup", name: "codex" },
  supportsFreshStart: true,
  requires: ["codex"],
  install: {
    title: "Codex",
    maker: "OpenAI",
    installers: {
      darwin: { script: "https://chatgpt.com/codex/install.sh", shell: "sh", env: { CODEX_NON_INTERACTIVE: "1" }, binDir: "~/.local/bin" },
      linux: { script: "https://chatgpt.com/codex/install.sh", shell: "sh", env: { CODEX_NON_INTERACTIVE: "1" }, binDir: "~/.local/bin" },
      win32: { script: "https://chatgpt.com/codex/install.ps1", env: { CODEX_NON_INTERACTIVE: "1" }, binDir: "%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin" },
    },
    signIn: { status: ["codex", "login", "status"], login: ["codex", "login"] },
  },
  readinessTimeoutMs: 35_000, // leave room for the app-server's 30s listen timeout and teardown
  supportsModelVariant: true, // variant = Codex reasoning effort, as model/list names it for each model
  supportsModes: true, // the fast toggle, rendered as Codex's service_tier
  supportsToolListAnnounce: true, // MCP McpServer.registerTool; SDK fires tools/list_changed
  supportsPrompt: true, // Codex serves a first turn from an initial message — see buildLaunch
  // There is no first-run gate to press through here: the host joins the mesh FIRST (app-server,
  // credentials, tools) and only then hands the terminal to Codex, so the honest thing to tell
  // someone staring at a blank terminal is that the pause is the mesh, and the UI is coming.
  launchHint: "joining the mesh, then Codex opens",
  listModels: listCodexModels,
  commands: { targets: ["skill"], list: codexSkillCatalog },

  // The AG-UI event plane's subject, declared so the manager mints a grant for exactly the
  // channel this seat will publish to.
  //
  // It is core's own derivation and is NOT re-derived here, so the channel the grant covers and
  // the subject the session publishes to come from ONE function. A second derivation would be a
  // second place the subject is decided, and the two would drift the first time either changed.
  // It takes the PRINCIPAL: a display name is not an identity on this mesh, and a name-keyed
  // channel would fuse two principals' streams onto one subject.
  eventChannel,
  // Codex's approval requests and questions open on the agent's prompt desk (prompts.ts).
  prompts: true,
  // askPermissions starts the thread in T3 Code's approval-required mode (codex-config.ts).
  supportsAskPermissions: true,
  // reasoningEvents asks Codex for reasoning summaries on every turn (codex-config.ts).
  supportsReasoningEvents: true,

  supportsLaunchValidation: true,
  buildLaunch(opts: LaunchOpts): LaunchSpec {
    if (opts.continueSession) throw new Error("codex connector does not support exact-session continuation");
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

    // The launch's artifact list (core launch-artifacts): the launcher removes every entry once the
    // child has exited.
    const artifacts: string[] = [];
    const env: Record<string, string> = {
      ...launchEnv({ providerKeys: CODEX_ENV_KEYS, envAllow: opts.envAllow }),
      ...aclEnv(opts),
      COTAL_SPACE: opts.space,
      ...nameEnv(opts),
    };
    // The machine-wide COTAL_CODEX_BIN is an operator pin and already rides launchEnv. The boot
    // inventory is a fallback for the common no-override case, carried separately so a managed spawn
    // never silently replaces the binary the operator chose.
    if (opts.resolvedBinaries?.codex) env.COTAL_CODEX_RESOLVED_BIN = opts.resolvedBinaries.codex;
    if (opts.role) env.COTAL_ROLE = opts.role;
    if (opts.id) env.COTAL_ID = opts.id;
    if (opts.lifecycleUid) env.COTAL_LIFECYCLE_UID = opts.lifecycleUid;
    if (opts.backfillFloor !== undefined) env.COTAL_BACKFILL_FLOOR = String(opts.backfillFloor);
    if (opts.acceptedToken) env.COTAL_ACCEPTED_TOKEN = opts.acceptedToken;
    // The auto-submitted first turn. A prompt with no text in it cannot be submitted, so refuse the
    // launch rather than start a seat that quietly ignores what the operator passed.
    if (opts.prompt !== undefined) {
      const prompt = opts.prompt.trim();
      if (!prompt)
        throw new Error("codex connector: an initial prompt was given but it is empty, there is no first turn to submit");
      env.COTAL_CODEX_PROMPT = prompt;
    }
    // The host picks TUI vs headless from its own stdout, and COTAL_CODEX_TUI overrides that. The
    // child's env is an ALLOW-LIST, so without forwarding it by name the override would silently
    // do nothing.
    //
    // It is read from whichever process builds the launch, and that is NOT always the operator's
    // shell: a detached spawn is built inside the MANAGER, so the manager's environment is what
    // decides there (one setting for every codex agent it supervises), while a foreground spawn
    // reads the shell that ran it. Passing it through the spawn request instead would make it a
    // per-agent launch option, which is a bigger surface than a display toggle earns; the split is
    // documented in docs/connect-codex.mdx rather than half-wired.
    const tuiPref = process.env.COTAL_CODEX_TUI?.trim();
    if (tuiPref) env.COTAL_CODEX_TUI = tuiPref;

    // Where the host roots the per-agent CODEX_HOME (`.cotal/codex/<name>`): the manager's
    // workspace, or the launch dir for a standalone spawn — never the per-agent cwd, which can
    // point at any repo (parity with the OpenCode connector's data root).
    env.COTAL_CODEX_HOME = opts.workspaceRoot ?? process.cwd();

    // The AG-UI event plane. Supporting connectors arm by default; `events: false` is the explicit
    // opt-out. `COTAL_EVENTS` arms the emitter, and arming is not authorization: a
    // publish grant on a channel is not a request to publish to it, so an agent file that can
    // write `allowPublish` cannot turn on a stream of another seat's tool inputs and outputs by
    // doing so.
    //
    // `COTAL_WORKSPACE_ROOT` rides with it because the write-ahead log has to live somewhere a
    // LATER start will look, and there is no safe default: a log written under the launch cwd is
    // invisible to the next start, which then reads an already-published thread as virgin and
    // republishes sequences the stream has already seen.
    //
    // Deliberately NOT folded into `COTAL_CODEX_HOME` above, which falls back to the process cwd.
    // That fallback is safe for an isolated codex home, which only ever has to be found by the
    // process that wrote it. It is not safe for the log, which exists to be found by a process
    // that has not started yet.
    if (launchArmsEvents(opts)) {
      env.COTAL_EVENTS = "1";
      if (!opts.workspaceRoot)
        throw new Error(
          "codex connector: events were requested but the launch carries no workspaceRoot, so the " +
            "event write-ahead log has nowhere to live that a later start would look. Refusing rather " +
            "than defaulting to the working directory.",
        );
      env.COTAL_WORKSPACE_ROOT = opts.workspaceRoot;
    }

    // An agent file carries identity (read in-session via COTAL_AGENT_FILE) plus persona (the
    // host injects it as thread developerInstructions).
    if (opts.configPath) env.COTAL_AGENT_FILE = resolve(opts.configPath);
    if (opts.model) env.COTAL_MODEL = opts.model;
    if (opts.variant) env.COTAL_VARIANT = opts.variant; // reasoning effort, checked by the launcher against the catalog
    const tier = serviceTier(opts.modes);
    if (tier) env.COTAL_CODEX_SERVICE_TIER = tier;
    // Opaque connector options → codex `-c key=value` config overrides on the app-server child,
    // RAW passthrough (the spawn capability is the trust boundary, not the key set — see
    // connectorLaunchOptions). The key-shape guard admits top-level config keys only (no dotted
    // paths). The host appends its autonomy defaults (approval_policy, sandbox_mode) and the
    // model and effort selectors ONLY for keys the operator didn't set, so an explicit --opt wins.
    // The service tier is the exception: the fast mode and an operator service_tier both choose
    // it, and either winning would run a tier the other asked against, so the mix is refused.
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
    if (tier && "service_tier" in overrides) throw new Error(TIER_CONFLICT);
    if (hasOverrides) env.COTAL_CODEX_CONFIG = JSON.stringify(overrides);

    // Local control endpoint: the manager sends a cooperative {op:"shutdown"} here on a
    // signal-less runtime. Minted here, after every refusal, because minting makes its socket
    // directory; held in memory by the manager, served by the host. The key goes into the material.
    if (opts.validateOnly) return { command: "", args: [] };
    const control = controlEndpoint(opts.space, opts.name, artifacts);
    env.COTAL_CONTROL_SOCKET = control.path;

    // Creds, broker URL and the control token ride a 0600 file; only its path is exported, and the
    // host drops even that once it has read it, so a shell this seat runs inherits neither. Written
    // after every refusal above, and its directory is a launch artifact the launcher removes once the
    // child has exited (core launch-artifacts).
    Object.assign(env, materialEnv({ creds: opts.creds, servers: opts.servers, control, eventsRequired: opts.eventsRequired, eventPayloads: opts.eventPayloads, askPermissions: opts.askPermissions, reasoningEvents: opts.reasoningEvents, userAuth: opts.userAuth }, artifacts));
    Object.assign(env, firstCommandEnv(opts.firstCommand, artifacts));

    return { command: HOST_COMMAND, args: [HOST_ENTRY], env, control, ...(artifacts.length > 0 ? { artifacts } : {}) };
  },
};

registry.register(codexConnector);
